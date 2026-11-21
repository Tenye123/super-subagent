# Install Tailscale -- must run elevated. Pure ASCII only.
#
# The MSI is downloaded by the caller in a NON-elevated shell, because the
# elevated process on this machine cannot reach the internet.

$ErrorActionPreference = 'Continue'
$out = "$env:TEMP\fleet-ts-install.txt"
function Say($m) { Add-Content -Path $out -Value $m -Encoding UTF8 }
Set-Content -Path $out -Value "=== Tailscale install $(Get-Date -Format o) ===" -Encoding UTF8

$msi = "$env:TEMP\tailscale-setup.msi"

if (-not (Test-Path $msi)) {
  Say "MSI_MISSING: $msi"
  Say "download it first in a normal PowerShell:"
  Say "  Invoke-WebRequest 'https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi' -OutFile `"$msi`""
  Say "=== DONE ==="
  exit 1
}

$sig = Get-AuthenticodeSignature $msi
Say "signature: $($sig.Status)"
Say "signer: $($sig.SignerCertificate.Subject)"

Say "running msiexec..."
$argList = @('/i', $msi, '/qn', '/norestart')
$p = Start-Process msiexec.exe -ArgumentList $argList -Wait -PassThru -NoNewWindow
Say "msiexec exit: $($p.ExitCode)"

if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) {
  Say "MSI_FAILED exit=$($p.ExitCode)"
  Say "=== DONE ==="
  exit 1
}

Start-Sleep -Seconds 5

$exe = 'C:\Program Files\Tailscale\tailscale.exe'
Say "tailscale.exe: $(Test-Path $exe)"

if (Test-Path $exe) {
  $v = (& $exe version 2>&1 | Out-String).Trim()
  Say "version: $v"
  Say "--- status ---"
  $st = (& $exe status 2>&1 | Out-String).Trim()
  Say $st
}

$svc = Get-Service Tailscale -ErrorAction SilentlyContinue
if ($svc) { Say "service: $($svc.Status) / $($svc.StartType)" } else { Say "service: NOT FOUND" }

$ad = Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceDescription -match 'Tailscale' }
if ($ad) {
  Say "adapter: $($ad.Name) status=$($ad.Status)"
} else {
  Say "adapter: not present yet (needs tailscale up / login)"
}

Say "=== DONE ==="
