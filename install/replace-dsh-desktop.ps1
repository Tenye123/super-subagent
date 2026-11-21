# Replace DSH Desktop (DataElement, 0.13.0) on the agent machine with the
# official DeepSeek Harness (0.2.2-rc.5) so it matches the controller.
#
# Download rather than transfer: measured on this link, pushing 285 MB over SSH
# is unusable. A raw stdin pipe stalled after 6 KB, and base64 chunks fail
# because CreateProcess caps the whole command line at ~32 KB -- a 256 KB chunk
# becomes a 350 KB argument and never reaches ssh. Letting the agent machine
# fetch from the official CDN sidesteps the SSH channel entirely.
#
# The two products are NOT versions of one another:
#   DSH Desktop 0.13.0        publisher DataElement          (D:\DSH Desktop)
#   DeepSeek Harness 0.2.2    Hangzhou DeepSeek AI Co., Ltd  (installer below)
# Same Electron skeleton, different application.
#
# This file MUST stay pure ASCII (PowerShell 5.1 reads BOM-less .ps1 as GBK).

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$url = 'https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.2.2-rc.5-win-x64.exe'
$expectedSize = 299593552
# sha512 from the vendor's own nightly.yml, cross-checked against the copy
# already installed on the controller.
$expectedSha512 = 'wWySRp7Hk5gcH324jBxAc7KV0mniHzQDofyQexOJMIAWXBkgHTsRCr3IrdwX1XO8OIhDZsLYmve4mLxskikYIg=='

$work = Join-Path $env:TEMP 'dsh-upgrade'
$msi = Join-Path $work 'deepseek-harness-setup.exe'

if (-not (Test-Path $work)) { New-Item -ItemType Directory -Path $work -Force | Out-Null }

Write-Output "=== 1. download ==="
$needDownload = $true
if (Test-Path $msi) {
  $have = (Get-Item $msi).Length
  if ($have -eq $expectedSize) {
    Write-Output ("  already present, correct size: " + $have)
    $needDownload = $false
  } else {
    Write-Output ("  stale partial (" + $have + " bytes), re-downloading")
    Remove-Item $msi -Force
  }
}

if ($needDownload) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $sw = [Diagnostics.Stopwatch]::StartNew()
  Invoke-WebRequest -Uri $url -OutFile $msi -UseBasicParsing -TimeoutSec 3600
  $sw.Stop()
  $got = (Get-Item $msi).Length
  Write-Output ("  downloaded: " + [math]::Round($got / 1MB, 1) + " MB in " +
    [math]::Round($sw.Elapsed.TotalSeconds, 1) + "s")
}

Write-Output ""
Write-Output "=== 2. verify ==="
$size = (Get-Item $msi).Length
Write-Output ("  size: " + $size + " (expected " + $expectedSize + ")")
if ($size -ne $expectedSize) {
  Write-Output "  FAIL: size mismatch, refusing to install"
  exit 1
}

$sha = [Security.Cryptography.SHA512]::Create()
$fs = [IO.File]::OpenRead($msi)
$hash = [Convert]::ToBase64String($sha.ComputeHash($fs))
$fs.Close()
$sha.Dispose()
Write-Output ("  sha512: " + $hash)
if ($hash -ne $expectedSha512) {
  Write-Output "  FAIL: sha512 mismatch, refusing to install"
  exit 1
}
Write-Output "  OK: size and hash match the vendor manifest"

# Signature check: an unsigned or wrongly-signed binary must not be installed
# just because its hash matched a file we downloaded from the same place.
$sig = Get-AuthenticodeSignature $msi
Write-Output ("  signature: " + $sig.Status + " / " + $sig.SignerCertificate.Subject)
if ($sig.Status -ne 'Valid') {
  Write-Output "  FAIL: signature is not valid"
  exit 1
}
if ($sig.SignerCertificate.Subject -notmatch 'Hangzhou DeepSeek') {
  Write-Output "  FAIL: signer is not DeepSeek"
  exit 1
}
Write-Output "  OK: validly signed by DeepSeek"

Write-Output ""
Write-Output "=== 3. stop the old app ==="
$old = @(Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue)
Write-Output ("  running DSH Desktop processes: " + $old.Count)
foreach ($p in $old) {
  try { Stop-Process -Id $p.Id -Force -ErrorAction Stop } catch { }
}
Start-Sleep -Milliseconds 1500
$still = @(Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue)
Write-Output ("  after stop: " + $still.Count)
foreach ($p in $still) {
  try { Stop-Process -Id $p.Id -Force -ErrorAction Stop } catch { }
}
Start-Sleep -Milliseconds 1000

Write-Output ""
Write-Output "=== 4. uninstall DSH Desktop (DataElement) ==="
$uninstaller = 'D:\DSH Desktop\Uninstall DSH Desktop.exe'
if (Test-Path $uninstaller) {
  Write-Output ("  running: " + $uninstaller)
  # electron-builder NSIS uninstaller honours /S for a silent run.
  $p = Start-Process -FilePath $uninstaller -ArgumentList '/S','/currentuser' -Wait -PassThru -ErrorAction SilentlyContinue
  Write-Output ("  uninstaller exit: " + $(if ($p) { $p.ExitCode } else { 'n/a' }))
  Start-Sleep -Seconds 3
} else {
  Write-Output "  uninstaller not found, will remove the directory directly"
}

# The NSIS uninstaller sometimes leaves the folder behind; clean up only if the
# executable is gone, so we never delete a still-registered install.
if (Test-Path 'D:\DSH Desktop\DSH Desktop.exe') {
  Write-Output "  exe still present, attempting directory removal"
  Remove-Item 'D:\DSH Desktop' -Recurse -Force -ErrorAction SilentlyContinue
}

$left = Test-Path 'D:\DSH Desktop'
Write-Output ("  directory still exists: " + $left)
$reg = @()
foreach ($rk in @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
  $reg += @(Get-ItemProperty $rk -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'DSH Desktop' })
}
Write-Output ("  registry entries named DSH Desktop: " + $reg.Count)

Write-Output ""
Write-Output "=== 5. install DeepSeek Harness ==="
# electron-builder NSIS: /S silent, /currentuser per-user install (no admin).
$p = Start-Process -FilePath $msi -ArgumentList '/S','/currentuser' -Wait -PassThru
Write-Output ("  installer exit: " + $p.ExitCode)

# The NSIS installer returns before the files are fully written in some cases;
# poll for the expected executable rather than assuming.
$candidates = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'),
  'E:\DeepSeek Harness\DeepSeek Harness.exe',
  'C:\Program Files\DeepSeek Harness\DeepSeek Harness.exe'
)
$found = $null
for ($i = 0; $i -lt 30; $i++) {
  foreach ($c in $candidates) { if (Test-Path $c) { $found = $c; break } }
  if ($found) { break }
  Start-Sleep -Milliseconds 1000
}

Write-Output ""
Write-Output "=== 6. verify installation ==="
if ($found) {
  Write-Output ("  installed at: " + $found)
  $v = (Get-Item $found).VersionInfo
  Write-Output ("  FileVersion   : " + $v.FileVersion)
  Write-Output ("  ProductName   : " + $v.ProductName)
  Write-Output ("  CompanyName   : " + $v.CompanyName)
} else {
  Write-Output "  FAIL: DeepSeek Harness executable not found after install"
  $reg = @()
  foreach ($rk in @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
    $reg += @(Get-ItemProperty $rk -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'DeepSeek' })
  }
  foreach ($r in $reg) { Write-Output ("  registry: " + $r.DisplayName + " " + $r.DisplayVersion + " @ " + $r.InstallLocation) }
  exit 1
}

Write-Output ""
Write-Output "=== 7. final registry state ==="
foreach ($rk in @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
  Get-ItemProperty $rk -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -match 'DSH|DeepSeek' } |
    ForEach-Object {
      Write-Output ("  " + $_.DisplayName + " | " + $_.DisplayVersion + " | " +
        $_.Publisher + " | " + $_.InstallLocation)
    }
}

Write-Output ""
Write-Output "=== done ==="
