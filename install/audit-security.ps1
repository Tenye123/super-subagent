# Security audit: verify the machine's actual exposure, not just config files.
#
# Design principle learned the hard way this session:
#   "the config says X" and "the network behaves like X" are different claims.
#   A firewall rule looked right in the GUI while the port stayed reachable,
#   and a port-forward looked blocked while it was never actually tested with data.
# Every check below therefore tests BEHAVIOUR where possible.
#
# IMPORTANT about loopback: connecting to one of this machine's own LAN IPs
# from this machine does NOT traverse the firewall (Windows exempts loopback).
# Such a test always says "reachable" and proves nothing. Real external
# testing here goes through WSL, which is a separate network namespace.

$ErrorActionPreference = 'Continue'
$out = "$env:TEMP\fleet-security-audit.txt"
function Say($m) { Add-Content -Path $out -Value $m -Encoding UTF8 }
Set-Content -Path $out -Value "=== security audit $(Get-Date -Format o) ===" -Encoding UTF8

$fail = 0
$warn = 0
function Pass($m) { Say "  [PASS] $m" }
function Warn($m) { Say "  [WARN] $m"; $script:warn++ }
function Fail($m) { Say "  [FAIL] $m"; $script:fail++ }

function Section($m) { Say ""; Say "== $m ==" }

# ---------------------------------------------------------------- 1. sshd listening scope
Section "sshd listen sockets"
$listen = Get-NetTCPConnection -LocalPort 22 -State Listen -ErrorAction SilentlyContinue
foreach ($l in $listen) { Say "  listening on $($l.LocalAddress):$($l.LocalPort)" }
if ($listen) { Pass "sshd is listening" } else { Fail "sshd is NOT listening" }

# This is the STRONGEST local guarantee we have, so assert it directly.
# The firewall could not be validated from this machine (see the reachability
# section below), but the bind address is an objective fact: if sshd does not
# listen on a LAN address, no LAN packet can reach it no matter what the
# firewall says.
$tsIp = $null
$tsExeLocal = 'C:\Program Files\Tailscale\tailscale.exe'
if (Test-Path $tsExeLocal) {
  try {
    $cand = (& $tsExeLocal ip -4 2>&1 | Out-String).Trim().Split("`n")[0].Trim()
    if ($cand -match '^\d+\.\d+\.\d+\.\d+$') { $tsIp = $cand }
  } catch { }
}

$badBinds = @()
foreach ($l in $listen) {
  $a = $l.LocalAddress
  $ok = ($a -eq '127.0.0.1') -or ($a -eq '::1') -or ($tsIp -and $a -eq $tsIp)
  if (-not $ok) { $badBinds += $a }
}
if ($badBinds.Count -eq 0) {
  Pass "sshd listens ONLY on loopback/Tailscale -- LAN hosts cannot reach it"
} else {
  Fail "sshd listens on non-Tailscale address(es): $($badBinds -join ', ')"
}

# ---------------------------------------------------------------- 2. sshd_config policy
Section "sshd_config policy"

# Do NOT use `sshd -T` here.
#   `sshd -T` needs the host keys to be loadable and, when it cannot find them,
#   prints "no hostkeys available -- exiting" and returns NOTHING. Every
#   assertion then reads "(not set)" and reports a false FAIL -- which is
#   exactly what happened on the first run of this audit (7 bogus failures).
#   Reading the config text is also more honest about what we mean: we are
#   asserting on the POLICY DIRECTIVES, not on sshd's internal rendering.
#
# Only the text BEFORE the first Match block counts as global policy: the
# stock Windows config ends with "Match Group administrators", and directives
# after it do not apply globally.
$sshdCfgPath = 'C:\ProgramData\ssh\sshd_config'
$cfgRaw = Get-Content $sshdCfgPath -Raw -ErrorAction SilentlyContinue
$cfgMatchIdx = [regex]::Match($cfgRaw, '(?m)^[ \t]*Match[ \t]').Index
$cfgHead = if ($cfgMatchIdx -ge 0) { $cfgRaw.Substring(0, $cfgMatchIdx) } else { $cfgRaw }

function ExpectCfg {
  param([string]$Key, [string]$Expected, [string]$Why)
  # Take the LAST occurrence in the head: OpenSSH uses the first value it sees
  # for most keywords, but our rewriter always leaves exactly one live line,
  # so last == only. Using the live (non-commented) match avoids being fooled
  # by the commented examples shipped in the default config.
  $rx = "(?m)^[ \t]*$([regex]::Escape($Key))[ \t]+(.+?)[ \t]*$"
  $ms = [regex]::Matches($cfgHead, $rx)
  $actual = if ($ms.Count -gt 0) { $ms[$ms.Count - 1].Groups[1].Value.Trim() } else { '(not set)' }
  if ($actual -eq $Expected) { Pass "$Key = $actual" }
  else { Fail "$Key = $actual (expected $Expected) -- $Why" }
}

ExpectCfg 'PasswordAuthentication' 'no'  'password login must be off'
ExpectCfg 'PermitEmptyPasswords'   'no'  'empty passwords must be off'
ExpectCfg 'PubkeyAuthentication'   'yes' 'key login must be on'
# 'local' (not 'no') is required for the task-registry tunnel to work.
# It still forbids REMOTE forwarding, so this machine cannot be used as a pivot.
ExpectCfg 'AllowTcpForwarding'     'local' 'only ssh -L; remote forwarding must stay off'
ExpectCfg 'AllowAgentForwarding'   'no'  'no agent forwarding'
ExpectCfg 'PermitTunnel'           'no'  'no VPN tunnelling'
ExpectCfg 'X11Forwarding'          'no'  'no X11'

# ---------------------------------------------------------------- 3. firewall
Section "firewall rules for port 22"
$openWide = @()
Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object {
  $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow'
} | ForEach-Object {
  $pf = $_ | Get-NetFirewallPortFilter
  if ($pf.LocalPort -eq '22') {
    $af = $_ | Get-NetFirewallAddressFilter
    $if = $_ | Get-NetFirewallInterfaceFilter
    $remote = ($af.RemoteAddress -join ',')
    $iface = ($if.InterfaceAlias -join ',')
    Say "  rule: $($_.DisplayName)"
    Say "    remote=$remote iface=$iface profile=$($_.Profile)"
    # A rule is "wide" if it neither limits the interface nor the remote range
    $tsScoped = ($iface -match 'Tailscale') -or ($remote -match '100\.64\.')
    if (-not $tsScoped) { $openWide += $_.DisplayName }
  }
}
if ($openWide.Count -eq 0) { Pass "no unrestricted inbound rule on port 22" }
else { Fail "unrestricted inbound rule(s) on 22: $($openWide -join ', ')" }

$stock = Get-NetFirewallRule -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -match 'OpenSSH' -and $_.Direction -eq 'Inbound' -and $_.Enabled -eq 'True' }
if ($stock) { Fail "stock OpenSSH rule still enabled: $(($stock.DisplayName) -join ', ')" }
else { Pass "stock OpenSSH inbound rule is disabled" }

# ---------------------------------------------------------------- 4. external reachability
Section "reachability from an external source"
# Documented limitation, established experimentally this session:
#   - Connecting to one of our own LAN IPs is loopback. Windows exempts
#     loopback from the firewall, so it always succeeds and proves nothing.
#   - WSL arrives over the Hyper-V vSwitch and BYPASSES inbound firewall
#     rules: a listener with NO allow rule was still reachable from WSL.
# Therefore neither method can validate the firewall. Instead of printing a
# conclusion we cannot support, say so plainly and rely on the bind-address
# assertion above (which is objective) plus a real second machine.
Warn "firewall reachability CANNOT be verified from this machine (loopback is exempt; WSL bypasses inbound rules)"
Say "     -> verified substitute: the bind-address check above, plus testing from another machine"
Say "     -> to prove it externally, from laptop B run:"
Say "        Test-NetConnection <this-machine-LAN-IP> -Port 22   (expect: False/TcpTestFailed)"
Say "        Test-NetConnection $tsIp -Port 22                     (expect: True)"

# Still worth checking: the rule exists and is interface-scoped, as defence in depth.
Section "firewall rule as defence in depth"
$fw = Get-NetFirewallRule -DisplayName 'dsh-fleet-sshd-tailscale' -ErrorAction SilentlyContinue
if ($fw -and $fw.Enabled -eq 'True') {
  $if = ($fw | Get-NetFirewallInterfaceFilter).InterfaceAlias -join ','
  $ra = ($fw | Get-NetFirewallAddressFilter).RemoteAddress -join ','
  Say "  rule: enabled, iface=$if, remote=$ra"
  if ($if -match 'Tailscale' -and $ra -match '100\.64\.') {
    Pass "firewall rule scoped to the Tailscale interface and CGNAT range"
  } else {
    Warn "firewall rule is broader than expected"
  }
} elseif ($fw) {
  Warn "dsh-fleet-sshd-tailscale exists but is disabled"
} else {
  Warn "dsh-fleet-sshd-tailscale rule missing (bind address still protects us)"
}

# ---------------------------------------------------------------- 5. authorized_keys hygiene
Section "authorized_keys state"
$adminKeys = 'C:\ProgramData\ssh\administrators_authorized_keys'
$userKeys = Join-Path $env:USERPROFILE '.ssh\authorized_keys'
foreach ($k in @($adminKeys, $userKeys)) {
  if (Test-Path $k) {
    $lines = (Get-Content $k | Where-Object { $_.Trim() }).Count
    Say "  $k : $lines line(s)"
    if ($lines -gt 0) { Warn "authorized_keys is not empty -- confirm each key is intended" }
    else { Pass "$k is empty" }
  } else {
    Pass "$k absent"
  }
}

# ACL must not let non-admins modify the admin key file
if (Test-Path $adminKeys) {
  $acl = (& icacls $adminKeys 2>&1 | Out-String)
  Say "  ACL:"; $acl.Trim().Split("`n") | ForEach-Object { Say "    $_" }
  if ($acl -match 'Everyone|Users:') { Fail "administrators_authorized_keys is readable by non-admins" }
  else { Pass "administrators_authorized_keys ACL looks tight" }
}

# ---------------------------------------------------------------- 6. Tailscale exposure
Section "Tailscale exposure"
$tsExe = 'C:\Program Files\Tailscale\tailscale.exe'
if (Test-Path $tsExe) {
  $st = (& $tsExe status --json 2>&1 | Out-String)
  try {
    $j = $st | ConvertFrom-Json
    Say "  backend: $($j.BackendState)"
    Say "  self: $($j.Self.DNSName) $($j.Self.TailscaleIPs -join ',')"
    if ($j.BackendState -eq 'Running') { Pass "tailscale is up" } else { Warn "tailscale state: $($j.BackendState)" }
  } catch { Warn "could not parse tailscale status" }

  # These two turn the machine into a network gateway -- never acceptable.
  $prefs = (& $tsExe debug prefs 2>&1 | Out-String)
  if ($prefs -match '"AdvertiseRoutes":\s*\[[^\]]+\]') { Fail "AdvertiseRoutes is non-empty (exposes subnets)" }
  else { Pass "AdvertiseRoutes is empty" }
  if ($prefs -match '"AdvertiseExitNode":\s*true') { Fail "AdvertiseExitNode is ON (turns this box into an exit node)" }
  else { Pass "AdvertiseExitNode is off" }
} else {
  Warn "tailscale not installed"
}

# ---------------------------------------------------------------- 7. summary
Say ""
Say "=== SUMMARY ==="
Say "  FAIL: $fail"
Say "  WARN: $warn"
if ($fail -eq 0) { Say "  verdict: no blocking problems found" }
else { Say "  verdict: $fail problem(s) need fixing" }
Say "=== DONE ==="
