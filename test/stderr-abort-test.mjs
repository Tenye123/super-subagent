// 守住 "外部程序的 stderr 不能中断安装脚本" 这个 bug。
//
// 背景：setup-agent.ps1 顶部是 $ErrorActionPreference = 'Stop'。
// Windows PowerShell 5.1 下，外部程序往 stderr 写一行，`2>&1` 就把它包成
// ErrorRecord，Stop 会**立刻终止整个脚本**。
//
// 实测事故：npm 打印
//     npm warn EBADENGINE Unsupported engine {
// 这只是警告，但整个 bootstrap 停在第 2/7 步，用户只看到一屏红色报错，
// 后面的 Tailscale / OpenSSH / 加固全都没跑。
//
// 本测试做三件事：
//   1. 复现"裸 2>&1 会被 Stop 中断"（证明这个坑是真的）
//   2. 证明 Cap 包装能扛住（stderr 被当数据捕获，脚本继续）
//   3. 静态扫描 setup-agent.ps1，确认没有裸露的外部 2>&1 调用

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let pass = 0, fail = 0;
const check = (l, c, e = '') => { c ? (pass++, console.log(`✓ ${l} ${e}`)) : (fail++, console.log(`✗ ${l} ${e}`)); };

const tmp = path.join(os.tmpdir(), `fleet-stderr-test-${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });

function runPs(script) {
  const p = path.join(tmp, `s${Date.now()}${Math.random().toString(16).slice(2)}.ps1`);
  fs.writeFileSync(p, script, 'ascii');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', p], {
    encoding: 'utf8', windowsHide: true, timeout: 60_000,
  });
  return { out: `${r.stdout || ''}\n${r.stderr || ''}`, code: r.status };
}

/* ---------- 1. 复现：裸 2>&1 + Stop 会中断 ---------- */
{
  const r = runPs(`
$ErrorActionPreference = 'Stop'
Write-Output 'STEP1'
$null = & cmd /c "echo chatty-warning 1>&2" 2>&1
Write-Output 'STEP2-SHOULD_NOT_PRINT'
`);
  const aborted = !r.out.includes('STEP2-SHOULD_NOT_PRINT');
  check('复现：裸 2>&1 在 Stop 下会中断脚本', aborted,
    aborted ? '(已确认这个坑真实存在)' : '(! 没能复现，PowerShell 行为可能变了)');
}

/* ---------- 2. Cap 包装能扛住 ---------- */
{
  const r = runPs(`
$ErrorActionPreference = 'Stop'
function Cap {
  param([Parameter(Mandatory = \$true)][scriptblock]$Block)
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $out = & $Block 2>&1 } finally { $ErrorActionPreference = $old }
  return (($out | ForEach-Object { "$_" }) -join "\`r\`n")
}
Write-Output 'STEP1'
$t = Cap { & cmd /c "echo chatty-warning 1>&2" }
$t2 = Cap { & cmd /c "echo real-output" }
Write-Output 'STEP2-REACHED'
Write-Output "CAPTURED_ERR=$($t.Trim())"
Write-Output "CAPTURED_OUT=$($t2.Trim())"
Write-Output "EAP=$ErrorActionPreference"
`);
  check('Cap 包装后脚本继续执行', r.out.includes('STEP2-REACHED'));
  check('Cap 捕获到了 stderr 内容', /CAPTURED_ERR=.*chatty-warning/.test(r.out),
    (r.out.match(/CAPTURED_ERR=(.*)/) || [])[1] || '(无)');
  check('Cap 捕获到了 stdout 内容', /CAPTURED_OUT=.*real-output/.test(r.out),
    (r.out.match(/CAPTURED_OUT=(.*)/) || [])[1] || '(无)');
  check('Cap 之后 ErrorActionPreference 被恢复为 Stop', /EAP=Stop/.test(r.out));
}

/* ---------- 3. Cap 保留退出码 ---------- */
{
  const r = runPs(`
$ErrorActionPreference = 'Stop'
function Cap {
  param([Parameter(Mandatory = \$true)][scriptblock]$Block)
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $out = & $Block 2>&1 } finally { $ErrorActionPreference = $old }
  return (($out | ForEach-Object { "$_" }) -join "\`r\`n")
}
$null = Cap { & cmd /c "exit 7" }
Write-Output "CODE=$LASTEXITCODE"
`);
  check('Cap 之后 $LASTEXITCODE 仍可读', /CODE=7/.test(r.out),
    (r.out.match(/CODE=(\d+)/) || [])[1] || '(无)');
}

/* ---------- 4. 静态扫描：setup-agent.ps1 不应有裸露的外部 2>&1 ---------- */
{
  const src = fs.readFileSync(path.join('install', 'setup-agent.ps1'), 'utf8');
  const lines = src.split(/\r?\n/);

  // 允许的例外：
  //   - 注释行
  //   - Invoke-External / Cap 自身的实现（它们内部已经降级处理）
  const offenders = [];
  let inHelper = false;
  for (const [i, l] of lines.entries()) {
    if (/^function (Invoke-External|Cap)\b/.test(l)) inHelper = true;
    if (inHelper && /^}/.test(l)) { inHelper = false; continue; }
    if (inHelper) continue;
    if (/^\s*#/.test(l)) continue;
    if (!/2>&1/.test(l)) continue;
    offenders.push(`${i + 1}: ${l.trim()}`);
  }

  check('setup-agent.ps1 无裸露的外部 2>&1 调用',
    offenders.length === 0,
    offenders.length ? `\n    ${offenders.join('\n    ')}` : '');

  check('定义了 Cap 辅助函数', /function Cap\b/.test(src));
  check('定义了 Invoke-External 辅助函数', /function Invoke-External\b/.test(src));
}

/* ---------- 5. 所有 .ps1 统一检查 ErrorActionPreference ---------- */
{
  const dir = 'install';
  const bad = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.ps1')) continue;
    const t = fs.readFileSync(path.join(dir, f), 'utf8');
    if (!/ErrorActionPreference\s*=\s*'Stop'/.test(t)) continue;

    // 设了 Stop 的脚本必须处理外部 stderr。三种合法做法：
    //   a) 定义了 Cap / Invoke-External 辅助函数
    //   b) 内联地把偏好降为 Continue 再恢复（等价写法）
    //   c) 完全没有外部 2>&1
    const hasHelper = /function (Cap|Invoke-External)\b/.test(t);
    const hasInlineGuard = /ErrorActionPreference\s*=\s*'Continue'/.test(t);
    const bare = t.split(/\r?\n/)
      .filter((l) => /2>&1/.test(l) && !/^\s*#/.test(l));

    if (bare.length > 0 && !hasHelper && !hasInlineGuard) {
      bad.push(`${f} (${bare.length} 处)`);
    }
  }
  check('设了 Stop 的脚本都处理了外部 stderr', bad.length === 0, bad.join(', '));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
