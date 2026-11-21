// 校验 install.ps1 是纯 ASCII
//
// 为什么单独立一个测试：
//   本机是 PowerShell 5.1，按 GBK 读 .ps1。只要文件里有一个中文/全角字符，
//   就是语法错误，安装器直接跑不起来 —— 而这是新机器上第一条要跑的东西，
//   坏了就等于整个项目不可用。所以把它固化成测试。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

let pass = 0, fail = 0;
const check = (l, c, e = '') => { c ? (pass++, console.log(`✓ ${l} ${e}`)) : (fail++, console.log(`✗ ${l} ${e}`)); };

/* ---- 1. 所有 .ps1 必须是纯 ASCII ---- */
const ps1Files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '.bootstrap') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name.toLowerCase().endsWith('.ps1')) ps1Files.push(full);
  }
})(ROOT);

check('找到 .ps1 文件', ps1Files.length > 0, `${ps1Files.length} 个`);

for (const f of ps1Files) {
  const buf = fs.readFileSync(f);
  const rel = path.relative(ROOT, f);

  // 非 ASCII 字节（>0x7F）全部不允许
  let badAt = -1;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] > 0x7f) { badAt = i; break; }
  }

  if (badAt === -1) {
    check(`${rel} 是纯 ASCII`, true, `${buf.length} 字节`);
  } else {
    // 报出上下文，便于定位
    const start = Math.max(0, badAt - 40);
    const ctx = buf.subarray(start, badAt + 40).toString('latin1').replace(/\r?\n/g, '\\n');
    check(`${rel} 是纯 ASCII`, false, `偏移 ${badAt}：...${ctx}...`);
  }

  // BOM 也要拒绝：PS 5.1 遇到 UTF-8 BOM 虽能识别，但混用容易出错，统一不要
  check(`${rel} 无 BOM`, !(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf));
}

/* ---- 2. install.ps1 能被 PowerShell 解析（不执行） ---- */
const install = path.join(ROOT, 'install', 'install.ps1');
if (fs.existsSync(install)) {
  // -Command 里用 [ScriptBlock]::Create 只解析不执行
  const ps = `$e=$null; $null=[System.Management.Automation.Language.Parser]::ParseFile('${install.replace(/'/g, "''")}',[ref]$null,[ref]$e); if($e.Count -gt 0){ $e | ForEach-Object { Write-Output $_.Message }; exit 1 } else { Write-Output 'PARSE_OK' }`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    encoding: 'utf8',
    timeout: 60_000, windowsHide: true
  });
  const out = (r.stdout || '').trim();
  check('install.ps1 语法解析通过', out.includes('PARSE_OK'), out.slice(0, 200) || (r.stderr || '').slice(0, 200));

  /* ---- 3. 声明的参数都在 ---- */
  const text = fs.readFileSync(install, 'utf8');
  for (const p of ['$Role', '$DeviceName', '$Yes', '$SoftwareOnly']) {
    check(`声明了参数 ${p}`, text.includes(p));
  }
}
else {
  check('install.ps1 存在', false);
}

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
