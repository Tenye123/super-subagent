# Verify the forwarding policy by REAL traffic, not by reading config.
# Must NOT need elevation (uses the current user's sshd on 127.0.0.1).
#
# WHAT THIS PROVES
#   Case 1  authorized agent key (restrict only)          -> forwarding REFUSED
#   Case 2  ui key (permitopen=127.0.0.1:8787) to 8787    -> forwarding WORKS
#   Case 3  ui key to a DIFFERENT port (e.g. 8899)        -> forwarding REFUSED
#   Case 4  ui key to 22 (sshd itself)                    -> refused by policy
#
#   Case 3 is the important one. Without it, "case 2 worked" proves nothing
#   about whether the restriction exists -- a wide-open config would also
#   pass case 2. This is exactly the trap I fell into earlier when a test
#   reported "ALLOWED" merely because the client had opened its local
#   listener (with -L the client always listens; that proves nothing).
#   The only honest test is whether real bytes move through the channel.
#
# METHOD
#   Start a throwaway sshd on a free port with a temp config + temp
#   AuthorizedKeysFile, then push a real HTTP request through `ssh -L` and
#   look at what comes back.
#
# Pure ASCII only (PowerShell 5.1 reads GBK).

$ErrorActionPreference = 'Continue'
$out = "$env:TEMP\fleet-forward-verify.txt"
function Say($m) { Add-Content -Path $out -Value $m -Encoding UTF8 }
Set-Content -Path $out -Value "=== forwarding verification $(Get-Date -Format o) ===" -Encoding UTF8

$ssh     = 'C:\Windows\System32\OpenSSH\ssh.exe'
$sshd    = 'C:\Program Files\OpenSSH\sshd.exe'
$keygen  = 'C:\Windows\System32\OpenSSH\ssh-keygen.exe'

$tmp = Join-Path $env:TEMP ("fwtest-" + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Force $tmp | Out-Null
Say "workdir: $tmp"

$SSHD_PORT = 22022

# ---------- helper: free port check ----------
function Test-Port($p) {
  $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
  return [bool]$c
}

# ---------- 1. keys ----------
foreach ($k in @('agentkey','uikey','badkey')) {
  & $keygen -t ed25519 -f "$tmp\$k" -N '""' -q 2>&1 | Out-Null
}
Say ("keys: " + ((Get-ChildItem "$tmp\*.pub" | ForEach-Object { $_.Name }) -join ', '))

$agentPub = (Get-Content "$tmp\agentkey.pub" -Raw).Trim()
$uiPub    = (Get-Content "$tmp\uikey.pub" -Raw).Trim()
$badPub   = (Get-Content "$tmp\badkey.pub" -Raw).Trim()

# ---------- 2. the two HTTP listeners we will try to reach ----------
#  8787 = allowed target, 8899 = NOT allowed. Same server, different ports,
#  so the only variable is the port number in the policy.
$listener = @'
const http = require('http');
const ports = (process.argv[2] || '').split(',').map(Number).filter(Boolean);
for (const p of ports) {
  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('FLEET_TARGET_PORT_' + p);
  }).listen(p, '127.0.0.1');
}
console.log('listening ' + ports.join(','));
'@
$listenerJs = Join-Path $tmp 'target.mjs'
Set-Content -Path $listenerJs -Value $listener -Encoding ASCII

$nodeExe = (Get-Command node).Source
$target = Start-Process $nodeExe -ArgumentList @($listenerJs, '8787,8899') -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2
Say "target server pid=$($target.Id) listening 8787,8899"

# ---------- 3. temp sshd config ----------
#  StrictModes no  : authorized_keys lives in a temp dir owned loosely
#  AllowTcpForwarding local : mirrors production
#  PermitOpen      : mirrors production (global allow-list)
$cfgPath = Join-Path $tmp 'sshd_config'
$akPath  = Join-Path $tmp 'authorized_keys'

$cfgText = @"
Port $SSHD_PORT
ListenAddress 127.0.0.1
HostKey $tmp\hostkey
PidFile $tmp\sshd.pid
AuthorizedKeysFile $akPath
StrictModes no
PubkeyAuthentication yes
PasswordAuthentication no
PermitEmptyPasswords no
AllowTcpForwarding local
AllowAgentForwarding no
PermitTunnel no
GatewayPorts no
PermitOpen 127.0.0.1:8787
X11Forwarding no
LogLevel VERBOSE
"@
Set-Content -Path $cfgPath -Value $cfgText -Encoding ASCII
& $keygen -t ed25519 -f "$tmp\hostkey" -N '""' -q 2>&1 | Out-Null

# authorized_keys: three keys with different powers
$akLines = @(
  "restrict $agentPub agent-test",
  "restrict,port-forwarding,permitopen=`"127.0.0.1:8787`" $uiPub ui-test",
  "restrict,port-forwarding,permitopen=`"127.0.0.1:22`" $badPub bad-test"
)
Set-Content -Path $akPath -Value ($akLines -join "`r`n") -Encoding ASCII
Say "authorized_keys written with 3 keys"

# ---------- 4. validate + start ----------
$t = (& $sshd -t -f $cfgPath 2>&1 | Out-String).Trim()
Say "sshd -t (test cfg): $(if($LASTEXITCODE -eq 0){'OK'}else{"FAILED -> $t"})"
if ($LASTEXITCODE -ne 0) { Say '=== ABORT ==='; exit 1 }

$sshdProc = Start-Process $sshd -ArgumentList @('-D','-f',$cfgPath) -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 3
$listening = Test-Port $SSHD_PORT
Say "test sshd pid=$($sshdProc.Id) listening=$listening"
if (-not $listening) { Say '=== ABORT: test sshd not listening ==='; exit 1 }

# ---------- 5. the actual traffic test ----------
# Pick a client port per case; use a plain TCP read so we do not depend on curl.
function TryForward($keyFile, $targetPort, $label) {
  $localPort = 24000 + (Get-Random -Minimum 0 -Maximum 2000)
  $args = @(
    '-i', $keyFile,
    '-p', $SSHD_PORT,
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=NUL',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',   # <- fail fast instead of hanging
    '-o', 'ConnectTimeout=8',
    '-N',
    '-L', "${localPort}:127.0.0.1:${targetPort}",
    'hp@127.0.0.1'
  )
  $p = Start-Process $ssh -ArgumentList $args -PassThru -WindowStyle Hidden `
        -RedirectStandardError "$tmp\err-$label.txt" -RedirectStandardOutput "$tmp\out-$label.txt"
  Start-Sleep -Seconds 2

  $got = $null
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $client.Connect('127.0.0.1', $localPort)
    $stream = $client.GetStream()
    $stream.ReadTimeout = 4000
    $req = "GET / HTTP/1.0`r`nHost: 127.0.0.1`r`n`r`n"
    $bytes = [Text.Encoding]::ASCII.GetBytes($req)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush()
    $reader = New-Object System.IO.StreamReader($stream)
    $got = $reader.ReadToEnd()
    $client.Close()
  } catch {
    $got = "CONNECT_FAILED: $($_.Exception.Message)"
  }

  try { if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } } catch { }
  Start-Sleep -Milliseconds 400

  $errText = ''
  if (Test-Path "$tmp\err-$label.txt") {
    $errText = (Get-Content "$tmp\err-$label.txt" -Raw -ErrorAction SilentlyContinue)
  }

  # Judgement: did a real HTTP response come back through the tunnel?
  #
  # Do NOT test for the body text. With an HTTP/1.0 request and no
  # Content-Length, StreamReader.ReadToEnd() can return after the headers,
  # so a body check reports "no bytes moved" even when the tunnel worked
  # perfectly -- that produced a false FAIL on the very first run, where
  # case 2 had actually returned "HTTP/1.1 200 OK".
  # The status line is the reliable signal: it only exists if the target
  # server really answered THROUGH the forwarded channel.
  $moved = [bool]($got -match '^HTTP/\d\.\d\s+\d{3}')
  $prohibited = [bool]($errText -match 'administratively prohibited')

  Say ""
  Say "--- $label ---"
  Say "  key=$(Split-Path $keyFile -Leaf)  target=127.0.0.1:$targetPort  local=$localPort"
  Say "  http_response=$moved   administratively_prohibited=$prohibited"
  if ($moved) { Say "  response=$((($got -split "`r?`n") | Select-Object -First 1))" }
  else { Say "  response=$(($got -split "`r?`n")[0])" }
  if ($errText -and $errText.Trim()) {
    Say "  stderr=$(($errText.Trim() -split "`r?`n" | Select-Object -First 4) -join ' | ')"
  }
  return $moved
}

$r1 = TryForward "$tmp\agentkey" 8787 'case1-agentkey-to-8787'
$r2 = TryForward "$tmp\uikey"    8787 'case2-uikey-to-8787'
$r3 = TryForward "$tmp\uikey"    8899 'case3-uikey-to-8899-NOT-allowed'
$r4 = TryForward "$tmp\badkey"   22   'case4-badkey-to-22'

Say ""
Say "=========== VERDICT ==========="
Say "case1 agent key -> 8787 :  moved=$r1   (expect False)"
Say "case2 ui key    -> 8787 :  moved=$r2   (expect True)"
Say "case3 ui key    -> 8899 :  moved=$r3   (expect False)"
Say "case4 ui key    -> 22   :  moved=$r4   (expect False)"

$ok = ((-not $r1) -and $r2 -and (-not $r3) -and (-not $r4))
Say ""
Say "OVERALL: $(if($ok){'PASS'}else{'FAIL'})"

# ---------- 6. cleanup ----------
try { if (-not $target.HasExited) { Stop-Process -Id $target.Id -Force -ErrorAction SilentlyContinue } } catch { }
try { if (-not $sshdProc.HasExited) { Stop-Process -Id $sshdProc.Id -Force -ErrorAction SilentlyContinue } } catch { }
Start-Sleep -Milliseconds 500
Say ""
Say "=== DONE ==="
