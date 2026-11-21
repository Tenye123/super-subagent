# Install Windows OpenSSH Server -- must run elevated
# Pure ASCII only: PowerShell 5.1 reads .ps1 as GBK on this machine.
#
# Writes progress to a result file so the caller can read it back
# (the elevated process has its own detached console).

$ErrorActionPreference = 'Continue'
$out = "$env:TEMP\fleet-sshd-install.txt"
function Say($m) { Add-Content -Path $out -Value $m -Encoding UTF8 }

Set-Content -Path $out -Value "=== OpenSSH Server install $(Get-Date -Format o) ===" -Encoding UTF8

# ---- 1. capability ----
try {
  $cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' -ErrorAction Stop
  Say "capability: $($cap.Name) state=$($cap.State)"
  if ($cap.State -ne 'Installed') {
    Say "installing capability..."
    $r = Add-WindowsCapability -Online -Name $cap.Name -ErrorAction Stop
    Say "add result: $($r.RestartNeeded) restartNeeded"
  }
  $after = Get-WindowsCapability -Online -Name 'OpenSSH.Server*'
  Say "capability now: $($after.State)"
} catch {
  Say "CAPABILITY_ERROR: $($_.Exception.Message)"
}

# ---- 2. verify binaries ----
$sshd = 'C:\Windows\System32\OpenSSH\sshd.exe'
Say "sshd.exe exists: $(Test-Path $sshd)"
if (Test-Path $sshd) {
  try { Say "sshd version: $((& $sshd -V 2>&1 | Out-String).Trim())" } catch { Say "version error: $_" }
}

$cfg = 'C:\ProgramData\ssh\sshd_config'
Say "sshd_config exists: $(Test-Path $cfg)"

# ---- 3. harden config ----
if (Test-Path $cfg) {
  $raw = Get-Content $cfg -Raw

  # back up once only
  $bak = "$cfg.fleet-bak"
  if (-not (Test-Path $bak)) {
    Copy-Item $cfg $bak
    Say "backup: $bak"
  } else {
    Say "backup already exists, not overwriting"
  }

  function Set-SshdOption {
    param([string]$Text, [string]$Key, [string]$Value)
    $pattern = "(?m)^#?\s*$([regex]::Escape($Key))\s+\S*[^\r\n]*$"
    $line = "$Key $Value"
    if ([regex]::IsMatch($Text, $pattern)) {
      return [regex]::Replace($Text, $pattern, $line, 1)
    }
    return $Text.TrimEnd() + "`r`n" + $line + "`r`n"
  }

  $raw = Set-SshdOption $raw 'PubkeyAuthentication' 'yes'
  $raw = Set-SshdOption $raw 'PasswordAuthentication' 'no'
  $raw = Set-SshdOption $raw 'PermitEmptyPasswords' 'no'
  $raw = Set-SshdOption $raw 'AllowTcpForwarding' 'no'
  $raw = Set-SshdOption $raw 'AllowAgentForwarding' 'no'
  $raw = Set-SshdOption $raw 'PermitTunnel' 'no'
  $raw = Set-SshdOption $raw 'X11Forwarding' 'no'

  # Host keys must exist before the service can start
  $hk = 'C:\ProgramData\ssh\ssh_host_ed25519_key'
  if (-not (Test-Path $hk)) {
    Say "generating host keys..."
    & 'C:\Windows\System32\OpenSSH\ssh-keygen.exe' -A 2>&1 | ForEach-Object { Say "  $_" }
  }
  Say "host key exists: $(Test-Path $hk)"

  # sshd refuses to run if host keys are readable by non-admins
  if (Test-Path $hk) {
    & icacls $hk /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F" 2>&1 | Out-Null
    Say "host key ACL tightened"
  }

  Set-Content -Path $cfg -Value $raw -Encoding ASCII
  Say "sshd_config updated"
  Say "--- effective settings ---"
  foreach ($k in @('PubkeyAuthentication','PasswordAuthentication','PermitEmptyPasswords','AllowTcpForwarding','AllowAgentForwarding','PermitTunnel','X11Forwarding','Port')) {
    $m = [regex]::Match($raw, "(?m)^\s*$([regex]::Escape($k))\s+(.+)$")
    if ($m.Success) { Say "  $k = $($m.Groups[1].Value.Trim())" } else { Say "  $k = (default)" }
  }

  # ---- 4. service ----
  try {
    Set-Service sshd -StartupType Automatic -ErrorAction Stop
    Say "service set to Automatic"
  } catch { Say "Set-Service failed: $($_.Exception.Message)" }

  try {
    Restart-Service sshd -Force -ErrorAction Stop
    Start-Sleep -Seconds 2
    $svc = Get-Service sshd
    Say "service status: $($svc.Status)"
  } catch {
    Say "Restart-Service failed: $($_.Exception.Message)"
    try {
      Start-Service sshd -ErrorAction Stop
      Say "Start-Service ok: $((Get-Service sshd).Status)"
    } catch { Say "Start-Service failed: $($_.Exception.Message)" }
  }

  # ---- 5. firewall: Tailscale interface only ----
  try {
    Get-NetFirewallRule -DisplayName 'dsh-fleet-sshd*' -ErrorAction SilentlyContinue |
      ForEach-Object { Remove-NetFirewallRule -DisplayName $_.DisplayName -ErrorAction SilentlyContinue }
    $tsIf = Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceDescription -match 'Tailscale' }
    if ($tsIf) {
      New-NetFirewallRule -DisplayName 'dsh-fleet-sshd-tailscale' -Direction Inbound `
        -Protocol TCP -LocalPort 22 -Action Allow -InterfaceAlias $tsIf.Name -ErrorAction Stop | Out-Null
      Say "firewall rule added for interface: $($tsIf.Name)"
    } else {
      Say "no Tailscale adapter yet, firewall rule deferred"
    }
  } catch { Say "firewall error: $($_.Exception.Message)" }

  # ---- 6. listening check ----
  try {
    $conn = Get-NetTCPConnection -LocalPort 22 -State Listen -ErrorAction SilentlyContinue
    Say "listening on 22: $([bool]$conn)"
  } catch { Say "listen check error: $_" }
}

Say "=== DONE ==="
