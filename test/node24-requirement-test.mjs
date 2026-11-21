// 守住 "DSH 需要 Node 24+" 这个硬约束。
//
// 事故：A 装了 Node 22.14.0，npm 把 @deepseek-ai/dsh 装得完完整整
// （文件哈希与 B 完全一致、依赖树齐全），但 `dsh --version` 退出码 0、
// 零输出，所有派发任务都失败。
//
// 根因是 dsh 的 bin.js 最后一行：
//     if (import.meta.main) await runCli();
// `import.meta.main` 是 Node 24 才有的 API。在 Node 22 上是 undefined，
// 于是守卫恒假、runCli() 从不执行、进程静默退出 0。
//
// 包自身的 package.json 里 engines 是空的，没有任何元数据声明这个要求，
// 所以只能靠 测试 + 安装脚本双重把关。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let pass = 0, fail = 0;
const check = (l, c, e = '') => { c ? (pass++, console.log(`✓ ${l} ${e}`)) : (fail++, console.log(`✗ ${l} ${e}`)); };

const tmp = path.join(os.tmpdir(), `fleet-node24-${Date.now()}`);
fs.mkdirSync(tmp, { recursive: true });

/* ---------- 1. 本机 Node 必须 >= 24 ---------- */
{
  const v = spawnSync('node', ['-v'], { encoding: 'utf8', windowsHide: true });
  const raw = (v.stdout || '').trim();
  const major = parseInt(raw.replace(/^v/, '').split('.')[0], 10);
  check('本机 Node 主版本 >= 24', major >= 24, `(当前 ${raw})`);
}

/* ---------- 2. import.meta.main 在本机是 true ---------- */
{
  const p = path.join(tmp, 'm.mjs');
  fs.writeFileSync(p, "console.log('MAIN=' + import.meta.main)\n", 'ascii');
  const r = spawnSync('node', [p], { encoding: 'utf8', windowsHide: true });
  const out = (r.stdout || '').trim();
  check('本机 import.meta.main 为 true', out === 'MAIN=true', `(实测 ${out})`);
}

/* ---------- 3. 记录 Node 22 和 24 的行为差异（文档化测试） ---------- */
{
  // 原理验证：守卫恒假时，整个 CLI 静默退出、退出码 0。
  // 这正是 A 上观察到的现象（dsh --version 零输出、RC=0）。
  const p = path.join(tmp, 'guard.mjs');
  fs.writeFileSync(p, [
    'const fakeMain = undefined;   // stands in for import.meta.main on Node 22',
    "async function runCli() { console.log('CLI RAN'); }",
    'if (fakeMain) await runCli();',
    '',
  ].join('\n'), 'ascii');
  const r = spawnSync('node', [p], { encoding: 'utf8', windowsHide: true });
  check('守卫为假时 CLI 零输出且退出码 0（复现事故现象）',
    (r.stdout || '').trim() === '' && r.status === 0,
    `out=${JSON.stringify(r.stdout)} code=${r.status}`);
}

/* ---------- 4. dsh 的 bin.js 确实用了这个守卫 ---------- */
{
  // 找本机 dsh 的 bin.js
  const cands = [];
  const g = spawnSync('where', ['dsh'], { encoding: 'utf8', windowsHide: true });
  if (g.status === 0) {
    for (const line of (g.stdout || '').split(/\r?\n/)) {
      const d = path.dirname(line.trim());
      if (d) cands.push(path.join(d, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
    }
  }
  // 退路：常见全局安装位置
  cands.push('E:/nodejs/node_global/node_modules/@deepseek-ai/dsh/lib/bin.js');

  const found = cands.find((c) => { try { return fs.existsSync(c); } catch { return false; } });
  check('找到本机 dsh 的 bin.js', !!found, found || '(未找到)');

  if (found) {
    const src = fs.readFileSync(found, 'utf8');
    check('bin.js 使用 import.meta.main 守卫',
      /import\.meta\.main/.test(src),
      '(这是硬依赖 Node 24 的直接原因)');
    check('bin.js 调用了 runCli', /runCli\s*\(/.test(src));
  }
}

/* ---------- 5. 安装脚本必须要求 Node >= 24 ---------- */
{
  const src = fs.readFileSync(path.join('install', 'setup-agent.ps1'), 'utf8');

  // 门槛必须是 24。注意脚本里会同时出现 `-ge 24`（真正的门槛）和
  // `-ge 18`（只是用来区分提示文案的分支），所以不能简单断言"没有 -ge 18"。
  check('setup-agent.ps1 的 Node 门槛是 24',
    /if\s*\(\s*\$major\s+-ge\s+24\s*\)/.test(src),
    /if\s*\(\s*\$major\s+-ge\s+18\s*\)/.test(src) ? '(! 真正的门槛仍是 18)' : '');

  // 不能再用会静默失效的 Node 22 URL
  check('setup-agent.ps1 不再下载 Node 22',
    !/node-v22\.\d+\.\d+-x64\.msi/.test(src));

  // 必须固定成 24.x。注意脚本里的 URL 是由变量拼出的：
  //     $nodeVersion = '24.14.1'
  //     $nodeUrl = ".../v$nodeVersion/node-v$nodeVersion-x64.msi"
  // 所以不能直接正则找 "node-v24..." 字面量。
  const vm = src.match(/\$nodeVersion\s*=\s*'(\d+)\.(\d+)\.(\d+)'/);
  check('setup-agent.ps1 固定了 Node 版本变量',
    !!vm, vm ? `(v${vm[1]}.${vm[2]}.${vm[3]})` : '(未找到 $nodeVersion)');
  check('固定的 Node 版本是 24.x',
    !!vm && vm[1] === '24',
    vm ? `(实际 v${vm[1]}.${vm[2]}.${vm[3]})` : '');
  check('URL 由该版本变量拼出（无硬编码旧版本）',
    /node-v\$nodeVersion-x64\.msi/.test(src));

  // 静默失败必须被当成硬错误，而不是 warning
  check('dsh 版本校验失败时 exit 1（不是只警告）',
    /dsh --version.*produced no usable output[\s\S]{0,900}?exit 1/.test(src));
}

/* ---------- 6. 真实冒烟：本机 dsh --version 有输出 ---------- */
{
  // Windows 上 dsh 是 .cmd shim，spawnSync 不带 shell 找不到它。
  // 这个失败本身就说明了一个坑：直接 spawn('dsh') 会 status=1、输出为空，
  // 看起来和"被 Node 版本问题搞坏的 CLI"一模一样 —— 排查时极易误判。
  const r = spawnSync('dsh', ['--version'], {
    encoding: 'utf8', windowsHide: true, timeout: 60_000, shell: true,
  });
  const out = (r.stdout || '').trim();
  check('本机 dsh --version 真的输出内容', /^\d+\.\d+/.test(out),
    `(输出 ${JSON.stringify(out)}, code=${r.status})`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
