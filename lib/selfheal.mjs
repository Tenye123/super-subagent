// dsh-fleet —— sshd 自愈
//
// 解决的问题（真实发生过，把整台机器锁在门外）
//
//   我们的设计把 sshd 绑在 Tailscale 地址上（ListenAddress 100.x），并让
//   sshd 服务依赖 Tailscale。看起来很合理，但有个致命顺序问题：
//
//     开机 → sshd 先启动 → 此时 Tailscale 还没拿到 IP → sshd 绑不上
//     → sshd 退出 → Tailscale 随后拿到 IP，但已经没人去启动 sshd 了
//
//   结果是：tailscale ping 通、445 端口开着，但 22 端口连不上。
//   而远程又进不去修，只能人跑到机器前。这次就是靠重新装 MSI
//   才恢复的，代价很大。
//
// 自愈的做法
//   注册一个开机计划任务，在 Tailscale 就绪之后检查 sshd：
//     - sshd 没在跑 → 启动它
//     - 配置里的 ListenAddress 与当前 Tailscale IP 不一致 → 改成新的再启动
//     - 反复失败 → 写日志，不无限重启（避免 2500 次/秒那种事故）
//
// 为什么要改 ListenAddress 而不是直接绑 0.0.0.0
//   绑 0.0.0.0 会在公司内网上开放 22 端口，等于把机器暴露给整个局域网。
//   实测过这一点必须避免，所以坚持"只绑 tailnet + 回环"。
//
// 谁来跑这个任务
//   在**被控端**上注册，而不是控制端。因为要救的是被控端自己。

/** 计划任务名。固定，便于查询和删除。 */
export const TASK_NAME = 'SuperSubagent-SshdHeal';

/**
 * 生成自愈脚本的正文（纯 ASCII）。
 *
 * 逻辑尽量简单：不做猜测，只做三件确定性的事——看 tailscale 有没有 IP、
 * 看 sshd 在不在跑、不一致就改配置重启。复杂逻辑在无人的开机阶段更容易
 * 出错，而这里出错的代价是"再也连不上"。
 *
 * @param {object} [opts]
 * @param {number} [opts.sshPort] sshd 端口，默认 22
 * @returns {string} PowerShell 脚本（纯 ASCII）
 */
export function buildHealScript({ sshPort = 22 } = {}) {
  const L = [];
  const p = (s = '') => L.push(s);

  p('# Super-subagent: sshd self-healing');
  p('#');
  p('# WHY THIS EXISTS');
  p('#   sshd is bound to the Tailscale address on purpose (never 0.0.0.0, so');
  p('#   port 22 is not exposed to the local network). But at boot sshd may');
  p('#   start before Tailscale has an address, fail to bind, and exit. From');
  p('#   then on the machine is unreachable until someone walks over to it.');
  p('#');
  p('# WHAT IT DOES');
  p('#   1. waits for a Tailscale IPv4 to exist');
  p('#   2. if sshd_config points at a stale address, rewrites it');
  p('#   3. validates the config, then starts sshd if it is not running');
  p('#   4. logs everything and never loops forever');
  p('');
  p('$ErrorActionPreference = ' + "'Continue'");
  p('');
  p('$LogFile = Join-Path $env:ProgramData "super-subagent\\sshd-heal.log"');
  p('$LogDir = Split-Path $LogFile -Parent');
  p('if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }');
  p('');
  p('function Say([string]$m) {');
  p('  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $m');
  p('  try { Add-Content -Path $LogFile -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue } catch { }');
  p('}');
  p('');
  p('$tsExe = "C:\\Program Files\\Tailscale\\tailscale.exe"');
  p('if (-not (Test-Path $tsExe)) { Say "tailscale not installed; nothing to do"; exit 0 }');
  p('');
  p('# Wait for a real IPv4. A fresh boot can take a while.');
  p('$tsIp = ""');
  p('for ($i = 1; $i -le 60; $i++) {');
  p('  $cand = ""');
  p('  try { $cand = ((& $tsExe ip -4) 2>&1 | Out-String).Trim() } catch { }');
  p('  if ($cand -match "^\\d{1,3}(\\.\\d{1,3}){3}$") { $tsIp = $cand; break }');
  p('  Start-Sleep -Seconds 5');
  p('}');
  p('if (-not $tsIp) { Say "no tailscale address after 5 minutes; giving up"; exit 0 }');
  p('Say ("tailscale address: " + $tsIp)');
  p('');
  p('$cfg = "C:\\ProgramData\\ssh\\sshd_config"');
  p('if (-not (Test-Path $cfg)) { Say "sshd_config missing; nothing to heal"; exit 0 }');
  p('');
  p('# Read the configured listen addresses before touching the file.');
  p('$text = Get-Content $cfg -Raw');
  p('$mi = [regex]::Match($text, "(?m)^[ \\t]*Match[ \\t]").Index');
  p('$head = if ($mi -ge 0) { $text.Substring(0, $mi) } else { $text }');
  p('$tail = if ($mi -ge 0) { $text.Substring($mi) } else { "" }');
  p('');
  p('$listen = @([regex]::Matches($head, "(?m)^[ \\t]*ListenAddress[ \\t]+(\\S+)") | ForEach-Object { $_.Groups[1].Value })');
  p('$stale = @($listen | Where-Object { $_ -match "^\\d{1,3}(\\.\\d{1,3}){3}$" -and $_ -ne $tsIp -and $_ -ne "127.0.0.1" })');
  p('');
  p('if ($stale.Count -gt 0) {');
  p('  Say ("stale listen address: " + ($stale -join ", ") + " -> " + $tsIp)');
  p('  $bak = "$cfg.heal-bak"');
  p('  if (-not (Test-Path $bak)) { Copy-Item $cfg $bak -Force }');
  p('  $newHead = [regex]::Replace($head, "(?m)^[ \\t]*ListenAddress[^\\r\\n]*(?:\\r?\\n)?", "")');
  p('  $newHead = $newHead.TrimEnd() + "`r`n"');
  p('  $newHead += "ListenAddress $tsIp`r`n"');
  p('  $newHead += "ListenAddress 127.0.0.1`r`n"');
  p('  Set-Content -Path $cfg -Value ($newHead + $tail) -Encoding ASCII -NoNewline');
  p('');
  p('  # Validate before restarting. A broken config plus an eager restart');
  p('  # policy once produced thousands of restarts per second.');
  p('  $sshd = "C:\\Program Files\\OpenSSH\\sshd.exe"');
  p('  if (-not (Test-Path $sshd)) { $sshd = "$env:SystemRoot\\System32\\OpenSSH\\sshd.exe" }');
  p('  $t = & $sshd -t -f $cfg 2>&1');
  p('  if ($LASTEXITCODE -ne 0) {');
  p('    Say ("config invalid after rewrite: " + ($t -join " "))');
  p('    Copy-Item $bak $cfg -Force');
  p('    Say "restored the previous config"');
  p('    exit 1');
  p('  }');
  p('  Say "config rewritten and validated"');
  p('} else {');
  p('  Say "listen address already correct"');
  p('}');
  p('');
  p('# Start sshd if it is not running.');
  p('$svc = Get-Service sshd -ErrorAction SilentlyContinue');
  p('if (-not $svc) { Say "sshd service not installed; nothing to heal"; exit 0 }');
  p('');
  p('if ($svc.Status -ne "Running") {');
  p('  Say ("sshd is " + $svc.Status + "; starting")');
  p('  try {');
  p('    Start-Service sshd -ErrorAction Stop');
  p('    Say "sshd started"');
  p('  } catch {');
  p('    Say ("start failed: " + $_.Exception.Message)');
  p('    exit 1');
  p('  }');
  p('  Start-Sleep -Seconds 3');
  p('  $svc = Get-Service sshd');
  p('}');
  p('');
  p('if ($svc.Status -eq "Running") {');
  p('  Say "sshd is running"');
  p('  $sock = @(Get-NetTCPConnection -State Listen -LocalPort ' + sshPort + ' -ErrorAction SilentlyContinue)');
  p('  $onTs = @($sock | Where-Object { $_.LocalAddress -eq $tsIp })');
  p('  if ($onTs.Count -eq 0) {');
  p('    Say "sshd is running but not listening on the tailscale address"');
  p('    exit 1');
  p('  }');
  p('  Say ("listening on " + $tsIp + ":' + sshPort + '")');
  p('  exit 0');
  p('}');
  p('');
  p('Say "sshd did not reach Running state"');
  p('exit 1');

  return L.join('\r\n') + '\r\n';
}

/**
 * 生成注册计划任务所需的命令（在被控端执行）。
 *
 * 用 ScheduledTask 而不是服务：服务在 Boot 阶段启动得太早，正是我们要
 * 绕开的那个顺序问题。计划任务可以设成"开机后延迟 2 分钟"并重复尝试。
 *
 * @param {object} opts
 * @param {string} opts.healScriptPath 自愈脚本在目标机器上的路径
 * @param {number} [opts.sshPort]
 * @returns {string} PowerShell 脚本（纯 ASCII）
 */
export function buildRegisterTaskScript({ healScriptPath, sshPort = 22 }) {
  if (!healScriptPath) throw new Error('需要 healScriptPath');

  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const L = [];
  const p = (s = '') => L.push(s);

  p('# Super-subagent: register the sshd self-healing scheduled task');
  p('');
  p('$ErrorActionPreference = ' + q('Stop'));
  p('');
  p('$TaskName = ' + q(TASK_NAME));
  p('$HealScript = ' + q(healScriptPath));
  p('');
  p('if (-not (Test-Path $HealScript)) {');
  p('  Write-Error "heal script not found: $HealScript"');
  p('  exit 1');
  p('}');
  p('');
  p('# Remove any previous version so this is idempotent.');
  p('$old = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue');
  p('if ($old) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }');
  p('');
  p('# Run as SYSTEM: sshd runs as a service and the fix must work when');
  p('# nobody is logged in. That is exactly the case it is meant to cover.');
  p('$action = New-ScheduledTaskAction -Execute "powershell.exe" `');
  p('  -Argument ("-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"" + $HealScript + "`"")');
  p('');
  p('# At startup plus a 2 minute delay: gives Tailscale time to bring its');
  p('# adapter up. Starting earlier is what breaks the bind.');
  p('$trigger = New-ScheduledTaskTrigger -AtStartup');
  p('$trigger.Delay = "PT2M"');
  p('');
  p('# Retry a few times in case the first attempt hits a transient failure.');
  p('# Bounded on purpose -- an unbounded retry loop is how sshd once ended up');
  p('# restarting thousands of times per second.');
  p('$trigger2 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) `');
  p('  -RepetitionInterval (New-TimeSpan -Minutes 10) `');
  p('  -RepetitionDuration (New-TimeSpan -Hours 2)');
  p('');
  p('$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest');
  p('$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `');
  p('  -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10)');
  p('');
  p('Register-ScheduledTask -TaskName $TaskName -Action $action `');
  p('  -Trigger @($trigger, $trigger2) -Principal $principal -Settings $settings `');
  p('  -Description "Re-binds sshd to the current Tailscale address after boot and starts it if it died." | Out-Null');
  p('');
  p('$t = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop');
  p('Write-Output ("registered: " + $t.TaskName + " state=" + $t.State)');
  p('');
  p('# Run it once now so the current boot gets fixed too, not just the next.');
  p('try {');
  p('  Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop');
  p('  Start-Sleep -Seconds 6');
  p('  $i = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue');
  p('  if ($i) { Write-Output ("last result: " + $i.LastTaskResult) }');
  p('} catch {');
  p('  Write-Output ("warning: could not start the task immediately: " + $_.Exception.Message)');
  p('}');
  p('');
  p('Write-Output "done"');

  return L.join('\r\n') + '\r\n';
}

/**
 * 检查自愈任务是否已注册（在远端执行）。
 *
 * 单独拆出来是因为"注册"和"确认注册成功"是两件事——只注册不确认，
 * 出问题时又会变成"以为装好了其实没有"。
 */
export function buildCheckTaskScript() {
  const L = [];
  const p = (s = '') => L.push(s);
  p('$ErrorActionPreference = ' + "'Continue'");
  p('$t = Get-ScheduledTask -TaskName ' + "'" + TASK_NAME + "'" + ' -ErrorAction SilentlyContinue');
  p('if (-not $t) { Write-Output "MISSING"; exit 0 }');
  p('$i = Get-ScheduledTaskInfo -TaskName $t.TaskName -ErrorAction SilentlyContinue');
  p('Write-Output ("PRESENT state=" + $t.State + " lastResult=" + $(if ($i) { $i.LastTaskResult } else { "n/a" }))');
  return L.join('\r\n') + '\r\n';
}
