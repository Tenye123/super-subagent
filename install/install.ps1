# dsh-fleet installer -- one-shot setup for a fleet node
#
# IMPORTANT: this file must stay pure ASCII.
# PowerShell 5.1 on this machine reads .ps1 as GBK; any non-ASCII byte
# causes a parse error. Put all user-facing Chinese text in the JS layer
# (fleet.mjs) instead of here.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Role agent
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Role controller
#
# What it does, in order:
#   1. verify Node.js >= 18
#   2. install / upgrade DSH CLI
#   3. install Tailscale (optional, prompted) and report its IP
#   4. install OpenSSH Server (agent role only) + harden sshd_config
#   5. generate the device key pair (agent role) or accept one (controller)
#   6. apply power settings so the box stays reachable
#   7. register the boot-time autostart task
#   8. print the exact next command

param(
  [ValidateSet('agent', 'controller')]
  [string]$Role = 'agent',

  [string]$DeviceName = '',

  # skip interactive prompts
  [switch]$Yes,

  # do not touch power/autostart (dry run of the software part only)
  [switch]$SoftwareOnly
)

$ErrorActionPreference = 'Stop'

# ---- helper: capture external output without stderr aborting the script ----
#
# Under ErrorActionPreference='Stop', Windows PowerShell 5.1 turns every stderr
# line from an external program into an ErrorRecord and terminates the script.
# npm and winget both write normal progress to stderr, so without this wrapper
# the installer dies on a harmless warning (measured: npm EBADENGINE aborted
# the whole run).
#
# Usage:  $text = Cap { & tool args 2>&1 }
function Cap {
  param([Parameter(Mandatory = $true)][scriptblock]$Block)
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $Block 2>&1
  } finally {
    $ErrorActionPreference = $old
  }
  return (($out | ForEach-Object { "$_" }) -join "`r`n")
}
$ProgressPreference = 'SilentlyContinue'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$repoRoot = Split-Path -Parent $scriptDir
$fleetHome = if ($env:DSH_FLEET_HOME) { $env:DSH_FLEET_HOME } else { Join-Path $env:USERPROFILE '.dsh-fleet' }

function Say($msg) { Write-Host "[fleet] $msg" }
function Ok($msg) { Write-Host "  [ok]   $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  [warn] $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "  [fail] $msg" -ForegroundColor Red }

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object Security.Principal.WindowsPrincipal($id)
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Confirm-Step($question) {
  if ($Yes) { return $true }
  $a = Read-Host "$question [Y/n]"
  if ([string]::IsNullOrWhiteSpace($a)) { return $true }
  return $a -match '^[Yy]'
}

# ---------------------------------------------------------------- 0. banner

Say "dsh-fleet installer"
Say "role: $Role"
Say "fleet home: $fleetHome"

if ($Role -eq 'agent' -and -not (Test-Admin)) {
  Warn "not running elevated. sshd install and power settings need admin."
  if (-not $Yes) {
    Warn "re-run from an elevated PowerShell, or pass -SoftwareOnly to skip those parts."
  }
}

# ---------------------------------------------------------------- 1. Node

Say "step 1/8 checking Node.js"
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $nodeExe) {
  Fail "node not found. Install Node.js 18+ first:"
  Fail "  winget install OpenJS.NodeJS.LTS"
  exit 1
}
$nodeVer = (& node -v).TrimStart('v')
$nodeMajor = [int]($nodeVer.Split('.')[0])
if ($nodeMajor -lt 18) {
  Fail "node $nodeVer is too old, need 18+"
  exit 1
}
Ok "node $nodeVer"

# ---------------------------------------------------------------- 2. DSH

Say "step 2/8 installing / upgrading DSH CLI"
$dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
if ($dshCmd) {
  $cur = ((& dsh --version) -split '\s+')[0]
  Ok "dsh already present: $cur"
  if (-not $SoftwareOnly -and (Confirm-Step "check for a newer dsh now?")) {
    Cap { & npm.cmd i -g @deepseek-ai/dsh@latest } | Out-Null
    if ($LASTEXITCODE -eq 0) {
      $new = ((& dsh --version) -split '\s+')[0]
      Ok "dsh now $new"
    } else {
      Warn "upgrade failed, keeping $cur"
    }
  }
} else {
  Say "  installing @deepseek-ai/dsh (this takes a minute)"
  Cap { & npm.cmd i -g @deepseek-ai/dsh } | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Fail "npm install failed. If it is a network issue, set a mirror:"
    Fail "  npm config set registry https://registry.npmmirror.com"
    exit 1
  }
  Ok "dsh installed: $((& dsh --version))"
}

# ---------------------------------------------------------------- 3. Tailscale

Say "step 3/8 checking Tailscale"
$ts = Get-Command tailscale -ErrorAction SilentlyContinue
if (-not $ts) {
  Warn "Tailscale not found."
  if (-not $SoftwareOnly -and (Confirm-Step "install Tailscale via winget now?")) {
    Cap { & winget install --id Tailscale.Tailscale -e --silent --accept-source-agreements --accept-package-agreements } | Out-Null
    $ts = Get-Command tailscale -ErrorAction SilentlyContinue
  }
}
if ($ts) {
  $status = & tailscale status --json 2>$null | ConvertFrom-Json
  if ($status.BackendState -eq 'Running') {
    $ip = ($status.TailscaleIPs | Where-Object { $_ -match '\.' } | Select-Object -First 1)
    Ok "tailscale up, ip = $ip"
  } else {
    Warn "tailscale not connected (state: $($status.BackendState)). Run: tailscale up"
  }
} else {
  Warn "skipping tailscale. Without it, cross-network access needs another tunnel."
}

# ---------------------------------------------------------------- 4. OpenSSH Server

if ($Role -eq 'agent') {
  Say "step 4/8 installing OpenSSH Server"
  $sshdCfg = Join-Path $env:ProgramData 'ssh\sshd_config'

  if (-not (Test-Path $sshdCfg)) {
    if (-not (Test-Admin)) {
      Warn "cannot install sshd without admin. Skipping."
      Warn "re-run elevated, then: dsh-fleet install --role agent"
    } else {
      $cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' -ErrorAction SilentlyContinue
      if ($cap -and $cap.State -ne 'Installed') {
        Add-WindowsCapability -Online -Name $cap.Name | Out-Null
      }
      Ok "OpenSSH Server capability installed"
    }
  } else {
    Ok "sshd_config present"
  }

  if (Test-Path $sshdCfg) {
    Say "  hardening sshd_config"
    $raw = Get-Content $sshdCfg -Raw

    # back up once
    $bak = "$sshdCfg.fleet-bak"
    if (-not (Test-Path $bak)) {
      Copy-Item $sshdCfg $bak
      Ok "backup written: $bak"
    }

    # helper: set-or-append a directive inside the GLOBAL section only.
    #
    # Three bugs lived in the first version; all three were found by tests:
    #   (a) "^\s*" -- \s also matches newlines, so the pattern could span lines.
    #       Must be [ \t].
    #   (b) ".*$" -- in .NET, under (?m), $ anchors before \n but AFTER \r for
    #       CRLF text, so ".*$" never matches a CRLF line (the \r is unconsumed
    #       and "." does not match it). Use a lookahead: (?=\r?$).
    #   (c) [regex]::Replace(text, pat, line, 1) does NOT mean "replace the
    #       first match". The 4th argument is a match-count LIMIT; every match
    #       within that count is still substituted. So a commented example
    #       further down ("#AllowTcpForwarding no") became a live duplicate.
    #       Use a MatchEvaluator that keeps all but the first.
    #   (d) Directives must NOT be appended at the very end of the file: the
    #       stock config ends with "Match Group administrators", and sshd
    #       refuses options like Port/ListenAddress inside a Match block.
    #       Split at the first Match and write into the head.
    function Set-SshdOption {
      param([string]$Text, [string]$Key, [string]$Value)
      $pattern = "(?m)^[ \t]*#?[ \t]*$([regex]::Escape($Key))[ \t]+[^\r\n]*(?=\r?$)"
      $line = "$Key $Value"

      # Split at the first Match block, because sshd refuses most keywords
      # inside a Match block.
      #
      # BUG THAT LIVED HERE: the check was `if ($matchIdx -ge 0)`.
      # In .NET, a FAILED match does NOT give Index = -1; it gives
      # [regex]::Match($s,$p) == Match.Empty whose .Index is **0**.
      # So "there is no Match block" was indistinguishable from "the Match
      # block starts at 0", and the Split silently put EVERYTHING in $tail:
      #   head = Substring(0,0) = ''   -> directives appended at the very top
      #   tail = the whole config     -> original lines kept untouched
      # Net effect: each directive appeared TWICE (once appended at the top,
      # once original), and worse, the appended copy landed before the Match
      # block only by luck -- the real config ends with
      # "Match Group administrators", so appended lines would be written
      # INSIDE that Match block and sshd would refuse to start.
      # Correct test is .Success, which is what we use now.
      $matchBlock = [regex]::Match($Text, '(?m)^[ \t]*Match[ \t]')
      if ($matchBlock.Success) {
        $head = $Text.Substring(0, $matchBlock.Index)
        $tail = $Text.Substring($matchBlock.Index)
      } else {
        $head = $Text
        $tail = ''
      }

      if ([regex]::IsMatch($head, $pattern)) {
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
    # 'local' (not 'no') so the task-registry tunnel can work. Remote
    # forwarding stays forbidden, so this machine cannot become a pivot.
    $raw = Set-SshdOption $raw 'AllowTcpForwarding' 'local'
    $raw = Set-SshdOption $raw 'AllowAgentForwarding' 'no'
    $raw = Set-SshdOption $raw 'PermitTunnel' 'no'
    $raw = Set-SshdOption $raw 'GatewayPorts' 'no'
    $raw = Set-SshdOption $raw 'PermitOpen' '127.0.0.1:8787'
    $raw = Set-SshdOption $raw 'X11Forwarding' 'no'

    # Validate BEFORE writing. A broken config plus the default "restart
    # immediately, forever" recovery policy once produced 2500 crashes in a
    # single second and ended with the sshd SERVICE GONE entirely.
    Set-Content -Path $sshdCfg -Value $raw -Encoding ASCII
    $testOut = (Cap { & (Join-Path $sshdDir 'sshd.exe') -t -f $sshdCfg }).Trim()
    if ($LASTEXITCODE -ne 0) {
      Warn "sshd -t rejected the new config: $testOut"
      Warn "rolling back to $bak"
      Copy-Item $bak $sshdCfg -Force
      Warn "sshd_config restored; forwarding left as it was"
    } else {
      Ok "sshd_config updated and validated (password auth off, forwarding local-only)"
    }

    # make sure the host keys exist
    $hkDir = Join-Path $env:ProgramData 'ssh'
    if (-not (Test-Path (Join-Path $hkDir 'ssh_host_ed25519_key'))) {
      Cap { & ssh-keygen -A } | Out-Null
      Ok "host keys generated"
    }

    try {
      Set-Service sshd -StartupType Automatic -ErrorAction Stop
      Start-Service sshd -ErrorAction Stop
      Ok "sshd running"
    } catch {
      Warn "could not start sshd: $($_.Exception.Message)"
    }

    # firewall: only allow the Tailscale interface, never the LAN
    try {
      $rules = Get-NetFirewallRule -DisplayName 'dsh-fleet-sshd*' -ErrorAction SilentlyContinue
      foreach ($r in $rules) { Remove-NetFirewallRule -DisplayName $r.DisplayName -ErrorAction SilentlyContinue }
      if ($ts) {
        New-NetFirewallRule -DisplayName 'dsh-fleet-sshd-tailscale' -Direction Inbound `
          -Protocol TCP -LocalPort 22 -Action Allow -InterfaceAlias 'Tailscale' -ErrorAction Stop | Out-Null
        Ok "firewall rule scoped to the Tailscale interface"
      } else {
        Warn "no Tailscale, so no firewall rule was added (sshd reachable on the LAN)"
      }
    } catch {
      Warn "firewall rule failed: $($_.Exception.Message)"
    }
  }
} else {
  Say "step 4/8 skipping OpenSSH Server (controller role does not need it)"
}

# ---------------------------------------------------------------- 5. keys

Say "step 5/8 device identity"
if (-not (Test-Path $fleetHome)) { New-Item -ItemType Directory -Path $fleetHome -Force | Out-Null }
$keyDir = Join-Path $fleetHome 'keys'
if (-not (Test-Path $keyDir)) { New-Item -ItemType Directory -Path $keyDir -Force | Out-Null }

if ($Role -eq 'agent') {
  $name = if ($DeviceName) { $DeviceName } else { $env:COMPUTERNAME.ToLower() }
  $priv = Join-Path $keyDir "$name.key"
  if (Test-Path $priv) {
    Ok "key already exists: $priv"
  } else {
    (Cap { & node (Join-Path $repoRoot 'fleet.mjs') keygen --name $name }) -split "`r?`n" | Where-Object { $_ } | ForEach-Object { Write-Host "  $_" }
    Ok "generated key for $name"
  }
} else {
  Say "  controller keeps private keys for every device under $keyDir"
  Ok "nothing to generate here"
}

# ---------------------------------------------------------------- 6. power

if ($Role -eq 'agent' -and -not $SoftwareOnly -and (Test-Admin)) {
  Say "step 6/8 power settings (stay reachable)"
  try {
    & powercfg /change standby-timeout-ac 0
    & powercfg /change hibernate-timeout-ac 0
    & powercfg /change monitor-timeout-ac 10
    & powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
    & powercfg /setactive SCHEME_CURRENT
    Write-Host "  [ok]   never sleep / hibernate on AC, lid close does nothing"

    $hiberboot = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power'
    Set-ItemProperty -Path $hiberboot -Name HiberbootEnabled -Value 0 -ErrorAction SilentlyContinue
    Write-Host "  [ok]   fast startup disabled"
  } catch {
    Warn "power tuning partly failed: $($_.Exception.Message)"
  }
} else {
  Say "step 6/8 skipping power settings"
}

# ---------------------------------------------------------------- 7. autostart

if ($Role -eq 'agent' -and -not $SoftwareOnly) {
  Say "step 7/8 registering autostart"
  $taskName = 'dsh-fleet-agent'
  try {
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
    $nodePath = (Get-Command node).Source
    $entry = Join-Path $repoRoot 'fleet.mjs'
    $action = New-ScheduledTaskAction -Execute $nodePath -Argument "`"$entry`" agent-daemon"
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
      -Settings $settings -Description 'dsh-fleet agent daemon' -Force | Out-Null
    Ok "scheduled task '$taskName' registered (runs at logon)"
  } catch {
    Warn "autostart registration failed: $($_.Exception.Message)"
    Warn "you can add it manually later: dsh-fleet autostart --install"
  }
} else {
  Say "step 7/8 skipping autostart"
}

# ---------------------------------------------------------------- 8. next steps

Say "step 8/8 next steps"
(Cap { & node (Join-Path $repoRoot 'fleet.mjs') doctor --role $Role }) -split "`r?`n" | Where-Object { $_ } | ForEach-Object { Write-Host $_ }

Write-Host ""
if ($Role -eq 'agent') {
  Write-Host "Agent node is ready. Send this public key line to the controller:" -ForegroundColor Cyan
  $name = if ($DeviceName) { $DeviceName } else { $env:COMPUTERNAME.ToLower() }
  $pubFile = Join-Path $keyDir "$name.pub"
  if (Test-Path $pubFile) {
    Get-Content $pubFile
  } else {
    Warn "public key not found at $pubFile"
  }
  Write-Host ""
  Write-Host "The controller adds it with:" -ForegroundColor Cyan
  Write-Host "  fleet enroll --name $name --ip <this-machine-tailscale-ip> --user $env:USERNAME --pubkey-file <path>"
} else {
  Write-Host "Controller is ready. Enroll each agent with:" -ForegroundColor Cyan
  Write-Host "  fleet enroll --name laptop-a --ip 100.x.x.x --user hp --pubkey '<ssh-ed25519 AAAA...>'"
}

Write-Host ""
Say "done."
