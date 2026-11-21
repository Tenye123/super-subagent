# Remove the OpenSSH SERVER that was installed on B by mistake.
#
# BACKGROUND (why this exists)
#   The two machines were misidentified: the controller (B) was treated as the
#   agent (A). B therefore got an sshd service, a portable OpenSSH build under
#   C:\Program Files\OpenSSH, a firewall rule and C:\ProgramData\ssh -- all of
#   which belong on A.
#
#   B is the CONTROLLER. It needs an SSH *client* (Windows ships one in
#   C:\Windows\System32\OpenSSH) and Tailscale. It must NOT accept SSH.
#
#   Leaving the server running is not dangerous (pubkey-only, bound to the
#   tailnet address) but it is dead weight and muddies the security story.
#
# WHAT THIS REMOVES
#   - the sshd Windows service
#   - C:\Program Files\OpenSSH  (the portable server build)
#   - the dsh-fleet firewall rule for port 22
#   - C:\ProgramData\ssh        (host keys / config / authorized_keys)
#
# WHAT THIS KEEPS (deliberately)
#   - C:\Windows\System32\OpenSSH  -- the client B needs in order to reach A
#   - Tailscale                    -- the transport to reach A
#   - Windows' built-in OpenSSH-Server-In-TCP rule stays DISABLED, so even if
#     something reinstalls a server later, port 22 is not exposed
#
# IDEMPOTENT: safe to run repeatedly; skips whatever is already absent.
# Must run elevated. Pure ASCII only (PowerShell 5.1 reads GBK).

$ErrorActionPreference = 'Continue'
$out = "$env:TEMP\fleet-cleanup-b.txt"
function Say($m) { Add-Content -Path $out -Value $m -Encoding UTF8 }
Set-Content -Path $out -Value "=== remove sshd from controller B $(Get-Date -Format o) ===" -Encoding UTF8

$portable = 'C:\Program Files\OpenSSH'
$sysDir = 'C:\Windows\System32\OpenSSH'
$sysAgent = Join-Path $sysDir 'ssh-agent.exe'

# ---- 0. refuse to run on an AGENT machine ----
# On A, sshd is the access path; deleting it means losing remote access.
$cfgPath = Join-Path $env:USERPROFILE '.dsh-fleet\config.json'
if (Test-Path $cfgPath) {
  try {
    $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
    if ($cfg.role -eq 'agent') {
      Say "REFUSING: this machine is configured with role=agent."
      Say "Removing sshd here would destroy the remote access path."
      Say "=== DONE ==="
      exit 1
    }
    Say "fleet role: $($cfg.role)"
  } catch {
    Say "could not parse config.json: $($_.Exception.Message)"
  }
} else {
  Say "no fleet config -- this machine is not an initialized agent"
}

# ---- 1. ssh-agent must not point into the directory we are about to delete ----
# This was the reason the first two attempts failed with
# "access denied on libcrypto.dll": the portable build had registered its own
# ssh-agent as a service (StartType=Automatic) whose ImagePath lived inside
# C:\Program Files\OpenSSH, so the DLL stayed mapped no matter how many times
# the process was killed -- the service simply restarted it.
$agPath = (Get-CimInstance Win32_Service -Filter "Name='ssh-agent'" -ErrorAction SilentlyContinue).PathName
if ($agPath -and $agPath -match 'Program Files\\OpenSSH') {
  Say "ssh-agent points into the portable build: $agPath"
  if (Test-Path $sysAgent) {
    Say "  repointing it to the Windows bundled binary"
    Stop-Service ssh-agent -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    & sc.exe config ssh-agent binPath= "`"$sysAgent`"" 2>&1 | ForEach-Object { Say "    $_" }
    Start-Sleep -Seconds 1
    Start-Service ssh-agent -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    Say "  now: $((Get-CimInstance Win32_Service -Filter "Name='ssh-agent'").PathName)"
  } else {
    Say "  WARNING: no system ssh-agent to repoint to; leaving the service as is"
  }
} elseif ($agPath) {
  Say "ssh-agent already points at: $agPath"
}

# ---- 2. stop and delete the sshd service ----
$svc = Get-Service sshd -ErrorAction SilentlyContinue
if ($svc) {
  $pathName = (Get-CimInstance Win32_Service -Filter "Name='sshd'" -ErrorAction SilentlyContinue).PathName
  Say "sshd service: $($svc.Status)  PathName: $pathName"
  if ($pathName -match 'Program Files\\OpenSSH') {
    Stop-Service sshd -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    $uninst = Join-Path $portable 'uninstall-sshd.ps1'
    if (Test-Path $uninst) {
      Say "  running the shipped uninstaller"
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $uninst 2>&1 |
        ForEach-Object { Say "    $_" }
    }
    if (Get-Service sshd -ErrorAction SilentlyContinue) {
      Say "  uninstaller left it behind, using sc.exe delete"
      & sc.exe delete sshd 2>&1 | ForEach-Object { Say "    $_" }
      Start-Sleep -Seconds 1
    }
    Say "  sshd service now: $(if(Get-Service sshd -ErrorAction SilentlyContinue){'STILL PRESENT'}else{'removed'})"
  } else {
    Say "  NOT the portable build -- leaving it alone"
  }
} else {
  Say "no sshd service present"
}

# ---- 3. firewall rule ----
$fw = Get-NetFirewallRule -DisplayName 'dsh-fleet-sshd-tailscale' -ErrorAction SilentlyContinue
if ($fw) {
  Remove-NetFirewallRule -Name $fw.Name -ErrorAction SilentlyContinue
  Say "removed firewall rule dsh-fleet-sshd-tailscale"
} else {
  Say "no dsh-fleet firewall rule present"
}

# ---- 4. the portable build directory ----
if (Test-Path $portable) {
  Get-Process -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -and $_.Path -like "$portable*" } catch { $false }
  } | ForEach-Object {
    Say "stopping leftover process $($_.Id) $($_.ProcessName)"
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 1
  Get-ChildItem $portable -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
    try { $_.Attributes = 'Normal' } catch { }
  }
  $gone = $false
  for ($i = 1; $i -le 3; $i++) {
    try {
      Remove-Item $portable -Recurse -Force -ErrorAction Stop
      Say "removed the portable build (attempt $i)"
      $gone = $true
      break
    } catch {
      Say "attempt $i failed: $($_.Exception.Message)"
      Start-Sleep -Seconds 2
    }
  }
  if (-not $gone -and (Test-Path $portable)) {
    $aside = "$portable.removed-$(Get-Date -Format yyyyMMdd-HHmmss)"
    try {
      Rename-Item $portable $aside -ErrorAction Stop
      Say "still locked; renamed aside to $aside (delete after a reboot)"
    } catch {
      Say "rename failed too: $($_.Exception.Message)"
    }
  }
} else {
  Say "portable build directory already absent"
}

# ---- 5. host keys / config generated here by mistake ----
# Keep a copy: these are machine-specific and must NOT be reused on A, but a
# backup costs nothing and makes the removal reversible.
if (Test-Path 'C:\ProgramData\ssh') {
  $bak = "C:\ProgramData\ssh.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
  try {
    Copy-Item 'C:\ProgramData\ssh' $bak -Recurse -Force -ErrorAction Stop
    Say "backed up C:\ProgramData\ssh -> $bak"
  } catch { Say "backup failed: $($_.Exception.Message)" }
  try {
    Remove-Item 'C:\ProgramData\ssh' -Recurse -Force -ErrorAction Stop
    Say "removed C:\ProgramData\ssh"
  } catch { Say "FAILED to remove C:\ProgramData\ssh: $($_.Exception.Message)" }
} else {
  Say "C:\ProgramData\ssh already absent"
}

# ---- 6. verify the end state ----
Say ""
Say "--- verification ---"
$sshExe = Join-Path $sysDir 'ssh.exe'
Say "  ssh CLIENT (needed to reach A): $(if(Test-Path $sshExe){'present'}else{'MISSING -- PROBLEM'})"
Say "  sshd service:                   $(if(Get-Service sshd -ErrorAction SilentlyContinue){'PRESENT -- PROBLEM'}else{'absent (correct)'})"
Say "  portable build:                 $(if(Test-Path $portable){'PRESENT -- PROBLEM'}else{'absent (correct)'})"
Say "  ProgramData\ssh:                $(if(Test-Path 'C:\ProgramData\ssh'){'PRESENT -- PROBLEM'}else{'absent (correct)'})"
$agNow = Get-Service ssh-agent -ErrorAction SilentlyContinue
Say "  ssh-agent:                      $(if($agNow){$agNow.Status}else{'absent'})"
Say "  ssh-agent ImagePath:            $((Get-CimInstance Win32_Service -Filter "Name='ssh-agent'" -ErrorAction SilentlyContinue).PathName)"
$stock = Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue
if ($stock) { Say "  built-in port-22 rule:          Enabled=$($stock.Enabled) (must be False)" }
$ts = Get-Service Tailscale -ErrorAction SilentlyContinue
Say "  Tailscale:                      $(if($ts){$ts.Status}else{'MISSING -- PROBLEM'})"

Say ""
Say "=== DONE ==="
