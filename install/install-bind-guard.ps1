# Guarantee sshd ends up bound to the Tailscale address after every boot.
#
# THE PROBLEM this solves (found by test-restart-resilience.ps1):
#   sshd_config now contains "ListenAddress 100.x.x.x". If sshd starts before
#   Tailscale has ASSIGNED that address, the bind silently fails: the service
#   reports "Running" and listens on 127.0.0.1 only. Remote access is then
#   dead while everything LOOKS healthy. A service dependency orders the two
#   services but does not wait for the address to appear.
#
# THE FIX: a boot-time scheduled task (SYSTEM) that waits for the Tailscale
# address and restarts sshd if it is not bound. Idempotent: if sshd is already
# correctly bound, it does nothing.

$ErrorActionPreference = 'Continue'
$out = "$env:TEMP\fleet-guard.txt"
function Say($m) { Add-Content -Path $out -Value $m -Encoding UTF8 }
Set-Content -Path $out -Value "=== sshd bind guard install $(Get-Date -Format o) ===" -Encoding UTF8

$guardDir = 'C:\ProgramData\ssh'
$guard = Join-Path $guardDir 'fleet-ensure-bind.ps1'

# ---- 1. write the guard script (pure ASCII, runs as SYSTEM) ----
$guardBody = @'
# Ensures sshd is listening on the Tailscale address.
# Run at boot / after network changes. Safe to run repeatedly.
$ErrorActionPreference = 'Continue'
$log = 'C:\ProgramData\ssh\fleet-bind-guard.log'
function Log($m) {
  $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
  Add-Content -Path $log -Value $line -Encoding UTF8
}

$tsExe = 'C:\Program Files\Tailscale\tailscale.exe'

# wait up to 5 minutes for tailscale to hand out an address
$tsIp = $null
for ($i = 0; $i -lt 60; $i++) {
  if (Test-Path $tsExe) {
    try {
      $cand = (& $tsExe ip -4 2>$null | Out-String).Trim().Split("`n")[0].Trim()
      if ($cand -match '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$') { $tsIp = $cand; break }
    } catch { }
  }
  Start-Sleep -Seconds 5
}

if (-not $tsIp) {
  Log "NO_TAILSCALE_IP after 5min -- leaving sshd as-is"
  exit 0
}

$socks = Get-NetTCPConnection -LocalPort 22 -State Listen -ErrorAction SilentlyContinue
$boundToTs = $false
foreach ($s in $socks) { if ($s.LocalAddress -eq $tsIp) { $boundToTs = $true } }

if ($boundToTs) {
  Log "OK already bound to $tsIp"
  exit 0
}

Log "NOT bound to $tsIp (current: $(($socks | ForEach-Object { $_.LocalAddress }) -join ',')) -- restarting sshd"
try {
  Restart-Service sshd -Force -ErrorAction Stop
  Start-Sleep -Seconds 4
  $after = Get-NetTCPConnection -LocalPort 22 -State Listen -ErrorAction SilentlyContinue
  $ok = $false
  foreach ($s in $after) { if ($s.LocalAddress -eq $tsIp) { $ok = $true } }
  Log "after restart bound=$(($after | ForEach-Object { $_.LocalAddress }) -join ',') success=$ok"
} catch {
  Log "RESTART_FAILED: $($_.Exception.Message)"
}
'@

Set-Content -Path $guard -Value $guardBody -Encoding ASCII
Say "guard script written: $guard"

# verify it parses before registering anything
$errs = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile($guard, [ref]$null, [ref]$errs)
if ($errs -and $errs.Count -gt 0) {
  Say "GUARD_SCRIPT_SYNTAX_ERROR:"
  $errs | ForEach-Object { Say "  line $($_.Extent.StartLineNumber): $($_.Message)" }
  Say "=== DONE (not registering a broken task) ==="
  exit 1
}
Say "guard script parses OK"

# ---- 2. register the scheduled task ----
$taskName = 'dsh-fleet-ensure-sshd-bind'

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$guard`""
$triggerBoot = New-ScheduledTaskTrigger -AtStartup
$triggerLogon = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

try {
  Register-ScheduledTask -TaskName $taskName -Action $action `
    -Trigger @($triggerBoot, $triggerLogon) -Principal $principal -Settings $settings `
    -Description 'Ensure sshd is bound to the Tailscale address after boot' `
    -ErrorAction Stop | Out-Null
  Say "scheduled task registered: $taskName"
} catch {
  Say "TASK_REGISTER_FAILED: $($_.Exception.Message)"
}

$t = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($t) {
  Say "task state: $($t.State)"
  Say "  triggers: $(($t.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ', ')"
  Say "  runs as: $($t.Principal.UserId) / $($t.Principal.RunLevel)"
}

# ---- 3. run it once now to prove it works ----
Say ""
Say "--- running the guard now to verify it behaves ---"
$before = (Get-NetTCPConnection -LocalPort 22 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.LocalAddress }) -join ','
Say "listen before: $before"
Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Start-Sleep -Seconds 12
$after = (Get-NetTCPConnection -LocalPort 22 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.LocalAddress }) -join ','
Say "listen after:  $after"
Say "service: $((Get-Service sshd).Status)"

if (Test-Path 'C:\ProgramData\ssh\fleet-bind-guard.log') {
  Say "--- guard log ---"
  Get-Content 'C:\ProgramData\ssh\fleet-bind-guard.log' -Encoding UTF8 -ErrorAction SilentlyContinue |
    Select-Object -Last 10 | ForEach-Object { Say "  $_" }
} else {
  Say "(no guard log yet)"
}

Say "=== DONE ==="
