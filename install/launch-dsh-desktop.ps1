# Launch DSH Desktop into the user's interactive desktop session.
#
# WHY THIS IS NEEDED: SSH lands in session 0 (the services session, no desktop).
# An Electron app started there dies almost immediately -- measured on the real
# agent machine: "STARTED pid=17572" and six seconds later the process was gone,
# with no window anywhere the user could see.
#
# The fix is an /it (interactive) scheduled task owned by the logged-on user, so
# Windows places the process in that user's real desktop session (session 1).
#
# WHY NOT schtasks /create: measured failure. `schtasks /tr '"D:\DSH Desktop\
# DSH Desktop.exe"'` truncates the path at the first space. The task gets created
# successfully (exit 0), then fails at run time with 0x80070002
# (ERROR_FILE_NOT_FOUND) and the action reads just "D:\DSH". The quoted string
# does not survive schtasks' own argument parsing. The ScheduledTasks module
# takes the path as a value instead of as command-line text, so spaces are safe.
#
# This file MUST stay pure ASCII. PowerShell 5.1 reads BOM-less .ps1 files as
# GBK; Chinese in a comment swallows the trailing newline and merges the next
# line of code into the comment, so the code silently never runs.

$taskName = 'FleetLaunchDSHDesktop'
$exe = 'D:\DSH Desktop\DSH Desktop.exe'

Write-Output "=== preflight ==="
Write-Output ("exe exists: " + (Test-Path $exe))
if (-not (Test-Path $exe)) { exit 1 }

$userName = "$env:USERDOMAIN\$env:USERNAME"
Write-Output ("user: " + $userName)

$oldEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'

Write-Output ""
Write-Output "=== remove stale task ==="
try {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Output "  (removed or did not exist)"
} catch {
  Write-Output ("  remove failed: " + $_.Exception.Message)
}

Write-Output ""
Write-Output "=== create interactive task ==="
try {
  # -WorkingDirectory matters: Electron apps often resolve resources relative
  # to the working directory, and the shortcut's WorkDir is D:\DSH Desktop.
  $action = New-ScheduledTaskAction -Execute $exe -WorkingDirectory (Split-Path -Parent $exe)
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddYears(1)
  # LogonType Interactive == the task only runs when the user is logged on, and
  # it runs INSIDE that user's desktop session rather than in session 0.
  $principal = New-ScheduledTaskPrincipal -UserId $userName -LogonType Interactive
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)

  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null

  $t = Get-ScheduledTask -TaskName $taskName
  Write-Output ("  registered; action = " + $t.Actions[0].Execute)
  Write-Output ("  workdir = " + $t.Actions[0].WorkingDirectory)
} catch {
  Write-Output ("  create failed: " + $_.Exception.Message)
  $ErrorActionPreference = $oldEap
  exit 1
}

Write-Output ""
Write-Output "=== run it ==="
try {
  Start-ScheduledTask -TaskName $taskName
  Write-Output "  started"
} catch {
  Write-Output ("  run failed: " + $_.Exception.Message)
}

Write-Output ""
Write-Output "=== waiting for process ==="
$found = $null
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 800
  $p = @(Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue)
  if ($p.Count -gt 0) { $found = $p; break }
}

if ($found) {
  foreach ($x in $found) {
    Write-Output ("  pid=" + $x.Id + " session=" + $x.SessionId + " responding=" + $x.Responding.ToString())
    Write-Output ("  threads=" + $x.Threads.Count + " memMB=" + [math]::Round($x.WorkingSet64 / 1MB, 1))
  }
  $sess = @($found)[0].SessionId
  if ($sess -eq 1) {
    Write-Output "  OK: running in the interactive desktop session"
  } else {
    Write-Output ("  WARNING: session " + $sess + " is not the interactive desktop session")
  }

  $main = @($found | Where-Object { $_.MainWindowTitle -ne '' })
  if ($main.Count -gt 0) {
    foreach ($m in $main) { Write-Output ("  window: '" + $m.MainWindowTitle + "'") }
  } else {
    Write-Output "  window: (no main window title yet)"
  }
} else {
  Write-Output "  DSH Desktop did not stay running"
  $info = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
  if ($info) {
    Write-Output ("  LastTaskResult: 0x" + ('{0:X}' -f $info.LastTaskResult))
  }
}

$ErrorActionPreference = $oldEap
Write-Output ""
Write-Output "=== done ==="
