// 验证 install.ps1 里 sshd_config 改写逻辑
//
// 这段逻辑用正则做"设置或追加"，很容易写出：
//   - 把已注释的行设成两行
//   - 把 AllowTcpForwarding yes 改成 no 时改错行
//   - 重复追加同一个指令
// 而 sshd_config 写错 = sshd 起不来 = 远程失联。所以单独验证。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

let pass = 0, fail = 0;
const check = (l, c, e = '') => { c ? (pass++, console.log(`✓ ${l} ${e}`)) : (fail++, console.log(`✗ ${l} ${e}`)); };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-sshd-'));

// 从 install.ps1 里抽出 Set-SshdOption 函数体，单独测试。
//
// 不要用 /function Set-SshdOption \{[\s\S]*?\n    \}/ 这种非贪婪正则：
// 它会停在**第一个**缩进 4 空格的 `}` 上。函数一旦内部出现嵌套块
// （比如 MatchEvaluator 的 scriptblock），就被从中间截断，于是测试测的是
// 半个函数 —— 表现为"同一个指令出现两行"这种莫名其妙的失败。
// 按大括号配平提取才是稳的。
const installPath = path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname.slice(1))), 'install', 'install.ps1');
const src = fs.readFileSync(installPath, 'utf8');

function extractFunction(text, name) {
  const start = text.indexOf(`function ${name}`);
  if (start < 0) return null;
  const open = text.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

const fnBody = extractFunction(src, 'Set-SshdOption');
check('能从 install.ps1 抽出 Set-SshdOption', Boolean(fnBody),
  fnBody ? `${fnBody.length} 字符` : '没找到');

// 一个贴近真实的 sshd_config 样本（Windows 默认 + 几处要改的）
const SAMPLE = [
  '# This is the sshd server system-wide configuration file.',
  '',
  '#PubkeyAuthentication yes',
  'PasswordAuthentication yes',
  'PermitEmptyPasswords no',
  '#AllowTcpForwarding yes',
  'AllowAgentForwarding yes',
  'Subsystem\tsftp\tsftp-server.exe',
].join('\r\n');

const testScript = `
$ErrorActionPreference = 'Stop'
${fnBody}

# Build the sample with explicit CRLF instead of a PowerShell here-string.
# A here-string terminator ('@) must sit at the very start of a line; mixing it
# with template interpolation is fragile, and getting it wrong silently makes
# the whole remainder of the script part of the string.
#
# The sample MUST end with a Match block, because that is what the real Windows
# sshd_config ends with, and splitting on it is the bug-prone part: options
# written inside a Match block make sshd refuse to start.
$CR = [string][char]13
$LF = [string][char]10
$NL = $CR + $LF
$TAB = [string][char]9
$cfg = @(
  '# This is the sshd server system-wide configuration file.',
  '',
  '#PubkeyAuthentication yes',
  'PasswordAuthentication yes',
  'PermitEmptyPasswords no',
  '#AllowTcpForwarding yes',
  'AllowAgentForwarding yes',
  ('Subsystem' + $TAB + 'sftp' + $TAB + 'sftp-server.exe'),
  '',
  'Match Group administrators',
  ('       AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys')
) -join $NL

$cfg = Set-SshdOption $cfg 'PubkeyAuthentication' 'yes'
$cfg = Set-SshdOption $cfg 'PasswordAuthentication' 'no'
$cfg = Set-SshdOption $cfg 'AllowTcpForwarding' 'local'
$cfg = Set-SshdOption $cfg 'PermitTunnel' 'no'

Write-Output '---BEGIN---'
Write-Output $cfg
Write-Output '---END---'
`;

const psFile = path.join(TMP, 't.ps1');
fs.writeFileSync(psFile, testScript, 'ascii');

const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile], {
  encoding: 'utf8',
  timeout: 60_000, windowsHide: true
});
const out = r.stdout || '';
const body = /---BEGIN---([\s\S]*?)---END---/.exec(out)?.[1] || '';

if (!body) {
  console.log('脚本输出：', out.slice(0, 500), r.stderr?.slice(0, 500));
}

const lines = body.split(/\r?\n/).map((l) => l.trim());
const active = (key) => lines.filter((l) => new RegExp(`^${key}\\s+`, 'i').test(l));
const count = (key) => active(key).length;

/* ---- 断言 ---- */
check('PasswordAuthentication 被改成 no', active('PasswordAuthentication')[0] === 'PasswordAuthentication no',
  active('PasswordAuthentication')[0] || '(缺失)');
check('PasswordAuthentication 只有一行', count('PasswordAuthentication') === 1, `${count('PasswordAuthentication')} 行`);

check('PubkeyAuthentication 启用', active('PubkeyAuthentication')[0] === 'PubkeyAuthentication yes',
  active('PubkeyAuthentication')[0] || '(缺失)');
check('PubkeyAuthentication 只有一行', count('PubkeyAuthentication') === 1);

check('AllowTcpForwarding 设为 local', active('AllowTcpForwarding')[0] === 'AllowTcpForwarding local',
  active('AllowTcpForwarding')[0] || '(缺失)');
check('AllowTcpForwarding 只有一行', count('AllowTcpForwarding') === 1);

check('PermitTunnel 追加为 no', active('PermitTunnel')[0] === 'PermitTunnel no', active('PermitTunnel')[0] || '(缺失)');
check('PermitTunnel 只有一行', count('PermitTunnel') === 1);

// 不该被破坏的内容
check('保留 Subsystem sftp', lines.some((l) => /^Subsystem\s+sftp/i.test(l)));
check('保留注释头', lines.some((l) => /^# This is the sshd/i.test(l)));

// 最关键的一条：我们写入的指令必须全部落在 Match 块**之前**。
// sshd 只允许 Match 块里出现少量关键字（AllowUsers/AuthorizedKeysFile 等），
// 一旦 PermitTunnel / ListenAddress 之类被写进 Match 块，sshd 直接拒绝启动
// —— 那样下一次重启就彻底失联，而且原因极难看出来。
const matchLine = lines.findIndex((l) => /^Match\s+/i.test(l));
check('样本里确实有 Match 块（否则测不到本 bug）', matchLine > 0, `第 ${matchLine} 行`);
if (matchLine > 0) {
  const ours = ['PasswordAuthentication', 'PubkeyAuthentication', 'AllowTcpForwarding', 'PermitTunnel'];
  const afterMatch = lines.slice(matchLine).filter((l) =>
    ours.some((k) => new RegExp(`^${k}\\s+`, 'i').test(l)));
  check('我们写的指令都没落进 Match 块', afterMatch.length === 0,
    afterMatch.join(' | '));
  check('Match 块本身及内容被原样保留',
    lines.some((l) => /^Match Group administrators$/i.test(l)) &&
    lines.some((l) => /^AuthorizedKeysFile\s+__PROGRAMDATA__/i.test(l)));
}

// 幂等：再跑一次不应重复追加
const psFile2 = path.join(TMP, 't2.ps1');
fs.writeFileSync(psFile2, testScript.replace("Write-Output '---BEGIN---'", "Write-Output '---BEGIN---'"), 'ascii');
const r2 = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile2], {
  encoding: 'utf8', timeout: 60_000, windowsHide: true
});
const body2 = /---BEGIN---([\s\S]*?)---END---/.exec(r2.stdout || '')?.[1] || '';
const lines2 = body2.split(/\r?\n/).map((l) => l.trim());
check('重复执行结果一致（幂等）', lines2.filter((l) => /^PermitTunnel/i.test(l)).length === 1,
  `${lines2.filter((l) => /^PermitTunnel/i.test(l)).length} 行`);

console.log('\n改后的配置：');
console.log(body.trim().split(/\r?\n/).filter(Boolean).join('\n'));

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
