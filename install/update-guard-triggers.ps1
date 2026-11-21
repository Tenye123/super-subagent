# Add extra triggers so the guard also runs when the network changes.
#
# Found by inspection after the repair test: NextRunTime was empty and the
# only triggers were boot + logon. So if Tailscale drops and reconnects
# mid-session (or the address changes), NOTHING re-runs the guard and sshd can
# sit bound to 127.0.0.1 only -- remote access silently dead until reboot.
#
# Adds:
#   - a repeating trigger (every 5 minutes, indefinitely) as a safety net
#   - an event trigger on the Tailscale network interface coming up
# The guard is idempotent (logs "already bound" and exits), so frequent runs
# are cheap.

$ErrorActionPreference = 'Continue'
$out = "$env:TEMP\fleet-guard-triggers.txt"
function Say($m) { Add-Content -Path $out -Value $m -Encoding UTF8 }
Set-Content -Path $out -Value "=== guard triggers $(Get-Date -Format o) ===" -Encoding UTF8

$taskName = 'dsh-fleet-ensure-sshd-bind'
$guard = 'C:\ProgramData\ssh\fleet-ensure-bind.ps1'

$t = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $t) {
  Say "TASK_NOT_FOUND: $taskName"
  Say "=== DONE ==="
  exit 1
}

Say "--- triggers BEFORE ---"
$t.Triggers | ForEach-Object { Say "  $($_.CimClass.CimClassName)" }

# ---- build the full trigger set: boot, logon, repeating, network-up event ----
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$guard`""

$trigBoot = New-ScheduledTaskTrigger -AtStartup
$trigLogon = New-ScheduledTaskTrigger -AtLogOn

# repeating: start 2 minutes from now, repeat every 5 minutes for a long time
$trigRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

# event trigger: any network interface state change.
# Microsoft-Windows-NetworkProfile/Operational event 10000 = network connected.
# This fires when the Tailscale adapter comes up after a reconnect.
$class = Get-CimClass -ClassName MSFT_TaskEventTrigger -Namespace Root/Microsoft/Windows/TaskScheduler -ErrorAction SilentlyContinue
$trigEvent = $null
try {
  $trigEvent = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
  # convert to an event trigger via CIM
  $evt = New-CimInstance -CimClass $class -ClientOnly
  $evt.Enabled = $true
  $evt.Subscription = '<QueryList><Query Id="0" Path="Microsoft-Windows-NetworkProfile/Operational"><Select Path="Microsoft-Windows-NetworkProfile/Operational">*[System[(EventID=10000 or EventID=10001)]]</Select></Query></QueryList>'
  $trigEvent = $evt
  Say "event trigger built"
} catch {
  Say "event trigger NOT available: $($_.Exception.Message)"
  $trigEvent = $null
}

$triggers = @($trigBoot, $trigLogon, $trigRepeat)
if ($trigEvent) { $triggers += $trigEvent }

$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew

try {
  Set-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers `
    -Principal $principal -Settings $settings -ErrorAction Stop | Out-Null
  Say "task updated with $($triggers.Count) triggers"
} catch {
  Say "UPDATE_FAILED: $($_.Exception.Message)"
}

# ---- verify ----
$t2 = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Say ""
Say "--- triggers AFTER ---"
if ($t2) {
  foreach ($tr in $t2.Triggers) {
    $kind = $tr.CimClass.CimClassName
    $extra = ''
    if ($tr.Repetition) { $extra = " every=$($tr.Repetition.Interval)" }
    if ($tr.Subscription) { $extra = " event=$(($tr.Subscription -replace '\s+',' ').Substring(0,[Math]::Min(60,($tr.Subscription -replace '\s+',' ').Length)))..." }
    Say "  $kind$extra"
  }
  $info = Get-ScheduledTaskInfo -TaskName $taskName
  Say ""
  Say "  NextRunTime: $($info.NextRunTime)"
  Say "  LastResult : $($info.LastTaskResult)"
  Say "  State      : $($t2.State)"
}

# ---- run once now, confirm idempotent ----
Say ""
Say "--- run now (should log 'already bound') ---"
$logLen = 0
if (Test-Path 'C:\ProgramData\ssh\fleet-bind-guard.log') {
  $logLen = (Get-Content 'C:\ProgramData\ssh\fleet-bind-guard.log' | Measure-Object).Count
}
Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Start-Sleep -Seconds 12
if (Test-Path 'C:\ProgramData\ssh\fleet-bind-guard.log') {
  Get-Content 'C:\ProgramData\ssh\fleet-bind-guard.log' -Encoding UTF8 |
    Select-Object -Skip $logLen | ForEach-Object { Say "  $_" }
}
$addrs = ((Get-NetTCPConnection -LocalPort 22 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { $_.LocalAddress }) | Sort-Object) -join ','
Say "  listen now: $addrs"
Say "=== DONE ==="
