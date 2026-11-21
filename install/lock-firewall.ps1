# Lock sshd down to the Tailscale interface only.
# Must run elevated. Pure ASCII only.
#
# WHY this exists:
#   There are TWO stock inbound rules that open TCP/22, and BOTH must go:
#
#     1. "OpenSSH SSH Server Preview (sshd)"  -- shipped by the OpenSSH MSI
#        Profile=Private, RemoteAddress=Any, InterfaceAlias=Any
#     2. "OpenSSH SSH Server (sshd)"          -- built into Windows itself,
#        rule name "OpenSSH-Server-In-TCP", Profile=Any, RemoteAddress=Any
#
#   The first version of this script only looked at the MSI rule and MISSED
#   the built-in one, so an audit still found port 22 wide open. Rule 2 is
#   the easier one to overlook precisely because it is a Windows default
#   rather than something the installer created.
#
#   The office WLAN is classified as Private too, so either rule lets EVERY
#   host on the company LAN reach port 22. Not acceptable on a company asset.
#
# The fix is defence in depth on the network layer:
#   1. disable the stock wide-open rules (by name AND by display-name match)
#   2. add a rule scoped to the Tailscale interface + 100.64.0.0/10 only
#   3. keep sshd_config's PubkeyAuthentication-only policy (already applied)
#   4. FAIL LOUDLY if any wide rule survives, instead of printing a cheerful
#      "DONE" over a still-open port

$ErrorActionPreference = 'Continue'
$out = "$env:TEMP\fleet-fw-lock.txt"
function Say($m) { Add-Content -Path $out -Value $m -Encoding UTF8 }
Set-Content -Path $out -Value "=== firewall lockdown $(Get-Date -Format o) ===" -Encoding UTF8

# ---- 1. find and disable the stock OpenSSH rule(s) ----
# Match by display name AND by the well-known built-in rule name, so this
# works even if a future Windows build renames the display string.
$stockNames = @('OpenSSH-Server-In-TCP')
$stock = @()
foreach ($n in $stockNames) {
  $r = Get-NetFirewallRule -Name $n -ErrorAction SilentlyContinue
  if ($r) { $stock += $r }
}
$byDisplay = Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object {
  $_.DisplayName -match 'OpenSSH' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow'
}
foreach ($r in @($byDisplay)) {
  if (-not ($stock | Where-Object { $_.Name -eq $r.Name })) { $stock += $r }
}
# de-duplicate
$stock = @($stock | Sort-Object Name -Unique)

Say "stock inbound OpenSSH allow rules found: $($stock.Count)"
foreach ($r in $stock) {
  Say "  disabling: $($r.DisplayName) [name=$($r.Name) profile=$($r.Profile)]"
  try {
    Disable-NetFirewallRule -Name $r.Name -ErrorAction Stop
    Say "    disabled"
  } catch { Say "    FAILED: $($_.Exception.Message)" }
}

# ---- 2. remove any previous fleet rules ----
Get-NetFirewallRule -DisplayName 'dsh-fleet-sshd*' -ErrorAction SilentlyContinue | ForEach-Object {
  Say "removing old rule: $($_.DisplayName)"
  Remove-NetFirewallRule -Name $_.Name -ErrorAction SilentlyContinue
}

# ---- 3. add the narrow rule ----
$tsIf = Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceDescription -match 'Tailscale' }
if (-not $tsIf) {
  Say "NO_TAILSCALE_ADAPTER -- refusing to add a wide rule. sshd stays blocked."
  Say "=== DONE ==="
  exit 1
}

Say "Tailscale adapter: $($tsIf.Name) (status=$($tsIf.Status))"

try {
  New-NetFirewallRule -DisplayName 'dsh-fleet-sshd-tailscale' `
    -Description 'Allow SSH only from the Tailscale network' `
    -Direction Inbound -Action Allow -Protocol TCP -LocalPort 22 `
    -InterfaceAlias $tsIf.Name `
    -RemoteAddress '100.64.0.0/10' `
    -Profile Any `
    -ErrorAction Stop | Out-Null
  Say "added rule: allow 22 on interface '$($tsIf.Name)' from 100.64.0.0/10"
} catch {
  Say "ADD_RULE_FAILED: $($_.Exception.Message)"
}

# ---- 4. verify: no ENABLED inbound rule may allow 22 from a wide scope ----
#
# NOTE on performance: do NOT loop over every firewall rule calling
# Get-NetFirewallPortFilter / Get-NetFirewallAddressFilter per rule. That took
# over 120 seconds on this machine and was indistinguishable from a hang.
# Instead we look only at the few rules we care about, by name.
Say ""
Say "--- verification: inbound rules on 22 ---"

$checkNames = @($stock | ForEach-Object { $_.Name }) + @('dsh-fleet-sshd-tailscale')
$problems = 0

foreach ($n in ($checkNames | Sort-Object -Unique)) {
  $r = Get-NetFirewallRule -Name $n -ErrorAction SilentlyContinue
  if (-not $r) { continue }

  $af = $r | Get-NetFirewallAddressFilter -ErrorAction SilentlyContinue
  $inf = $r | Get-NetFirewallInterfaceFilter -ErrorAction SilentlyContinue
  $remote = ($af.RemoteAddress -join ',')
  $iface = ($inf.InterfaceAlias -join ',')
  $state = if ($r.Enabled -eq 'True') { 'ENABLED ' } else { 'disabled' }
  Say "  $state  $($r.DisplayName)"
  Say "           name=$($r.Name)"
  Say "           remote=$remote iface=$(if($iface){$iface}else{'(any)'}) profile=$($r.Profile)"

  if ($r.Enabled -eq 'True') {
    $tsScoped = ($iface -match 'Tailscale') -and ($remote -match '100\.64\.')
    if (-not $tsScoped) {
      Say "           -> PROBLEM: enabled with a wide scope"
      $script:problems++
    }
  }
}

# Also catch any OTHER enabled allow rule that opens 22 from anywhere.
# Bounded scan: only rules whose port filter mentions 22. We query the port
# filter collection once (one WMI call) instead of once per rule.
Say ""
Say "--- scan: any other enabled allow rule covering 22 ---"
$wideOthers = @()
$allPf = Get-NetFirewallPortFilter -ErrorAction SilentlyContinue
$pf22 = @($allPf | Where-Object { @($_.LocalPort) -contains '22' })
Say "  port filters mentioning 22: $($pf22.Count)"
foreach ($pf in $pf22) {
  $r = Get-NetFirewallRule -Name $pf.InstanceID -ErrorAction SilentlyContinue
  if (-not $r) { continue }
  if ($r.Direction -ne 'Inbound' -or $r.Action -ne 'Allow' -or $r.Enabled -ne 'True') { continue }

  # Skip our own rule. Match on DisplayName, not Name: our rule's Name is a
  # generated GUID while its DisplayName is 'dsh-fleet-sshd-tailscale'.
  # Comparing against Name silently failed to skip it and the script then
  # reported its OWN rule as a problem -- a self-inflicted false FAIL.
  if ($r.DisplayName -match '^dsh-fleet-sshd') { continue }

  $af = $r | Get-NetFirewallAddressFilter -ErrorAction SilentlyContinue
  $inf = $r | Get-NetFirewallInterfaceFilter -ErrorAction SilentlyContinue
  $remote = ($af.RemoteAddress -join ',')
  $iface = ($inf.InterfaceAlias -join ',')

  # Loopback-only allow rules are harmless
  if ($remote -match '^(127\.0\.0\.1|::1)$') { continue }
  # A Tailscale-scoped rule is exactly what we want -- not a problem.
  if (($iface -match 'Tailscale') -and ($remote -match '100\.64\.')) { continue }

  Say "  OTHER ENABLED ALLOW: $($r.DisplayName) remote=$remote iface=$(if($iface){$iface}else{'(any)'}) profile=$($r.Profile)"
  $wideOthers += $r.DisplayName
}

if ($wideOthers.Count -gt 0) { $problems += $wideOthers.Count }

Say ""
Say "--- disabled rules mentioning OpenSSH ---"
Get-NetFirewallRule -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -match 'OpenSSH' -and $_.Enabled -eq 'False' } |
  ForEach-Object { Say "  DISABLED: $($_.DisplayName)" }

Say ""
if ($problems -eq 0) {
  Say "VERDICT: OK -- only the Tailscale-scoped rule allows 22."
  Say "=== DONE ==="
  exit 0
} else {
  Say "VERDICT: FAIL -- $problems rule(s) still allow 22 from a wide scope."
  Say "=== DONE ==="
  exit 1
}
