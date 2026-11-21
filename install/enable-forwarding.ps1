# Enable LOCAL-only port forwarding for the task registry, with limits.
# Must run elevated. Pure ASCII only.
#
# Security reasoning (this is the part the user asked to be validated):
#
#   AllowTcpForwarding has three values:
#     no     -- all forwarding refused (current state)
#     local  -- only "ssh -L" (client reaches INTO this machine) allowed
#     yes    -- also "ssh -R" (this machine reaches back OUT via client)
#
#   We need exactly "local": the controller must reach 127.0.0.1:8787 here.
#   "yes" would also let a client ask us to open outbound connections to
#   arbitrary hosts on the company network -- i.e. turn A into a pivot point.
#
#   IMPORTANT, measured earlier this session: with AllowTcpForwarding=no, a
#   key carrying permitopen/port-forwarding STILL cannot forward. The global
#   setting wins. So the global must be "local" for the per-key permitopen to
#   mean anything.
#
#   Defence in depth:
#     1) AllowTcpForwarding local          (no remote forwarding, ever)
#     2) PermitOpen 127.0.0.1:8787          (global allow-list)
#     3) per-key permitopen in authorized_keys (per-key allow-list)
#     4) GatewayPorts no                   (never bind forwards on 0.0.0.0)
#
#   Layer 2 also protects us from a mistake in layer 3: even if someone adds
#   a key with permitopen pointing somewhere else, the global PermitOpen
#   still refuses it.

$ErrorActionPreference = 'Continue'
$out = "$env:TEMP\fleet-forward-enable.txt"
function Say($m) { Add-Content -Path $out -Value $m -Encoding UTF8 }
Set-Content -Path $out -Value "=== enable local forwarding $(Get-Date -Format o) ===" -Encoding UTF8

$cfg = 'C:\ProgramData\ssh\sshd_config'
$sshdExe = 'C:\Program Files\OpenSSH\sshd.exe'
$bak = "$cfg.fleet-bak3"

if (-not (Test-Path $bak)) { Copy-Item $cfg $bak -Force; Say "backup: $bak" }
else { Say "backup exists: $bak" }

# Reuse the proven Set-SshdOption (idempotent, Match-aware, CRLF-safe).
# We re-declare it here rather than import, so this script is self-contained.
function Set-SshdOption {
  param([string]$Text, [string]$Key, [string]$Value)
  $pattern = "(?m)^[ \t]*#?[ \t]*$([regex]::Escape($Key))[ \t]+[^\r\n]*(?=\r?$)"
  $line = "$Key $Value"
  $matchIdx = [regex]::Match($Text, '(?m)^[ \t]*Match[ \t]').Index
  $head = if ($matchIdx -ge 0) { $Text.Substring(0, $matchIdx) } else { $Text }
  $tail = if ($matchIdx -ge 0) { $Text.Substring($matchIdx) } else { '' }
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

$raw = Get-Content $cfg -Raw
$before = $raw

$raw = Set-SshdOption $raw 'AllowTcpForwarding' 'local'
$raw = Set-SshdOption $raw 'AllowAgentForwarding' 'no'
$raw = Set-SshdOption $raw 'PermitTunnel' 'no'
$raw = Set-SshdOption $raw 'GatewayPorts' 'no'
# Global allow-list: only the task registry. Anything else is refused
# even if a key asks for it.
$raw = Set-SshdOption $raw 'PermitOpen' '127.0.0.1:8787'
$raw = Set-SshdOption $raw 'X11Forwarding' 'no'

if ($raw -ceq $before) { Say "config unchanged (already correct)" } else { Say "config updated" }

Set-Content -Path $cfg -Value $raw -Encoding ASCII
Say "written"

# ---- syntax check BEFORE restart ----
$t = (& $sshdExe -t -f $cfg 2>&1 | Out-String).Trim()
$tOk = ($LASTEXITCODE -eq 0)
Say "sshd -t: $(if($tOk){'OK'}else{"FAILED -> $t"})"
if (-not $tOk) {
  Say "ROLLING BACK"
  Copy-Item $bak $cfg -Force
  Say "=== DONE (rolled back) ==="
  exit 1
}

# ---- show effective values ----
Say "--- effective (before first Match block) ---"
$mi = [regex]::Match($raw, '(?m)^[ \t]*Match[ \t]').Index
$headOnly = if ($mi -ge 0) { $raw.Substring(0, $mi) } else { $raw }
foreach ($k in @('AllowTcpForwarding','AllowAgentForwarding','PermitTunnel','GatewayPorts','PermitOpen','PermitListen')) {
  $m = [regex]::Match($headOnly, "(?m)^[ \t]*$([regex]::Escape($k))[ \t]+(.+)$")
  if ($m.Success) { Say "  $k = $($m.Groups[1].Value.Trim())" }
}

# ---- restart ----
Restart-Service sshd -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
Say "service: $((Get-Service sshd).Status)"
$socks = Get-NetTCPConnection -LocalPort 22 -State Listen -ErrorAction SilentlyContinue
Say "listen: $(($socks | ForEach-Object { $_.LocalAddress }) -join ',')"

Say "=== DONE ==="
