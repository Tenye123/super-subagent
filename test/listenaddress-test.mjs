// 守住 "ListenAddress 不能互相覆盖" 这个 bug。
//
// 背景：曾用 Set-SshdOption 连续设置两次 ListenAddress（tailnet + 回环）。
// 那个函数是 "替换第一处匹配"，所以第二次调用把第一次的值覆盖掉了，
// 结果 sshd 只绑 127.0.0.1，控制器完全连不进来——而日志里还印着两个地址，
// 因为它打的是"意图"而不是"结果"。
//
// 这个测试跑真实的 PowerShell，喂一份带 Match 块的真实配置，验证：
//   1. 两个地址都在
//   2. 都在 Match 之外（全局段）
//   3. ListenAddress 不会出现重复或丢失
//   4. 原有的其它加固项不被破坏

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let pass = 0, fail = 0;
const check = (l, c, e = '') => { c ? (pass++, console.log(`✓ ${l} ${e}`)) : (fail++, console.log(`✗ ${l} ${e}`)); };

const SRC = path.join(process.cwd(), 'install', 'setup-agent.ps1');
const src = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

// 提取我们要测的那段逻辑（ListenAddress 注入）。
const startMark = 'if ($tsIp) {';
const endMark = '} else {'; // 紧跟的 else 分支
const i = src.indexOf(startMark);
if (i < 0) { console.error('找不到 ListenAddress 段'); process.exit(1); }
// 从 i 开始做括号配平，取出完整的 if 块
let depth = 0, end = -1;
for (let k = src.indexOf('{', i); k < src.length; k++) {
  if (src[k] === '{') depth++;
  else if (src[k] === '}') { depth--; if (depth === 0) { end = k; break; } }
}
const block = src.slice(i, end + 1);

// 只检查"有效代码"，跳过注释行。
// 否则会匹配到注释里记录的历史错误代码（那段注释是本测试存在的理由）。
const codeLines = src.split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
const codeOnly = codeLines.join('\n');

check('源码里不再有连续两次 Set-SshdOption ListenAddress',
  !/Set-SshdOption \$raw 'ListenAddress'[^\n]*\n(?:\s*\n)*\s*\$raw = Set-SshdOption \$raw 'ListenAddress'/.test(codeOnly),
  '连续两次调用会让后一次覆盖前一次');

check('源码里 Set-SshdOption ListenAddress 出现次数为 0（已改用直接注入）',
  !/Set-SshdOption \$raw 'ListenAddress'/.test(codeOnly));

check('源码显式剥离了旧的 ListenAddress 行',
  /regex\]::Replace\(\$raw, '\(\?m\)\^\[ \\t\]\*#\?\[ \\t\]\*ListenAddress/.test(src),
  '需要先删掉所有旧的 ListenAddress（含注释掉的）');

/* ---------- 用真实 PowerShell 跑一遍这段逻辑 ---------- */

// 一份贴近真实的 sshd_config：有注释掉的 ListenAddress、有 Match 块
const sampleConfig = [
  '# This is the sshd server system-wide configuration file.',
  'Include /etc/ssh/sshd_config.d/*.conf',
  '',
  'Port 22',
  '#ListenAddress 0.0.0.0',
  '#ListenAddress ::',
  '',
  'PubkeyAuthentication yes',
  'PasswordAuthentication yes',
  'PermitEmptyPasswords no',
  'AllowTcpForwarding no',
  'GatewayPorts no',
  '',
  'Match Group administrators',
  '       AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys',
  '',
].join('\n').replace(/\n/g, '\r\n');

const tmp = path.join(os.tmpdir(), `fleet-listen-test-${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });
const cfgPath = path.join(tmp, 'sshd_config');
fs.writeFileSync(cfgPath, sampleConfig, 'utf8');

// 只把那段逻辑包起来执行，其它加固项用固定值模拟
const driver = `
$ErrorActionPreference = 'Stop'
$raw = [IO.File]::ReadAllText('${cfgPath.replace(/\\/g, '\\\\')}')
$tsIp = '100.64.0.5'
function Say { param($m) Write-Output $m }
${block}
[IO.File]::WriteAllText('${cfgPath.replace(/\\/g, '\\\\')}', $raw, (New-Object System.Text.UTF8Encoding $false))
Write-Output '__DONE__'
`;

const psFile = path.join(tmp, 'driver.ps1');
// 纯 ASCII 约束：driver 里不能有中文
if (/[^\x00-\x7F]/.test(driver)) {
  console.error('driver 含非 ASCII 字符');
  process.exit(1);
}
fs.writeFileSync(psFile, driver, 'ascii');

const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile], {
  encoding: 'utf8', windowsHide: true, timeout: 60_000,
});

if (r.status !== 0 || !(r.stdout || '').includes('__DONE__')) {
  check('PowerShell 执行成功', false, (r.stderr || r.stdout || '').slice(0, 400));
} else {
  check('PowerShell 执行成功', true);

  const out = fs.readFileSync(cfgPath, 'utf8');
  const lines = out.split(/\r?\n/);
  const listenLines = lines.filter((l) => /^[ \t]*ListenAddress[ \t]/.test(l));

  check('恰好两行 ListenAddress', listenLines.length === 2, `实际 ${listenLines.length} 行: ${JSON.stringify(listenLines)}`);
  check('含 tailnet 地址', listenLines.some((l) => l.includes('100.64.0.5')), JSON.stringify(listenLines));
  check('含回环地址', listenLines.some((l) => l.includes('127.0.0.1')), JSON.stringify(listenLines));

  // 必须在 Match 之前
  const matchIdx = lines.findIndex((l) => /^[ \t]*Match[ \t]/.test(l));
  const lastListenIdx = lines.map((l, n) => (/^[ \t]*ListenAddress[ \t]/.test(l) ? n : -1)).filter((n) => n >= 0).pop();
  check('ListenAddress 都在 Match 块之前', matchIdx > 0 && lastListenIdx < matchIdx,
    `Match 在 ${matchIdx + 1} 行, 最后一个 ListenAddress 在 ${lastListenIdx + 1} 行`);

  // Match 块本身必须完整保留
  check('Match 块被保留', /Match Group administrators/.test(out));
  check('Match 块主要内容还在', /administrators_authorized_keys/.test(out));

  // 注释掉的 ListenAddress 不能死灰复燃
  check('注释掉的 ListenAddress 已被清除', !/^[ \t]*#[ \t]*ListenAddress/m.test(out));

  // 其它行不能被破坏
  check('Port 22 保留', /^Port 22$/m.test(out));
  check('Include 行保留', /Include \/etc\/ssh\/sshd_config\.d/.test(out));
  check('PubkeyAuthentication 行保留', /^PubkeyAuthentication yes$/m.test(out));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
