# Upgrade Node on machine A to 24.14.1.
#
# Run over SSH (the SSH session on A is already elevated and can write to
# Program Files), so the user no longer has to paste commands by hand.
#
# WHY 24 IS MANDATORY: dsh's bin.js ends with
#     if (import.meta.main) await runCli();
# import.meta.main only exists in Node 24+. On Node 22 it is undefined, so the
# guard is false, runCli() never runs, and `dsh` exits 0 in total silence.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # the progress bar makes downloads ~5x slower

$version = '24.14.1'
$url = "https://nodejs.org/dist/v$version/node-v$version-x64.msi"
$msi = Join-Path $env:TEMP "node-v$version-x64.msi"

Write-Output "=== current Node ==="
try { Write-Output ("  " + (& node -v)) } catch { Write-Output "  (not installed)" }

# Reuse a transferred MSI if present: saves 30 MB and avoids network flakiness.
if (Test-Path $msi) {
  $sz = [math]::Round((Get-Item $msi).Length / 1MB, 1)
  Write-Output "=== MSI already present: $msi ($sz MB), skipping download ==="
} else {
  Write-Output "=== downloading $url ==="
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $sw = [Diagnostics.Stopwatch]::StartNew()
  Invoke-WebRequest -Uri $url -OutFile $msi -UseBasicParsing -TimeoutSec 900
  $sw.Stop()
  $sz = [math]::Round((Get-Item $msi).Length / 1MB, 1)
  Write-Output "  downloaded: $sz MB in $([math]::Round($sw.Elapsed.TotalSeconds,1))s"
}

Write-Output "=== silent install ==="
$p = Start-Process msiexec.exe -ArgumentList @('/i', "`"$msi`"", '/qn', '/norestart') -Wait -PassThru
Write-Output "  msiexec exit: $($p.ExitCode)"
if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) {
  Write-Output "  INSTALL FAILED"
  exit 1
}

# msiexec updates PATH in the registry, but this process still holds the old copy.
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
            [Environment]::GetEnvironmentVariable('Path', 'User')

Write-Output "=== verify ==="
$nodeExe = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $nodeExe)) {
  Write-Output "  ERROR: $nodeExe not found"
  exit 1
}
Write-Output "  node -v: $(& $nodeExe -v)"

# THE decisive check: import.meta.main must be true, otherwise dsh still will
# not start no matter how cleanly it installed.
#
# Wrapped so node's stderr cannot terminate this script: under
# ErrorActionPreference='Stop', Windows PowerShell 5.1 turns each stderr line
# from an external program into an ErrorRecord and stops the run. See the Cap
# helper in setup-agent.ps1 for the full account of that failure mode.
$probe = Join-Path $env:TEMP 'm.mjs'
Set-Content -Path $probe -Value "console.log('MAIN=' + import.meta.main)" -Encoding ASCII
$oldEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  $main = (& $nodeExe $probe 2>&1 | Out-String).Trim()
} finally {
  $ErrorActionPreference = $oldEap
}
Write-Output "  $main"
Remove-Item $probe -Force -ErrorAction SilentlyContinue

if ($main -eq 'MAIN=true') {
  Write-Output "  OK: import.meta.main is true, dsh will boot normally"
} else {
  Write-Output "  FAIL: import.meta.main is not true, dsh would still fail silently"
  exit 1
}
