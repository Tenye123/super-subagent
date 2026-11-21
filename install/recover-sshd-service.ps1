# Re-register the sshd service after it disappeared.
# Must run elevated. Pure ASCII only.
#
# WHAT HAPPENED (evidence from the System event log):
#   The System log shows "OpenSSH SSH Server" terminating unexpectedly
#   2500+ times within the same second (event 7031), which happened while
#   sshd_config was broken -- sshd would start, fail to parse, and exit, and
#   the service recovery policy restarted it in a tight loop.
#   Afterwards the "sshd" service no longer existed at all, while
#   C:\Program Files\OpenSSH\sshd.exe and all configs were still present.
#
#   Practical lesson: a broken config plus an aggressive restart policy can
#   leave you with no service at all, not just a stopped one. So after any
#   config change we must (a) run sshd -t first, and (b) verify the service
#   still exists AND is bound to the expected address.
#
# This script registers the service using the official install-sshd.ps1 that
# ships with the MSI, falling back to sc.exe create.

$ErrorActionPreference = 'Continue'
$out = "$env:TEMP\fleet-sshd-recover.txt"
function Say($m) { Add-Content -Path $out -Value $m -Encoding UTF8 }
Set-Content -Path $out -Value "=== sshd service recovery $(Get-Date -Format o) ===" -Encoding UTF8

$sshdExe = 'C:\Program Files\OpenSSH\sshd.exe'
$cfg = 'C:\ProgramData\ssh\sshd_config'

Say "sshd.exe exists: $(Test-Path $sshdExe)"
if (-not (Test-Path $sshdExe)) {
  Say "FATAL: sshd.exe missing -- MSI must be reinstalled"
  Say "=== DONE ==="
  exit 1
}

# ---- 0. stop the restart storm before doing anything ----
$existing = Get-Service sshd -ErrorAction SilentlyContinue
if ($existing) {
  Say "service already exists: $($existing.Status)"
} else {
  Say "service is ABSENT -- will register it"
}

# ---- 1. config must be valid before we create a service that autostarts ----
$t = (& $sshdExe -t -f $cfg 2>&1 | Out-String).Trim()
Say "sshd -t: $(if($LASTEXITCODE -eq 0){'OK'}else{"FAILED -> $t"})"
if ($LASTEXITCODE -ne 0) {
  Say "REFUSING to register a service with an invalid config (that is what caused the 2500 restarts)"
  Say "=== DONE ==="
  exit 1
}

# ---- 2. register ----
if (-not $existing) {
  $installer = 'C:\Program Files\OpenSSH\install-sshd.ps1'
  if (Test-Path $installer) {
    Say "running $installer"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer 2>&1 |
      ForEach-Object { Say "  $_" }
  } else {
    Say "install-sshd.ps1 not found; using sc create"
    & sc.exe create sshd binPath= "`"$sshdExe`"" start= auto DisplayName= "OpenSSH SSH Server" 2>&1 |
      ForEach-Object { Say "  $_" }
    & sc.exe description sshd "OpenSSH SSH Server" 2>&1 | Out-Null
  }
}

Start-Sleep -Seconds 2
$svc = Get-Service sshd -ErrorAction SilentlyContinue
Say "service after registration: $(if($svc){$svc.Status}else{'STILL MISSING'})"
if (-not $svc) {
  Say "FATAL: could not register the service"
  Say "=== DONE ==="
  exit 1
}

# ---- 3. tame the recovery policy ----
# The default was "restart immediately, forever". With a bad config that
# produced 2500 restarts in one second and eventually no service at all.
# Restart after 60s, and give up after 3 attempts per day instead.
Say "--- configuring recovery policy ---"
& sc.exe failure sshd reset= 86400 actions= restart/60000/restart/60000/restart/60000 2>&1 |
  ForEach-Object { Say "  $_" }

# ---- 4. make it depend on Tailscale, since it binds to the Tailscale IP ----
& sc.exe config sshd depend= Tailscale 2>&1 | ForEach-Object { Say "  $_" }

Set-Service sshd -StartupType Automatic -ErrorAction SilentlyContinue

# ---- 5. start ----
try {
  Start-Service sshd -ErrorAction Stop
  Start-Sleep -Seconds 3
  Say "started: $((Get-Service sshd).Status)"
} catch {
  Say "START_FAILED: $($_.Exception.Message)"
}

# ---- 6. verify it listens where we expect ----
Say ""
Say "--- listen sockets ---"
$socks = Get-NetTCPConnection -LocalPort 22 -State Listen -ErrorAction SilentlyContinue
if ($socks) {
  foreach ($s in $socks) { Say "  $($s.LocalAddress):$($s.LocalPort)" }
} else {
  Say "  NOT LISTENING"
}

$tsExe = 'C:\Program Files\Tailscale\tailscale.exe'
$tsIp = $null
if (Test-Path $tsExe) {
  $cand = (& $tsExe ip -4 2>&1 | Out-String).Trim().Split("`n")[0].Trim()
  if ($cand -match '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$') { $tsIp = $cand }
}
Say "tailscale ip: $(if($tsIp){$tsIp}else{'(none)'})"

$boundToTs = $false
if ($tsIp) { foreach ($s in $socks) { if ($s.LocalAddress -eq $tsIp) { $boundToTs = $true } } }
Say ""
Say "RESULT: service=$(if(Get-Service sshd -ErrorAction SilentlyContinue){'present'}else{'MISSING'}) listening=$([bool]$socks) boundToTailscale=$boundToTs"

# ---- 7. confirm the forwarding policy is what we intend ----
Say ""
Say "--- forwarding policy ---"
$eff = (& $sshdExe -T 2>&1 | Out-String)
foreach ($k in @('allowtcpforwarding','permitopen','gatewayports','allowagentforwarding','permittunnel')) {
  $m = [regex]::Match($eff, "(?m)^$k\s+(.+)$")
  if ($m.Success) { Say "  $k = $($m.Groups[1].Value.Trim())" }
}
Say "=== DONE ==="
