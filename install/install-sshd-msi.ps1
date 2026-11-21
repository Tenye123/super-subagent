# Install OpenSSH Server from the official MSI (offline, no Windows Update)
# Must run elevated. Pure ASCII only.
#
# Why not Add-WindowsCapability:
#   On this machine DISM hung for 41+ minutes waiting on Windows Update
#   (CBS looped empty sessions, download cache never grew). The MSI from
#   PowerShell/Win32-OpenSSH installs the same binaries without touching WU.

$ErrorActionPreference = 'Continue'
$out = "$env:TEMP\fleet-sshd-msi.txt"
function Say($m) { Add-Content -Path $out -Value $m -Encoding UTF8 }

Set-Content -Path $out -Value "=== OpenSSH MSI install $(Get-Date -Format o) ===" -Encoding UTF8

$msi = "$env:TEMP\OpenSSH-Win64-v10.4.0.0.msi"

# ---- 1. verify the MSI is present and signed ----
# Download happens in the NON-elevated shell: the elevated process on this
# machine cannot reach the internet (proxy lives in the user session), so
# downloading here always fails with "cannot connect to the remote server".
if (-not (Test-Path $msi)) {
  Say "MSI_MISSING: $msi"
  Say "download it first in a normal (non-elevated) PowerShell:"
  Say "  Invoke-WebRequest 'https://github.com/PowerShell/Win32-OpenSSH/releases/download/10.4.0.0p1-Preview/OpenSSH-Win64-v10.4.0.0.msi' -OutFile `"$msi`""
  Say "=== DONE ==="
  exit 1
}

$sig = Get-AuthenticodeSignature $msi
Say "MSI: $([math]::Round((Get-Item $msi).Length / 1MB, 1)) MB"
Say "signature status: $($sig.Status)"
Say "signer: $($sig.SignerCertificate.Subject)"


# ---- 2. install ----
Say "running msiexec..."
$log = "$env:TEMP\fleet-msi.log"
$args = @('/i', "`"$msi`"", '/qn', '/norestart', '/L*v', "`"$log`"")
$p = Start-Process msiexec.exe -ArgumentList $args -Wait -PassThru -NoNewWindow
Say "msiexec exit code: $($p.ExitCode)"

if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) {
  Say "MSI_FAILED exit=$($p.ExitCode)"
  if (Test-Path $log) {
    Say "--- msi log tail ---"
    Get-Content $log -Tail 20 | ForEach-Object { Say "  $_" }
  }
  Say "=== DONE ==="
  exit 1
}

# ---- 3. verify ----
$sshd = 'C:\Program Files\OpenSSH\sshd.exe'
if (-not (Test-Path $sshd)) { $sshd = 'C:\Windows\System32\OpenSSH\sshd.exe' }
Say "sshd.exe path: $sshd"
Say "sshd.exe exists: $(Test-Path $sshd)"

if (Test-Path $sshd) {
  $ver = (& $sshd -V 2>&1 | Out-String).Trim()
  Say "version: $ver"
}

# ---- 4. host keys + config ----
$dataDir = 'C:\ProgramData\ssh'
if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Force -Path $dataDir | Out-Null }

$hk = Join-Path $dataDir 'ssh_host_ed25519_key'
if (-not (Test-Path $hk)) {
  Say "generating host keys..."
  $kg = Join-Path (Split-Path $sshd) 'ssh-keygen.exe'
  & $kg -A 2>&1 | ForEach-Object { Say "  $_" }
}
Say "host key exists: $(Test-Path $hk)"

if (Test-Path $hk) {
  & icacls $hk /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F" 2>&1 | Out-Null
  Say "host key ACL set"
}

# ---- 5. sshd_config ----
$cfg = Join-Path $dataDir 'sshd_config'
$defaults = Join-Path (Split-Path $sshd) 'sshd_config_default'
if (-not (Test-Path $cfg)) {
  if (Test-Path $defaults) {
    Copy-Item $defaults $cfg
    Say "sshd_config seeded from sshd_config_default"
  } else {
    Say "NO_DEFAULT_CONFIG"
  }
}

if (Test-Path $cfg) {
  $raw = Get-Content $cfg -Raw
  $bak = "$cfg.fleet-bak"
  if (-not (Test-Path $bak)) { Copy-Item $cfg $bak; Say "backup: $bak" }

  function Set-SshdOption {
    param([string]$Text, [string]$Key, [string]$Value)

    # IMPORTANT: two separate traps here, both verified by experiment.
    #
    # 1) Use [ \t] not \s for leading whitespace. \s also matches newlines,
    #    so "^#?\s*KEY\s+..." matched across a line break and appended twice.
    #
    # 2) In .NET multiline mode, "$" anchors before the "\n" but AFTER the
    #    "\r" of a CRLF pair, so "...[^\r\n]*$" can never match a CRLF line
    #    (the "\r" is left over and [^\r\n]* refuses it). Use a lookahead
    #    "(?=\r?$)" instead -- that works for both LF and CRLF.
    $pattern = "(?m)^[ \t]*#?[ \t]*$([regex]::Escape($Key))[ \t]+[^\r\n]*(?=\r?$)"
    $line = "$Key $Value"

    # Only touch the part BEFORE the first "Match" block.
    # The stock Windows config ends with "Match Group administrators ...",
    # and directives such as Port are illegal inside a Match block --
    # sshd then refuses to start with
    # "Directive 'Port' is not allowed within a Match block".
    $matchIdx = [regex]::Match($Text, '(?m)^[ \t]*Match[ \t]').Index
    $head = if ($matchIdx -ge 0) { $Text.Substring(0, $matchIdx) } else { $Text }
    $tail = if ($matchIdx -ge 0) { $Text.Substring($matchIdx) } else { '' }

    if ([regex]::IsMatch($head, $pattern)) {
      # Replace ONLY the first matching line, leaving any later occurrences
      # untouched. [regex]::Replace(text, pattern, line, 1) does NOT do that:
      # the 4-arg overload's "1" is the match-count limit, but every matched
      # occurrence still gets substituted with the same replacement, so a
      # commented example further down ("#\tAllowTcpForwarding no") turned
      # into a live duplicate directive (verified: count went from 1 to 2).
      $script:fleetReplaced = 0
      $evaluator = [System.Text.RegularExpressions.MatchEvaluator] {
        param($m)
        $script:fleetReplaced++
        if ($script:fleetReplaced -eq 1) { return $line }
        return $m.Value
      }
      $head = [regex]::Replace($head, $pattern, $evaluator)
    } else {
      $head = $head.TrimEnd() + "`r`n" + $line + "`r`n`r`n"
    }
    return $head + $tail
  }

  $raw = Set-SshdOption $raw 'PubkeyAuthentication' 'yes'
  $raw = Set-SshdOption $raw 'PasswordAuthentication' 'no'
  $raw = Set-SshdOption $raw 'PermitEmptyPasswords' 'no'
  $raw = Set-SshdOption $raw 'AllowTcpForwarding' 'no'
  $raw = Set-SshdOption $raw 'AllowAgentForwarding' 'no'
  $raw = Set-SshdOption $raw 'PermitTunnel' 'no'
  $raw = Set-SshdOption $raw 'X11Forwarding' 'no'

  Set-Content -Path $cfg -Value $raw -Encoding ASCII
  Say "sshd_config written"
  Say "--- effective (before first Match block) ---"
  $mi = [regex]::Match($raw, '(?m)^\s*Match\s').Index
  $headOnly = if ($mi -ge 0) { $raw.Substring(0, $mi) } else { $raw }
  foreach ($k in @('Port','PubkeyAuthentication','PasswordAuthentication','PermitEmptyPasswords','AllowTcpForwarding','AllowAgentForwarding','PermitTunnel','X11Forwarding')) {
    $m = [regex]::Match($headOnly, "(?m)^\s*$([regex]::Escape($k))\s+(.+)$")
    if ($m.Success) { Say "  $k = $($m.Groups[1].Value.Trim())" }
  }

  # syntax check before starting the service -- must pass
  $t = (& $sshd -t -f $cfg 2>&1 | Out-String).Trim()
  if ($t) {
    Say "CONFIG_INVALID: $t"
  } else {
    Say "config syntax OK"
  }
}

# ---- 6. service registration ----
$svc = Get-Service sshd -ErrorAction SilentlyContinue
if (-not $svc) {
  Say "service absent, registering..."
  $installScript = Join-Path (Split-Path $sshd) 'install-sshd.ps1'
  if (Test-Path $installScript) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installScript 2>&1 | ForEach-Object { Say "  $_" }
  } else {
    Say "install-sshd.ps1 not found; trying sc create"
    & sc.exe create sshd binPath= "`"$sshd`"" start= auto 2>&1 | ForEach-Object { Say "  $_" }
  }
}

try {
  Set-Service sshd -StartupType Automatic -ErrorAction Stop
  Say "service Automatic"
} catch { Say "Set-Service: $($_.Exception.Message)" }

try {
  Restart-Service sshd -Force -ErrorAction Stop
  Start-Sleep -Seconds 3
  Say "service status: $((Get-Service sshd).Status)"
} catch {
  Say "restart failed: $($_.Exception.Message)"
  try { Start-Service sshd -ErrorAction Stop; Say "started: $((Get-Service sshd).Status)" }
  catch { Say "start failed: $($_.Exception.Message)" }
}

# ---- 7. firewall ----
try {
  Get-NetFirewallRule -DisplayName 'dsh-fleet-sshd*' -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-NetFirewallRule -DisplayName $_.DisplayName -ErrorAction SilentlyContinue }
  $tsIf = Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceDescription -match 'Tailscale' -and $_.Status -eq 'Up' }
  if ($tsIf) {
    New-NetFirewallRule -DisplayName 'dsh-fleet-sshd-tailscale' -Direction Inbound -Protocol TCP -LocalPort 22 -Action Allow -InterfaceAlias $tsIf.Name -ErrorAction Stop | Out-Null
    Say "firewall: allow 22 on $($tsIf.Name)"
  } else {
    Say "firewall: no Tailscale adapter up, deferred"
  }
} catch { Say "firewall error: $($_.Exception.Message)" }

# ---- 8. verify listening ----
Start-Sleep -Seconds 2
try {
  $c = Get-NetTCPConnection -LocalPort 22 -State Listen -ErrorAction SilentlyContinue
  Say "listening on 22: $([bool]$c)"
} catch { Say "listen check: $_" }

Say "=== DONE ==="
