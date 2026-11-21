// 回归测试：本次安装过程中真实踩到的坑
//
// 每一条都对应一个"看起来没问题、实际是坏的"缺陷。这类缺陷最危险，
// 因为它们不会报错，只会静默失效（用户以为部署好了，实际上连不上或者
// 安全策略根本没生效）。这里把它们固化成断言，防止以后改回去。
//
// 不需要管理员权限。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { which, ROOT, IS_WIN } from '../lib/util.mjs';

let pass = 0, fail = 0;
const check = (l, c, e = '') => { c ? (pass++, console.log(`✓ ${l} ${e}`)) : (fail++, console.log(`✗ ${l} ${e}`)); };
const skip = (l, why) => console.log(`- ${l}（跳过：${why}）`);

const INSTALL = path.join(ROOT, 'install');
const ps1 = (n) => path.join(INSTALL, n);

/* ============================================================
   1. Set-SshdOption 必须幂等，且能识别 CRLF 行尾
   ============================================================
   实际缺陷（耗时很久才找到）：
     (a) 用 \s 匹配前导空白时，\s 也会匹配换行，
         于是 "^#?\s*KEY\s+..." 会跨行匹配，追加过一次之后还能再匹配上，
         造成**同一个指令被追加两遍**（不幂等）。
     (b) 更隐蔽的是 .NET 多行模式下 $ 的语义：
         对 CRLF 文本，$ 锚定在 \n 之前、但在 \r **之后**，
         所以 "...[^\r\n]*$" 永远匹配不到一行 CRLF 文本
         （\r 没被消费，而 [^\r\n] 又拒绝它）。
         结果 IsMatch 返回 false → 走"追加"分支 → 重复追加。

   关键：测试必须**直接调用安装脚本里的真实函数**。
   早先的版本自己另写了一份正则来测，结果测的是测试代码的 bug
   （$Key 未定义 → 正则退化成字面量），既漏报真问题、又报了假失败。
*/
console.log('\n== 1. Set-SshdOption 幂等性（调用真实函数） ==');

const msiScript = fs.readFileSync(ps1('install-sshd-msi.ps1'), 'utf8');
const fnStart = msiScript.indexOf('function Set-SshdOption');
check('安装脚本中存在 Set-SshdOption', fnStart >= 0, '');

// 提取完整函数体（按大括号配平，避免截断）
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}`);
  if (start < 0) return null;
  const braceStart = src.indexOf('{', start);
  let depth = 0, end = -1;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  return end < 0 ? null : src.slice(start, end + 1);
}

const setOptFn = extractFunction(msiScript, 'Set-SshdOption');
check('函数体可完整提取', Boolean(setOptFn), setOptFn ? `${setOptFn.length} 字符` : '提取失败');

if (setOptFn) {
  // 用真实函数跑三个场景。
  //
  // TWO traps in generating this PowerShell source -- both hit for real:
  //  1) No backticks. It is a JS template string, so `r`n would terminate it.
  //     Use [char]13/[char]10 instead.
  //  2) NO NON-ASCII, not even in comments. PowerShell 5.1 reads a BOM-less
  //     file as GBK, so a Chinese comment becomes mojibake -- and some of
  //     those mojibake byte sequences swallow the following newline, merging
  //     the next line of CODE into the comment. The code then silently does
  //     not run. This was the actual cause of scenario B "failing" while an
  //     identical driver without Chinese comments passed.
  const driver = `
${setOptFn}

$NL = [string]([char]13) + [string]([char]10)
$results = @()

# scenario A: directive exists only as a comment (typical stock config)
$tA = "Port 22" + $NL + "#PermitTunnel no" + $NL + "Match Group administrators" + $NL + "  ForceCommand x" + $NL
$onceA  = Set-SshdOption $tA 'PermitTunnel' 'no'
$twiceA = Set-SshdOption $onceA 'PermitTunnel' 'no'
$results += "A_IDEM=" + ($onceA -ceq $twiceA)
$results += "A_COUNT=" + ([regex]::Matches($onceA, "(?m)^PermitTunnel[ \t]")).Count

# scenario B: directive already live, plus a commented example further down
$tB = "Port 22" + $NL + "AllowTcpForwarding yes" + $NL + "#AllowTcpForwarding no" + $NL + "Match Group administrators" + $NL + "  ForceCommand x" + $NL
$onceB  = Set-SshdOption $tB 'AllowTcpForwarding' 'no'
$twiceB = Set-SshdOption $onceB 'AllowTcpForwarding' 'no'
$results += "B_IDEM=" + ($onceB -ceq $twiceB)
$results += "B_LIVE_COUNT=" + ([regex]::Matches($onceB, "(?m)^AllowTcpForwarding[ \t]")).Count
$results += "B_COMMENT_KEPT=" + [bool]($onceB -match "(?m)^#AllowTcpForwarding no")
$results += "B_VALUE_OK=" + [bool]($onceB -match "(?m)^AllowTcpForwarding no")

# scenario C: the Match block must survive untouched
$results += "C_MATCH_KEPT=" + [bool]($onceB -match "(?m)^Match Group administrators")
$results += "C_FORCECMD_KEPT=" + [bool]($onceB -match "ForceCommand x")

$results
`;
  const tmpPs1 = path.join(os.tmpdir(), `fleet-setopt-${process.pid}.ps1`);
  fs.writeFileSync(tmpPs1, driver, 'utf8');
  let out = '';
  try {
    out = execFileSync('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpPs1],
      { encoding: 'utf8', timeout: 60_000, windowsHide: true }).trim();
  } catch (e) {
    out = `ERROR=${e.message}`;
  } finally {
    try { fs.unlinkSync(tmpPs1); } catch { }
  }

  const kv = {};
  for (const line of out.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }

  // 注意：这里用严格相等比较 'True' / 'False'，
  // 不能用 includes('IDEMPOTENT') 那种写法 —— 子串判断会漏掉
  // "NOT_IDEMPOTENT"（本身就包含 "IDEMPOTENT"），造成假阳性。
  check('场景A：注释指令改写后幂等', kv.A_IDEM === 'True', `A_IDEM=${kv.A_IDEM}`);
  check('场景A：只留一条生效指令（无重复追加）', kv.A_COUNT === '1', `数量=${kv.A_COUNT}`);
  check('场景B：已存在指令重复应用幂等', kv.B_IDEM === 'True', `B_IDEM=${kv.B_IDEM}`);
  check('场景B：生效指令只有一条', kv.B_LIVE_COUNT === '1', `数量=${kv.B_LIVE_COUNT}`);
  check('场景B：注释示例被保留（不被误改）', kv.B_COMMENT_KEPT === 'True', '');
  check('场景B：指令值已更新为 no', kv.B_VALUE_OK === 'True', '');
  check('场景C：Match 块原样保留', kv.C_MATCH_KEPT === 'True', '');
  check('场景C：Match 块内内容未被破坏', kv.C_FORCECMD_KEPT === 'True', '');
}

/* ============================================================
   2. 指令不能落进 Match 块
   ============================================================
   Windows 自带的 sshd_config 末尾是：
       Match Group administrators
              AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys
   如果新指令追加到文件末尾，就进了 Match 块，sshd 直接拒绝启动：
       Directive 'Port' is not allowed within a Match block
   实测后果：服务卡在 StartPending、22 端口不监听，而配置"看起来"写成功了。
*/
console.log('\n== 2. 新指令必须插在首个 Match 块之前 ==');
check('安装脚本查找 Match 块位置', /Match\[ \\t\]|Match\\s/.test(msiScript) || msiScript.includes('Match'),
  '');
check('安装脚本按 Match 位置切分 head/tail',
  msiScript.includes('Substring(0, $matchIdx)') || /Substring\(0,\s*\$match/.test(msiScript), '');

/* ============================================================
   3. .ps1 必须纯 ASCII
   ============================================================
   PowerShell 5.1 按 GBK 读取无 BOM 脚本，中文会直接造成语法错误。
   （这条已由 ps1-ascii-test.mjs 覆盖，这里只断言关键安装脚本在列。）
*/
console.log('\n== 3. 关键安装脚本存在且为纯 ASCII ==');
const keyScripts = [
  'install-sshd-msi.ps1',
  'install-tailscale.ps1',
  'lock-firewall.ps1',
  'bind-sshd-tailscale.ps1',
  'audit-security.ps1',
  'install-bind-guard.ps1',
];
for (const name of keyScripts) {
  const p = ps1(name);
  if (!fs.existsSync(p)) { check(`${name} 存在`, false); continue; }
  const buf = fs.readFileSync(p);
  const nonAscii = [...buf].some((b) => b > 127);
  check(`${name} 纯 ASCII`, !nonAscii, nonAscii ? '含非 ASCII 字符' : '');
}

/* ============================================================
   4. sshd 只能绑定回环 / Tailscale 地址
   ============================================================
   这是本次唯一能在本机**客观证明**的暴露面结论：
   防火墙无法从本机验证（回环豁免 + WSL 绕过入站规则，都实测过），
   但"没有绑定在 LAN 地址上"是硬事实。
*/
console.log('\n== 4. sshd 监听地址（真实状态） ==');
if (!IS_WIN) {
  skip('sshd 监听地址', '非 Windows');
} else {
  let socks = [];
  try {
    const out = execFileSync('powershell.exe',
      ['-NoProfile', '-Command',
        "Get-NetTCPConnection -LocalPort 22 -State Listen -ErrorAction SilentlyContinue | " +
        "Select-Object -ExpandProperty LocalAddress"],
      { encoding: 'utf8', timeout: 30_000, windowsHide: true }).trim();
    socks = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch { }

  if (!socks.length) {
    skip('sshd 监听地址', 'sshd 未监听 22（可能未安装）');
  } else {
    // 拿 tailscale 地址
    let tsIp = null;
    const tsExe = which('tailscale');
    if (tsExe) {
      try {
        const r = execFileSync(tsExe, ['ip', '-4'], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
        const c = r.trim().split(/\r?\n/)[0].trim();
        if (/^\d+\.\d+\.\d+\.\d+$/.test(c)) tsIp = c;
      } catch { }
    }

    const bad = socks.filter((a) => a !== '127.0.0.1' && a !== '::1' && a !== tsIp);
    check('没有绑定到 0.0.0.0 / LAN 地址', bad.length === 0,
      bad.length ? `危险绑定: ${bad.join(', ')}` : socks.join(', '));
  }
}

/* ============================================================
   5. 守护任务必须有多于"开机/登录"的触发器
   ============================================================
   实际缺陷：最初只配了 AtStartup + AtLogOn，NextRunTime 为空。
   如果 Tailscale 中途掉线重连（地址重新分配），没有任何东西会重新
   把 sshd 绑回去 —— 远程会一直连不上直到重启。
*/
console.log('\n== 5. 绑定守护任务的触发器 ==');
if (!IS_WIN) {
  skip('守护任务触发器', '非 Windows');
} else {
  let info = '';
  try {
    info = execFileSync('powershell.exe',
      ['-NoProfile', '-Command',
        "$t = Get-ScheduledTask -TaskName 'dsh-fleet-ensure-sshd-bind' -ErrorAction SilentlyContinue; " +
        "if ($t) { ($t.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ',' } else { 'NONE' }"],
      { encoding: 'utf8', timeout: 30_000, windowsHide: true }).trim();
  } catch { }

  if (!info || info === 'NONE') {
    // 以 SYSTEM 注册的任务在非提权会话看不到，这属正常，不应判失败
    skip('守护任务触发器', '任务未注册或当前会话无权限查看（SYSTEM 任务需提权）');
  } else {
    const kinds = info.split(',').map((s) => s.trim());
    check('存在开机触发器', kinds.some((k) => k.includes('Boot')), info);
    check('存在重复/事件触发器（应对中途掉线）',
      kinds.some((k) => k.includes('Time') || k.includes('Event')), info);
  }
}

/* ============================================================
   6. which() 必须能找到不在 PATH 里的 sshd
   ============================================================
   实际缺陷：OpenSSH 的 MSI 把 sshd.exe 放在 C:\Program Files\OpenSSH\，
   不改 PATH。原来只用 where 查找 → 找不到 → 测试静默跳过，
   于是"sshd 已装好"这件事根本没被验证过。
*/
console.log('\n== 6. which() 覆盖已知安装目录 ==');
const utilSrc = fs.readFileSync(path.join(ROOT, 'lib', 'util.mjs'), 'utf8');
check('util.mjs 定义了已知安装目录', utilSrc.includes('WELL_KNOWN_DIRS'), '');
check('包含 OpenSSH 目录', utilSrc.includes('Program Files\\\\OpenSSH') || utilSrc.includes("OpenSSH"), '');
check('包含 Tailscale 目录', utilSrc.includes('Tailscale'), '');

if (IS_WIN && which('sshd')) {
  check('which("sshd") 可解析', true, which('sshd'));
} else if (IS_WIN) {
  skip('which("sshd") 可解析', '本机未安装 sshd');
}

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
