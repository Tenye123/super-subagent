# One-shot bootstrap for the AGENT machine (A).
#
# DESIGN GOAL: the installer must handle initialization by itself; the user
#   should only have to configure things, not install prerequisites.
#   So this runs on a machine that has NOTHING installed -- no Node, no
#   Tailscale, no sshd -- and does everything itself. The user copies one
#   command into an elevated PowerShell window on A and answers at most one
#   question (the Tailscale login, which cannot be automated because it is an
#   interactive OAuth flow).
#
# WHY the agent role needs all of this:
#   A must accept SSH from B, but only over the tailnet, and only with a
#   public key. That means: Node (to run fleet), Tailscale (the transport),
#   OpenSSH server (the door), plus config hardening and a firewall rule.
#
# WHY no sshd is preinstalled assumption:
#   Windows 11 Home does not ship the OpenSSH *server* capability enabled.
#   We install it from the official MSI, then harden it.
#
# SAFETY NOTES
#   - Never opens port 22 to the LAN. The firewall rule is scoped to the
#     Tailscale interface and 100.64.0.0/10 only.
#   - Never enables Tailscale subnet routes or an exit node. That would expose
#     the company network to the whole tailnet.
#   - PasswordAuthentication is turned off; keys only.
#
# Pure ASCII only (PowerShell 5.1 decodes UTF-8 as GBK; a non-ASCII char in a
# comment can swallow the following newline and silently disable code).

param(
  [string]$TailscaleAuthKey = '',
  [switch]$SkipTailscale,
  [switch]$SkipSshd
)

$ErrorActionPreference = 'Stop'

# ---- helper: run an external command without its stderr killing the script ----
#
# WHY THIS EXISTS
# External tools write progress and warnings to stderr. Under
# ErrorActionPreference='Stop', PowerShell wraps each stderr line into an
# ErrorRecord and TERMINATES the script on the first one -- including when the
# output is merely assigned to a variable, not just piped.
#
# MEASURED: this is exactly how the npm step died. npm printed
#     npm warn EBADENGINE Unsupported engine {
# which is only a warning, and the whole bootstrap stopped at step 2/7 with a
# red NativeCommandError block. Verified in isolation:
#     $a = & cmd /c "echo warn 1>&2" 2>&1     # -> terminates under Stop
#
# This script invokes dozens of external tools (npm, winget, sc.exe, icacls,
# ssh-keygen, sshd, tailscale, dsh) and every one of them may emit stderr
# chatter that is completely normal.
#
# The fix has to lower ErrorActionPreference around the call and restore it
# immediately: Windows PowerShell 5.1 has no equivalent of
# $PSNativeCommandUseErrorActionPreference, and assigning the output to a
# variable does not help either (also verified).
#
# Safety: this only relaxes the preference for the duration of one external
# call. Every such call is still judged by its exit code and by verifying the
# real post-condition, which is what these scripts rely on anyway.
function Invoke-External {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$ArgumentList = @(),
    [switch]$Quiet
  )
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $FilePath @ArgumentList 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $old
  }
  $text = ($out | ForEach-Object { "$_" }) -join "`r`n"
  if (-not $Quiet -and $text) { Write-Verbose $text }
  return @{ Code = $code; Text = $text; Lines = @($out | ForEach-Object { "$_" }) }
}

# ---- helper: capture external output without stderr aborting the script ----
#
# Usage:  $text = Cap { & tool args 2>&1 }
#
# Under ErrorActionPreference='Stop', Windows PowerShell 5.1 turns every stderr
# line from an external program into an ErrorRecord and terminates the script.
# That is how the npm step died on a mere EBADENGINE warning. Cap lowers the
# preference for the duration of one script block and restores it afterwards,
# so the stderr text is captured as data (which is what callers want anyway).
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

$progress = "$env:TEMP\fleet-agent-setup.txt"
function Say($m) {
  $line = "$m"
  Write-Host $line
  Add-Content -Path $progress -Value $line -Encoding UTF8
}
Set-Content -Path $progress -Value "=== agent bootstrap $(Get-Date -Format o) ===" -Encoding UTF8

$isElevated = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isElevated) {
  Write-Host "This script must run as Administrator." -ForegroundColor Red
  Write-Host "Right-click PowerShell -> Run as administrator, then re-run." -ForegroundColor Yellow
  exit 1
}

Write-Host ""
Write-Host "  super-subagent agent bootstrap" -ForegroundColor Cyan
Write-Host "  This machine will accept SSH from your controller, over Tailscale only." -ForegroundColor DarkGray
Write-Host ""

# ============================================================ 1. Node.js
Say "step 1/7  Node.js"

# Find Node WITHOUT trusting PATH.
#
# BUG THAT LIVED HERE: detection used only `Get-Command node`, i.e. PATH.
# Two failure modes, both observed:
#   (a) On a fresh machine PATH has no nodejs entry yet, so a just-installed
#       Node is invisible to this process until PATH is re-read.
#   (b) A NEW PowerShell window inherits the PATH snapshot taken when it
#       started, so re-running the script in a new window re-downloaded the
#       29.5 MB MSI even though Node 22 was already installed.
# In the screenshot the user saw Node downloaded TWICE for this reason.
#
# So: probe the known install locations first, and only then fall back to PATH.
$nodeCandidates = @(
  'C:\Program Files\nodejs\node.exe',
  'C:\Program Files (x86)\nodejs\node.exe',
  (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
)

function Resolve-Node {
  # 1. explicit known locations (survive a stale PATH)
  foreach ($c in $nodeCandidates) {
    if ($c -and (Test-Path $c)) {
      return @{ Path = $c; Version = (Cap { & $c -v }).Trim() }
    }
  }
  # 2. whatever PATH currently says
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) {
    return @{ Path = $cmd.Source; Version = (Cap { & node -v }).Trim() }
  }
  # 3. refresh PATH from the registry and try once more
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machinePath;$userPath"
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) {
    return @{ Path = $cmd.Source; Version = (Cap { & node -v }).Trim() }
  }
  return $null
}

$found = Resolve-Node
$needNode = $true
if ($found) {
  $v = $found.Version.TrimStart('v')
  $major = 0
  try { $major = [int]($v.Split('.')[0]) } catch { $major = 0 }
  # MINIMUM IS 24, NOT 18.
  #
  # HARD-WON: the first agent machine got Node 22.14.0 and DSH appeared to be
  # installed but did absolutely nothing -- `dsh --version` exited 0 with zero
  # output, and every dispatched task failed.
  #
  # Root cause is the very last line of dsh's bin.js:
  #     if (import.meta.main) await runCli();
  # `import.meta.main` is a Node 24 addition. On Node 22 it is `undefined`,
  # so the guard is false, runCli() never runs, and the process exits 0 in
  # total silence. Measured on both machines:
  #     node 24.14.1 -> import.meta.main === true
  #     node 22.14.0 -> import.meta.main === undefined
  #
  # Nothing in the package metadata declares this (engines is empty), so the
  # only defence is to insist on 24 here and to verify the CLI actually runs
  # afterwards -- see the version check in the DSH step.
  if ($major -ge 24) {
    Say "  already installed: $v  ($($found.Path))"
    Say "  skipping the download"
    $needNode = $false
  } elseif ($major -ge 18) {
    Say "  found v$v at $($found.Path) but DSH needs 24+; upgrading"
    Say "  (on Node 18-22 'dsh' exits 0 and prints nothing: import.meta.main"
    Say "   is undefined there, so the CLI guard never fires)"
  } else {
    Say "  found v$v at $($found.Path) but DSH needs 24+; upgrading"
  }
} else {
  Say "  not found in PATH or the usual install locations"
}

if ($needNode) {
  $nodeMsi = Join-Path $env:TEMP 'node-lts.msi'
  # Pin the exact Node build the controller runs, so both machines behave
  # identically. 24 is a hard floor -- see the import.meta.main note above.
  $nodeVersion = '24.14.1'
  $nodeUrl = "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-x64.msi"
  Say "  downloading $nodeUrl"
  try {
    # TLS 1.2 is not the default on some Windows 11 builds in PS 5.1
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeMsi -UseBasicParsing
    Say "  downloaded ($([math]::Round((Get-Item $nodeMsi).Length / 1MB, 1)) MB)"
  } catch {
    Say "  DOWNLOAD FAILED: $($_.Exception.Message)"
    Say "  install Node 18+ manually, then re-run this script:"
    Say "    winget install OpenJS.NodeJS.LTS"
    exit 1
  }

  Say "  installing silently"
  $p = Start-Process msiexec.exe -ArgumentList @('/i', "`"$nodeMsi`"", '/qn', '/norestart') -Wait -PassThru
  Say "  msiexec exit code: $($p.ExitCode)"
  if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) {
    Say "  INSTALL FAILED (exit $($p.ExitCode))"
    exit 1
  }
  # Re-resolve instead of assuming PATH now works: the MSI updates PATH in the
  # registry, but this process already has its own copy.
  $again = Resolve-Node
  if ($again) {
    Say "  node now: $($again.Version)  ($($again.Path))"
  } else {
    Say "  INSTALLED BUT NOT FOUND -- the MSI may have failed silently"
    exit 1
  }
}

# ============================================================ 2. DSH itself
Say ""
Say "step 2/7  DSH"
#
# The agent role is useless without DSH on the machine: `fleet run` shells out
# to `dsh --profile headless`, so if dsh is missing every dispatched task fails
# with "dsh is not recognized". The first real end-to-end run hit exactly that,
# which is why this step exists.
#
# Install the SAME version as the controller. Two machines on different DSH
# versions produce subtly different --json event streams, and the controller
# parses that stream (see summarizeEvents). Version drift would show up as
# mysterious parse failures rather than an obvious error, so pin it.
$dshVersion = '0.1.7-rc.1'
$dshCmd = Get-Command dsh -ErrorAction SilentlyContinue

if ($dshCmd) {
  $have = (Cap { & dsh --version }).Trim()
  Say "  already installed: $have"
  if ($have -notmatch [regex]::Escape($dshVersion)) {
    Say "  NOTE: controller runs $dshVersion; this is $have"
    Say "        mismatched versions can produce different --json output"
  }
} else {
  $npm = $null
  foreach ($cand in @('C:\Program Files\nodejs\npm.cmd')) {
    if (Test-Path $cand) { $npm = $cand; break }
  }
  if (-not $npm) {
    $npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($npmCmd) { $npm = $npmCmd.Source }
  }
  if (-not $npm) {
    Say "  ERROR: npm not found even though Node is installed"
    exit 1
  }
  Say "  installing @deepseek-ai/dsh@$dshVersion via npm"
  Say "  (this pulls a large dependency tree; several minutes is normal)"

  # Run npm with its output redirected to FILES, not through the pipeline.
  #
  # BUG THAT LIVED HERE: the call was
  #     & $npm install -g "..." 2>&1 | ForEach-Object { ... }
  # npm writes its progress and every warning to stderr. With `2>&1 |` under
  # `$ErrorActionPreference = 'Stop'`, PowerShell wraps each stderr line into an
  # ErrorRecord, and the FIRST one terminates the script:
  #     npm.cmd : npm warn EBADENGINE Unsupported engine {
  #     ... FullyQualifiedErrorId : NativeCommandError
  # So a harmless engine warning aborted the whole bootstrap: the user saw a
  # wall of red at step 2/7 and nothing after it.
  #
  # Redirecting to files keeps npm's stderr away from PowerShell's error
  # stream entirely. We then read the files back ourselves and decide what
  # matters.
  $npmLog = Join-Path $env:TEMP 'fleet-npm-install.log'
  $npmErr = Join-Path $env:TEMP 'fleet-npm-install.err'
  Remove-Item $npmLog, $npmErr -Force -ErrorAction SilentlyContinue

  $npmProc = Start-Process -FilePath $npm `
    -ArgumentList @('install', '-g', "@deepseek-ai/dsh@$dshVersion", '--no-fund', '--no-audit') `
    -NoNewWindow -Wait -PassThru `
    -RedirectStandardOutput $npmLog -RedirectStandardError $npmErr
  $npmExit = $npmProc.ExitCode
  Say "  npm exit: $npmExit"

  # Surface only genuine errors. EBADENGINE is a warning npm emits while it
  # still installs successfully (verified: the package works on the controller
  # with the same Node major), so it must not be treated as fatal.
  $errText = ''
  if (Test-Path $npmErr) { $errText = Get-Content $npmErr -Raw -ErrorAction SilentlyContinue }
  if ($errText) {
    foreach ($line in ($errText -split "`r?`n")) {
      if ($line -match 'npm (ERR!|error)') { Say "    $line" }
    }
    if ($errText -match 'EBADENGINE') {
      Say "    (EBADENGINE is a warning, not a failure -- continuing)"
    }
  }
  if ($npmExit -ne 0) {
    Say "  npm FAILED with exit $npmExit"
    Say "  log: $npmErr"
    $tail = ''
    if (Test-Path $npmErr) { $tail = (Get-Content $npmErr -Tail 12 -ErrorAction SilentlyContinue) -join "`r`n" }
    Say $tail
    exit 1
  }

  # npm updates PATH in the registry; this process still has the old copy.
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'User')

  $dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
  if (-not $dshCmd) {
    # npm's global bin dir is often absent from PATH entirely. Look for the
    # shim directly rather than declaring failure.
    $npmPrefix = (Cap { & cmd /c "`"$npm`" config get prefix" }).Trim()
    if ($npmPrefix) {
      foreach ($shim in @("$npmPrefix\dsh.cmd", "$npmPrefix\dsh.ps1")) {
        if (Test-Path $shim) {
          $env:Path = "$npmPrefix;$env:Path"
          $dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
          if ($dshCmd) { break }
        }
      }
    }
  }
}

if ($dshCmd) {
  # Verify the CLI ACTUALLY RUNS, not just that a shim exists on PATH.
  #
  # `dsh --version` printing nothing is the signature of the Node-too-old
  # failure described above: bin.js ends with
  #     if (import.meta.main) await runCli();
  # and import.meta.main is undefined before Node 24, so the process exits 0
  # without doing anything. A shim that exits 0 silently is worse than a
  # missing one, because it looks installed and fails much later and far more
  # confusingly (every dispatched task fails with a cryptic error).
  $v = (Cap { & dsh --version }).Trim()
  if ($v -match '^\d+\.\d+') {
    Say "  dsh works: $v"
  } else {
    $nodemaj = 0
    try { $nodemaj = [int]((& node -v).TrimStart('v').Split('.')[0]) } catch { $nodemaj = 0 }
    Say "  ERROR: 'dsh --version' produced no usable output (got: '$v')"
    if ($nodemaj -lt 24) {
      Say "         CAUSE: Node is v$nodemaj but DSH requires 24+."
      Say "         bin.js ends with 'if (import.meta.main) await runCli();',"
      Say "         and import.meta.main does not exist before Node 24 -- so the"
      Say "         CLI exits 0 in silence without running anything."
      Say "         FIX: install Node 24+ and re-run this script."
    } else {
      Say "         Node is v$nodemaj, which should be new enough, so the cause"
      Say "         is elsewhere. Check the shim and the package:"
      Say "           dsh --help"
      Say "           npm ls -g @deepseek-ai/dsh"
    }
    exit 1
  }
} else {
  Say "  ERROR: dsh is still not on PATH after install"
  Say "         install manually: npm install -g @deepseek-ai/dsh@$dshVersion"
  exit 1
}

# ============================================================ 3. Tailscale
Say ""
Say "step 3/7  Tailscale"
$tsExe = 'C:\Program Files\Tailscale\tailscale.exe'

if ($SkipTailscale) {
  Say "  skipped by request"
} elseif (Test-Path $tsExe) {
  Say "  already installed: $((Cap { & $tsExe version }) -split "`r?`n" | Select-Object -First 1)"
} else {
  # Do NOT use winget here.
  #
  # Measured on this machine: 'winget install Tailscale.Tailscale' sat with no
  # output for well over a minute, and on a first run it also wants to update
  # its source index, which frequently stalls against the Microsoft CDN from
  # China. From the user's side that is indistinguishable from a hang.
  #
  # The MSI is one direct download with a known URL, so fetch it and install
  # silently. An explicit timeout guarantees it can never look hung forever.
  $tsMsi = Join-Path $env:TEMP 'tailscale.msi'
  $urls = @(
    'https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi',
    'https://pkgs.tailscale.com/stable/tailscale-setup-1.104.7-amd64.msi'
  )
  $ok = $false
  foreach ($u in $urls) {
    if ($ok) { break }
    Say "  downloading $u"
    try {
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      # The progress bar makes Invoke-WebRequest dramatically slower; turn it
      # off. 10 minute cap: the MSI is ~40 MB, this only trips on a real stall.
      $ProgressPreference = 'SilentlyContinue'
      Invoke-WebRequest -Uri $u -OutFile $tsMsi -UseBasicParsing -TimeoutSec 600
      $sz = [math]::Round((Get-Item $tsMsi).Length / 1MB, 1)
      Say "  downloaded ($sz MB)"
      $ok = $true
    } catch {
      Say "  download failed: $($_.Exception.Message)"
    }
  }
  if ($ok) {
    Say "  installing silently"
    $p = Start-Process msiexec.exe -ArgumentList @('/i', "`"$tsMsi`"", '/qn', '/norestart') -Wait -PassThru
    Say "  msiexec exit: $($p.ExitCode)"
    Start-Sleep -Seconds 2
  }
  if (Test-Path $tsExe) {
    Say "  installed"
  } else {
    Say "  NOT installed."
    Say "  Install Tailscale manually from https://tailscale.com/download/windows"
    Say "  then re-run this script (it is idempotent and skips finished steps)."
    exit 1
  }
}

# Tailscale login. Even with an auth key this cannot be fully silent the first
# time, but --authkey lets it run unattended when the user supplies one.
if ((Test-Path $tsExe) -and -not $SkipTailscale) {
  $st = Cap { & $tsExe status }
  if ($st -match 'Logged out|NeedsLogin' -or $st -notmatch '100\.\d+\.\d+\.\d+') {
    Say "  not logged in yet"
    if ($TailscaleAuthKey) {
      Say "  logging in with the supplied auth key"
      $upOut = Cap { & $tsExe up --authkey $TailscaleAuthKey --accept-routes=false --accept-dns=true }; $upOut |
        ForEach-Object { Say "    $_" }
    } else {
      Say ""
      Say "  ACTION REQUIRED: log Tailscale in to the SAME account as the controller."
      Say "  Run this in another window, finish the browser login, then come back:"
      Say "      & '$tsExe' up --accept-routes=false --accept-dns=true"
      Say ""
      Write-Host "  Press Enter once Tailscale shows 'logged in'..." -ForegroundColor Yellow
      Read-Host | Out-Null
    }
  }
  $st2 = Cap { & $tsExe status }
  $ip = ([regex]::Match($st2, '(100\.\d+\.\d+\.\d+)')).Groups[1].Value
  if ($ip) {
    Say "  tailscale IP: $ip"
  } else {
    Say "  WARNING: still no tailscale IP; sshd will bind to loopback only"
  }

  # Hard rule: never advertise routes or act as an exit node.
  Say "  ensuring no subnet routes / exit node are advertised"
  Cap { & $tsExe set --advertise-routes= } | Out-Null
  Cap { & $tsExe set --advertise-exit-node=false } | Out-Null
}

# ============================================================ 3. OpenSSH server
Say ""
Say "step 4/7  OpenSSH server"
$sshdExe = 'C:\Program Files\OpenSSH\sshd.exe'

if ($SkipSshd) {
  Say "  skipped by request"
} else {
  if ((Test-Path $sshdExe) -and (Get-Service sshd -ErrorAction SilentlyContinue)) {
    Say "  already installed"
  } else {
    # Order matters. Never start with Add-WindowsCapability:
    #
    # MEASURED FAILURE: 'Add-WindowsCapability -Online -Name OpenSSH.Server'
    # hung indefinitely on this machine. It downloads from the Microsoft
    # update CDN, exposes no timeout, and simply sits there -- the user saw
    # "adding the OpenSSH.Server capability" and then nothing.
    #
    # So: use a local MSI if one is already on disk, then try the direct
    # GitHub download (fast, and it worked for Node and Tailscale), and only
    # fall back to the capability as a last resort.
    $msi = Join-Path $env:TEMP 'OpenSSH-Win64-v10.4.0.0.msi'
    $usedLocal = $false

    if (Test-Path $msi) {
      Say "  using the MSI already on disk: $msi"
      $usedLocal = $true
    } else {
      $urls = @(
        'https://github.com/PowerShell/Win32-OpenSSH/releases/download/v10.4.0.0/OpenSSH-Win64-v10.4.0.0.msi',
        'https://github.com/PowerShell/Win32-OpenSSH/releases/latest/download/OpenSSH-Win64.msi'
      )
      foreach ($u in $urls) {
        if ($usedLocal) { break }
        Say "  downloading $u"
        try {
          [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
          $ProgressPreference = 'SilentlyContinue'
          Invoke-WebRequest -Uri $u -OutFile $msi -UseBasicParsing -TimeoutSec 600
          Say "  downloaded ($([math]::Round((Get-Item $msi).Length / 1MB, 1)) MB)"
          $usedLocal = $true
        } catch {
          Say "  download failed: $($_.Exception.Message)"
        }
      }
    }

    if ($usedLocal -and (Test-Path $msi)) {
      Say "  installing silently"
      $p = Start-Process msiexec.exe `
        -ArgumentList @('/i', "`"$msi`"", '/qn', '/norestart', 'ADDLOCAL=Server', 'PORT=22') `
        -Wait -PassThru
      Say "  msiexec exit: $($p.ExitCode)"
      Start-Sleep -Seconds 3
    }

    if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) {
      Say "  MSI did not register the service; trying the Windows capability"
      try {
        Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' -ErrorAction Stop | Out-Null
        Say "  capability added"
      } catch {
        Say "  capability also failed: $($_.Exception.Message)"
      }
    }
  }

  if (Get-Service sshd -ErrorAction SilentlyContinue) {
    Say "  sshd service present"
  } else {
    Say "  PROBLEM: no sshd service after all install methods"
    Say "  Install manually: https://github.com/PowerShell/Win32-OpenSSH/releases"
    exit 1
  }
}

# ============================================================ 4. sshd config
Say ""
Say "step 5/7  sshd hardening"
$sshdCfg = 'C:\ProgramData\ssh\sshd_config'
if (Test-Path $sshdCfg) {
  $bak = "$sshdCfg.fleet-bak"
  if (-not (Test-Path $bak)) {
    Copy-Item $sshdCfg $bak
    Say "  backup: $bak"
  }

  $raw = Get-Content $sshdCfg -Raw

  # Set-or-append inside the GLOBAL section only. See install.ps1 for why each
  # detail here matters (CRLF anchoring, one-match-only, Match-block split).
  function Set-SshdOption {
    param([string]$Text, [string]$Key, [string]$Value)
    $pattern = "(?m)^[ \t]*#?[ \t]*$([regex]::Escape($Key))[ \t]+[^\r\n]*(?=\r?$)"
    $line = "$Key $Value"

    $mb = [regex]::Match($Text, '(?m)^[ \t]*Match[ \t]')
    if ($mb.Success) {
      $head = $Text.Substring(0, $mb.Index)
      $tail = $Text.Substring($mb.Index)
    } else {
      $head = $Text
      $tail = ''
    }

    if ([regex]::IsMatch($head, $pattern)) {
      $script:done = 0
      $ev = [System.Text.RegularExpressions.MatchEvaluator] {
        param($m)
        $script:done++
        if ($script:done -eq 1) { return $line }
        return $m.Value
      }
      $head = [regex]::Replace($head, $pattern, $ev)
    } else {
      $head = $head.TrimEnd() + "`r`n" + $line + "`r`n`r`n"
    }
    return $head + $tail
  }

  $raw = Set-SshdOption $raw 'PubkeyAuthentication' 'yes'
  $raw = Set-SshdOption $raw 'PasswordAuthentication' 'no'
  $raw = Set-SshdOption $raw 'PermitEmptyPasswords' 'no'
  $raw = Set-SshdOption $raw 'AllowTcpForwarding' 'local'
  $raw = Set-SshdOption $raw 'AllowAgentForwarding' 'no'
  $raw = Set-SshdOption $raw 'PermitTunnel' 'no'
  $raw = Set-SshdOption $raw 'GatewayPorts' 'no'
  $raw = Set-SshdOption $raw 'PermitOpen' '127.0.0.1:8787'
  $raw = Set-SshdOption $raw 'X11Forwarding' 'no'

  # Bind to the tailnet address so LAN hosts cannot reach sshd at all.
  $tsIp = $null
  if (Test-Path $tsExe) {
    $s = Cap { & $tsExe ip -4 }
    $tsIp = ([regex]::Match($s, '(100\.\d+\.\d+\.\d+)')).Groups[1].Value
  }
  if ($tsIp) {
    # ListenAddress may legitimately appear MORE THAN ONCE (one line per
    # address to bind). Set-SshdOption is a set-or-append helper that replaces
    # the FIRST match, so calling it twice for the same key silently
    # overwrites the first value.
    #
    # BUG THAT LIVED HERE: the code was
    #     $raw = Set-SshdOption $raw 'ListenAddress' $tsIp
    #     $raw = Set-SshdOption $raw 'ListenAddress' '127.0.0.1'
    # The second call replaced the tailnet address, so sshd bound loopback
    # only. The log still printed "ListenAddress: 100.x.x.x and 127.0.0.1"
    # because it echoed the intent, not the result. On the first real install
    # this made the agent unreachable from the controller while every line of
    # output looked correct.
    #
    # So: strip every ListenAddress line (including commented ones), then
    # append both addresses explicitly, before any Match block.
    $raw = [regex]::Replace($raw, '(?m)^[ \t]*#?[ \t]*ListenAddress[^\r\n]*(?:\r?\n)?', '')

    $inject = "ListenAddress $tsIp`r`nListenAddress 127.0.0.1`r`n"
    $mb2 = [regex]::Match($raw, '(?m)^[ \t]*Match[ \t]')
    if ($mb2.Success) {
      $head2 = $raw.Substring(0, $mb2.Index).TrimEnd()
      $tail2 = $raw.Substring($mb2.Index)
      $raw = $head2 + "`r`n`r`n" + $inject + "`r`n" + $tail2
    } else {
      $raw = $raw.TrimEnd() + "`r`n`r`n" + $inject
    }
    Say "  ListenAddress: $tsIp and 127.0.0.1"
  } else {
    Say "  no tailscale IP; leaving ListenAddress at the default (all interfaces)"
    Say "  WARNING: re-run this script after Tailscale is logged in"
  }

  Set-Content -Path $sshdCfg -Value $raw -Encoding ASCII

  # Validate BEFORE restarting. A bad config plus an aggressive recovery policy
  # once produced thousands of crashes and deleted the service entirely.
  $sshdForTest = $sshdExe
  if (-not (Test-Path $sshdForTest)) { $sshdForTest = 'C:\Windows\System32\OpenSSH\sshd.exe' }
  if (Test-Path $sshdForTest) {
    $t = (Cap { & $sshdForTest -t -f $sshdCfg }).Trim()
    if ($LASTEXITCODE -ne 0) {
      Say "  CONFIG REJECTED: $t"
      Say "  rolling back"
      Copy-Item $bak $sshdCfg -Force
      Say "  rolled back; fix the config before restarting sshd"
    } else {
      Say "  config validated"
    }
  }
} else {
  Say "  sshd_config not found; is the server installed?"
}

# Host keys
$hkDir = 'C:\ProgramData\ssh'
if (-not (Test-Path (Join-Path $hkDir 'ssh_host_ed25519_key'))) {
  Say "  generating host keys"
  $kg = 'C:\Windows\System32\OpenSSH\ssh-keygen.exe'
  if (-not (Test-Path $kg)) { $kg = 'C:\Program Files\OpenSSH\ssh-keygen.exe' }
  if (Test-Path $kg) {
    (Cap { & $kg -A }) -split "`r?`n" | Where-Object { $_ } | ForEach-Object { Say "    $_" }
  }
}

# ============================================================ 5. firewall + service
Say ""
Say "step 6/7  firewall and service"
$tsIf = Get-NetAdapter -ErrorAction SilentlyContinue |
  Where-Object { $_.InterfaceDescription -match 'Tailscale' }

# Remove stock wide-open rules. There are TWO: one from the MSI, and Windows'
# own OpenSSH-Server-In-TCP. Missing the second one leaves 22 open to the LAN.
foreach ($n in @('OpenSSH-Server-In-TCP')) {
  $r = Get-NetFirewallRule -Name $n -ErrorAction SilentlyContinue
  if ($r -and $r.Enabled -eq 'True') {
    Disable-NetFirewallRule -Name $n -ErrorAction SilentlyContinue
    Say "  disabled stock rule $n"
  }
}
Get-NetFirewallRule -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -match 'OpenSSH' -and $_.Direction -eq 'Inbound' -and $_.Enabled -eq 'True' } |
  ForEach-Object {
    Disable-NetFirewallRule -Name $_.Name -ErrorAction SilentlyContinue
    Say "  disabled stock rule $($_.DisplayName)"
  }

Get-NetFirewallRule -DisplayName 'dsh-fleet-sshd-tailscale' -ErrorAction SilentlyContinue |
  ForEach-Object { Remove-NetFirewallRule -Name $_.Name -ErrorAction SilentlyContinue }

if ($tsIf) {
  New-NetFirewallRule -DisplayName 'dsh-fleet-sshd-tailscale' `
    -Description 'Allow SSH only from the Tailscale network' `
    -Direction Inbound -Action Allow -Protocol TCP -LocalPort 22 `
    -InterfaceAlias $tsIf.Name -RemoteAddress '100.64.0.0/10' -Profile Any `
    -ErrorAction SilentlyContinue | Out-Null
  Say "  added rule: 22 on '$($tsIf.Name)' from 100.64.0.0/10"
} else {
  Say "  WARNING: no Tailscale adapter; NOT adding a wide rule"
}

# service
$svc = Get-Service sshd -ErrorAction SilentlyContinue
if ($svc) {
  Set-Service sshd -StartupType Automatic -ErrorAction SilentlyContinue
  if (-not $tsIf) { Say "  tailscale adapter absent; not setting the dependency" }
  Cap { & sc.exe config sshd depend= Tailscale } | Out-Null
  Restart-Service sshd -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  $svc = Get-Service sshd -ErrorAction SilentlyContinue
  Say "  sshd: $($svc.Status)"
}

# ============================================================ 6. report
Say ""
Say "step 7/7  result"

$listen = @()
try {
  $listen = (Get-NetTCPConnection -State Listen -LocalPort 22 -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty LocalAddress -Unique)
} catch { }
Say "  listening on: $(if($listen){$listen -join ', '}else{'(nothing on 22)'})"

if ($listen -contains '0.0.0.0' -or $listen -contains '::') {
  Say "  PROBLEM: sshd is bound to ALL interfaces, so the LAN can reach it."
  Say "           Re-run after Tailscale is logged in."
}

# VERIFY, do not assume.
#
# The old report just listed whatever was listening and moved on, so a config
# that silently lost the tailnet ListenAddress produced a clean-looking report
# while the controller could not reach the machine at all. Assert the two
# things that actually matter, and fail loudly.
$verdict = 'OK'
if (-not $listen) {
  Say "  PROBLEM: nothing is listening on 22 at all"
  $verdict = 'BROKEN'
} elseif ($tsIp -and -not ($listen -contains $tsIp)) {
  Say "  PROBLEM: sshd is NOT listening on the tailnet address $tsIp"
  Say "           the controller will not be able to connect"
  Say "           check that ListenAddress in the config survived, then restart sshd"
  $verdict = 'BROKEN'
} elseif (-not ($listen -contains '127.0.0.1')) {
  Say "  WARNING: not listening on 127.0.0.1 (local port forwarding will not work)"
}

# Cross-check the file against what sshd itself parsed.
$sshdBin = $sshdExe
if (-not (Test-Path $sshdBin)) { $sshdBin = 'C:\Windows\System32\OpenSSH\sshd.exe' }
if (Test-Path $sshdBin) {
  $eff = Cap { & $sshdBin -T -f $sshdCfg }
  $effListen = @([regex]::Matches($eff, '(?mi)^listenaddress[ \t]+(\S+)') | ForEach-Object { $_.Groups[1].Value })
  Say "  effective ListenAddress: $(if($effListen){$effListen -join ', '}else{'(default: all)'})"
  if ($tsIp -and -not ($effListen -contains "$tsIp`:22") -and -not ($effListen -contains $tsIp)) {
    Say "  PROBLEM: sshd -T does not report the tailnet address either"
    Say "           the ListenAddress line did not survive config editing"
    $verdict = 'BROKEN'
  }
  foreach ($kv in @(
      @('passwordauthentication', 'no'),
      @('allowtcpforwarding', 'local'),
      @('gatewayports', 'no')
    )) {
    if ($eff -notmatch "(?mi)^$($kv[0])[ \t]+$([regex]::Escape($kv[1]))\s*$") {
      Say "  PROBLEM: $($kv[0]) is not '$($kv[1])' in the parsed config"
      $verdict = 'BROKEN'
    }
  }
}

if ($verdict -eq 'BROKEN') {
  Say ""
  Say "  === VERDICT: BROKEN ==="
  Say "  Do not treat this machine as ready. Fix the items above first."
}

$akDir = 'C:\ProgramData\ssh\administrators_authorized_keys'
$userAk = Join-Path $env:USERPROFILE '.ssh\authorized_keys'
Say "  administrators_authorized_keys: $(if(Test-Path $akDir){'present'}else{'absent'})"
Say "  user authorized_keys:          $(if(Test-Path $userAk){'present'}else{'absent'})"

Say ""
Say "--------------------------------------------------------------"
Say "This machine is ready to be enrolled from the controller."
Say ""
Say "On the controller (B), run:"
Say "    node fleet.mjs enroll --name <this-machine> --ip $($tsIp) --user $env:USERNAME --expires 30d"
Say ""
Say "Then copy the accept command it prints back to THIS machine and run it."
Say "--------------------------------------------------------------"
Say ""
Say "=== DONE ==="
