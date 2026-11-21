# Bind sshd to the Tailscale address ONLY -- a socket-level guarantee.
# Must run elevated. Pure ASCII only.
#
# WHY: the firewall rule alone could not be verified from this machine.
#   - Connecting to one of our own LAN IPs is loopback: Windows exempts it,
#     so the test always says "reachable" and proves nothing.
#   - WSL traffic arrives over the Hyper-V vSwitch and BYPASSES inbound
#     firewall rules: a listener with NO allow rule was still reachable from
#     WSL. Verified experimentally. So WSL cannot validate the firewall either.
#
#   => the only claim we can actually prove locally is what the SOCKET listens
#      on. If sshd binds exclusively to the Tailscale address, then no packet
#      arriving on the company LAN can ever reach it, firewall or not.
#
#   Defense in depth: keep the Tailscale-scoped firewall rule as well.
#
# BOOT ORDER: if sshd starts before Tailscale has assigned its address, the
# bind fails and sshd exits. We therefore make the sshd service depend on
# Tailscale. Note the lockout risk: if Tailscale is logged out/removed, the
# address vanishes and sshd cannot start. That is inherent to this design and
# is why the firewall rule is kept too.

$ErrorActionPreference = 'Continue'
$out = "$env:TEMP\fleet-bind.txt"
function Say($m) { Add-Content -Path $out -Value $m -Encoding UTF8 }
Set-Content -Path $out -Value "=== bind sshd to tailscale ip $(Get-Date -Format o) ===" -Encoding UTF8

$cfg = 'C:\ProgramData\ssh\sshd_config'
$tsExe = 'C:\Program Files\Tailscale\tailscale.exe'
$sshdExe = 'C:\Program Files\OpenSSH\sshd.exe'

# ---- 1. find the tailscale IPv4 ----
$tsIp = $null
try { $tsIp = (& $tsExe ip -4 2>&1 | Out-String).Trim().Split("`n")[0].Trim() } catch { }
if ($tsIp -notmatch '^\d+\.\d+\.\d+\.\d+$') {
  Say "NO_TAILSCALE_IP (got '$tsIp') -- refusing to change config (would lock us out)"
  Say "=== DONE ==="
  exit 1
}
Say "tailscale ipv4: $tsIp"

# ---- 2. back up ----
$bak = "$cfg.fleet-bak2"
if (-not (Test-Path $bak)) {
  Copy-Item $cfg $bak -Force
  Say "backed up to $bak"
} else {
  Say "backup already exists"
}

# ---- 3. rewrite ListenAddress lines ----
# Only before the first Match block; directives there are illegal inside it.
$text = Get-Content $cfg -Raw
$matchIdx = [regex]::Match($text, '(?m)^[ \t]*Match[ \t]').Index
$head = if ($matchIdx -ge 0) { $text.Substring(0, $matchIdx) } else { $text }
$tail = if ($matchIdx -ge 0) { $text.Substring($matchIdx) } else { '' }

# remove all existing ListenAddress lines (commented or not) from the head
$before = ([regex]::Matches($head, '(?m)^[ \t]*#?[ \t]*ListenAddress[^\r\n]*')).Count
$head = [regex]::Replace($head, '(?m)^[ \t]*#?[ \t]*ListenAddress[^\r\n]*(?:\r?\n)?', '')

# append exactly one, scoped to tailscale, plus loopback for local admin use
$head = $head.TrimEnd() + "`r`n"
$head += "ListenAddress $tsIp`r`n"
$head += "ListenAddress 127.0.0.1`r`n`r`n"
Say "removed $before existing ListenAddress line(s); added 2"

Set-Content -Path $cfg -Value ($head + $tail) -Encoding ASCII -NoNewline
Say "sshd_config written"

# ---- 4. syntax check BEFORE restarting, so we do not leave sshd dead ----
$test = (& $sshdExe -t -f $cfg 2>&1 | Out-String).Trim()
Say "sshd -t: $(if($LASTEXITCODE -eq 0){'OK'}else{"FAILED -> $test"})"
if ($LASTEXITCODE -ne 0) {
  Say "RESTORING BACKUP -- refusing to apply a broken config"
  Copy-Item $bak $cfg -Force
  Say "=== DONE (rolled back) ==="
  exit 1
}

# ---- 5. make sshd start after tailscale ----
$dep = (& sc.exe qc sshd 2>&1 | Out-String)
Say "--- service before ---"
Say (($dep.Trim().Split("`n") | Where-Object { $_ -match 'DEPENDENCIES|SERVICE_NAME|START_TYPE' }) -join "`n")
$scOut = (& sc.exe config sshd depend= Tailscale 2>&1 | Out-String).Trim()
Say "sc config depend= Tailscale -> $scOut"
$dep2 = (& sc.exe qc sshd 2>&1 | Out-String)
Say "--- service after ---"
Say (($dep2.Trim().Split("`n") | Where-Object { $_ -match 'DEPENDENCIES' }) -join "`n")

# ---- 6. restart and check what it actually bound to ----
Restart-Service sshd -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
Say "service status: $((Get-Service sshd).Status)"

Say ""
Say "--- actual listen sockets on port 22 ---"
$socks = Get-NetTCPConnection -LocalPort 22 -State Listen -ErrorAction SilentlyContinue
foreach ($s in $socks) { Say "  $($s.LocalAddress):$($s.LocalPort)" }

$onlyTailscale = $true
foreach ($s in $socks) {
  if ($s.LocalAddress -ne $tsIp -and $s.LocalAddress -ne '127.0.0.1' -and $s.LocalAddress -ne '::1') {
    $onlyTailscale = $false
    Say "  UNEXPECTED bind: $($s.LocalAddress)"
  }
}
Say ""
if (-not $socks) {
  Say "RESULT: sshd is NOT listening at all -- investigate before leaving it"
} elseif ($onlyTailscale) {
  Say "RESULT: PASS -- sshd listens ONLY on tailscale/loopback"
  Say "        packets from the company LAN cannot reach it regardless of firewall"
} else {
  Say "RESULT: FAIL -- sshd is still bound to a non-tailscale address"
}
Say "=== DONE ==="
