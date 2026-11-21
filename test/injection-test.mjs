// 验证：参数不经过 cmd 解释，特殊字符无法注入命令。
//
// 被测点是 lib/util.mjs 的 run()：它解析 npm 的 .cmd 包装器后直接 spawn
// 真正的 node + 脚本，不把参数拼进 cmd 命令行。所以 `&`、`|`、`;`
// 只会作为普通字符串传给程序，不会被解释成新命令。
import { run } from '../lib/util.mjs';
import { which } from '../lib/util.mjs';

const CASES = [
  ['普通参数', ['--version']],
  ['含 & 的参数', ['--version', '&', 'echo', 'INJECTED']],
  ['含 | 的参数', ['--version', '|', 'echo', 'INJECTED']],
  ['含分号引号', ['--version', '"; echo INJECTED; "']],
  ['含 %PATH%', ['--version', '%PATH%']],
];

// 不写死路径：不同机器上 dsh 装的位置不同。找不到就明确跳过。
const dsh = which('dsh') || which('dsh.cmd');
if (!dsh) {
  console.log('跳过：PATH 里找不到 dsh 命令');
  console.log('0 通过, 0 失败（已跳过）');
  process.exit(0);
}
console.log('被测命令：' + dsh + '\n');

let pass = 0;
let bad = 0;
for (const [label, args] of CASES) {
  const r = run(dsh, args, { timeout: 20_000 });
  const leaked = /INJECTED/.test(r.stdout) || /INJECTED/.test(r.stderr);
  const expanded = /[A-Z]:\\/i.test(r.stdout) && label.includes('%PATH%');
  const ok = !leaked && !expanded;
  if (ok) pass++;
  else bad++;
  console.log(
    `${ok ? '✓ 安全' : '✗ 不安全'}  ${label.padEnd(14)} code=${r.code} out=${JSON.stringify(r.stdout.slice(0, 60))}`
  );
}

console.log('');
console.log(`${pass} 通过, ${bad} 失败`);
process.exit(bad === 0 ? 0 : 1);
