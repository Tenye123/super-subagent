// fleet accept --kind ui 的安全闸门（走真实 CLI）
//
// 为什么单独测 CLI 而不只测库函数：
//   forward-auth-test.mjs 测的是 buildAuthorizedKeyLine / isLoopbackTarget，
//   但用户真正接触的是命令行。如果 CLI 忘了调用校验，或者把校验结果丢了，
//   库函数测得再全也没用。
//
// 关键：这些用例**必须确认没有写进真实的 authorized_keys**。
//   早先有个测试污染了 ~/.ssh/authorized_keys，所以这里用隔离的 HOME。
//   隔离之后，危险的调用应当直接返回非 0，且磁盘上不出现任何新行。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(path.dirname(HERE), 'fleet.mjs');

let pass = 0, fail = 0;
// 说明字段里可能包含被测 CLI 自己的输出，而 CLI 的输出本身会用 ✓/✗ 开头。
// 直接打印会让"通过"的断言看上去像失败行，把统计搞乱（实际发生过：
// 一条通过的断言打印成 "✗ --ki"，因为 CLI 的报错文本被截断后带进来）。
// 所以说明字段一律去掉这两个符号。
const sanitize = (s) => String(s ?? '').replace(/[✓✗]/g, '').trim();
const check = (l, c, e = '') => {
  const extra = sanitize(e);
  if (c) { pass++; console.log(`✓ ${l} ${extra}`); }
  else { fail++; console.log(`✗ ${l} ${extra}`); }
};

if (process.platform !== 'win32') {
  console.log('跳过：authorized_keys 路径逻辑是 Windows 特有的');
  console.log('\n0 通过, 0 失败');
  process.exit(0);
}

// 隔离 HOME，绝不碰真实 authorized_keys
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-cli-'));
const env = {
  ...process.env,
  HOME: sandbox,
  USERPROFILE: sandbox,
  FLEET_HOME: path.join(sandbox, '.dsh-fleet'),
  // 用于组装 authorized_keys 行；断掉真实路径
  SystemDrive: sandbox,
  ProgramData: path.join(sandbox, 'ProgramData'),
};
fs.mkdirSync(path.join(sandbox, 'ProgramData', 'ssh'), { recursive: true });

const run = (args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', timeout: 60_000, windowsHide: true, env,
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPFaWp1En8VpG+XUQbG4OyAUqbN/sexlImP0FD+9AI5C';

// 先 init 成 agent，accept 才走得通
const initR = run(['init', '--role', 'agent', '--name', 'test-agent']);
check('init 成功', initR.code === 0, initR.out.trim().slice(0, 60));

/* ============================================================
   1. 危险目标必须被 CLI 拒绝
   ============================================================ */
console.log('\n== 1. CLI 拒绝危险转发目标 ==');

const dangerous = [
  ['0.0.0.0:8787', '绑到所有网卡'],
  ['192.168.1.5:3306', '转发到内网他机 + 数据库端口'],
  ['127.0.0.1:22', 'SSH 端口（可绕过 from= 限制）'],
  ['127.0.0.1:3389', 'RDP 端口'],
  ['*:8787', '通配符'],
  ['evil.com:80', '外部域名'],
  ['127.0.0.1:8787-8790', '端口范围'],
  ['127.0.0.1:99999', '端口越界'],
];

for (const [target, why] of dangerous) {
  const r = run(['accept', '--controller', 'pc', '--pubkey', PUB, '--kind', 'ui', '--permit-open', target]);
  check(`拒绝 ${target}（${why}）`, r.code !== 0, `退出码 ${r.code}`);
}

/* ============================================================
   2. 拒绝之后，磁盘上不能留下任何授权行
   ============================================================ */
console.log('\n== 2. 拒绝后不留痕迹 ==');

const sshDir = path.join(sandbox, 'ProgramData', 'ssh');
const candidates = [
  path.join(sshDir, 'administrators_authorized_keys'),
  path.join(sandbox, '.ssh', 'authorized_keys'),
];
let leaked = [];
for (const f of candidates) {
  if (fs.existsSync(f)) {
    const txt = fs.readFileSync(f, 'utf8');
    if (txt.includes('AAAAC3NzaC1lZDI1NTE5')) leaked.push(f);
  }
}
check('拒绝的目标没有写进任何 authorized_keys', leaked.length === 0, leaked.join(', '));

/* ============================================================
   3. 合规目标应当被接受
   ============================================================ */
console.log('\n== 3. 合规目标被接受 ==');

const okR = run(['accept', '--controller', 'pc', '--pubkey', PUB, '--kind', 'ui', '--permit-open', '127.0.0.1:8787']);
check('接受 127.0.0.1:8787', okR.code === 0, `退出码 ${okR.code}`);

// 确认真的写进去了，且带正确的选项
let writtenText = '';
for (const f of candidates) {
  if (fs.existsSync(f)) {
    const t = fs.readFileSync(f, 'utf8');
    if (t.includes('AAAAC3NzaC1lZDI1NTE5')) writtenText += t;
  }
}
check('授权行已落盘', writtenText.length > 0);
check('行内含 restrict', writtenText.includes('restrict'));
check('行内含 port-forwarding', writtenText.includes('port-forwarding'));
check('行内含 permitopen=127.0.0.1:8787', writtenText.includes('permitopen="127.0.0.1:8787"'));
// ui key 绝不能带 command=，否则浏览器连不上（客户端无法建立转发通道之外的会话）
check('行内不含 command=', !writtenText.includes('command='));
// agent 用途的 from= 必须仍在，防止"谁拿到 key 都能用"
check('行内含 from= 限制', writtenText.includes('from='));

/* ============================================================
   4. 默认用途仍是 agent，不能因为加了 ui 就改变默认行为
   ============================================================ */
console.log('\n== 4. 默认用途保持 agent ==');

const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-cli2-'));
const env2 = {
  ...process.env, HOME: fresh, USERPROFILE: fresh,
  FLEET_HOME: path.join(fresh, '.dsh-fleet'),
  SystemDrive: fresh, ProgramData: path.join(fresh, 'ProgramData'),
};
fs.mkdirSync(path.join(fresh, 'ProgramData', 'ssh'), { recursive: true });
const run2 = (args) => {
  const r = spawnSync(process.execPath, [CLI, ...args],
    { encoding: 'utf8', timeout: 60_000, windowsHide: true, env: env2 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

run2(['init', '--role', 'agent', '--name', 'a2']);
const defR = run2(['accept', '--controller', 'pc', '--pubkey', PUB]);
check('不带 --kind 时成功', defR.code === 0);

let defText = '';
for (const f of [path.join(fresh, 'ProgramData', 'ssh', 'administrators_authorized_keys'),
                 path.join(fresh, '.ssh', 'authorized_keys')]) {
  if (fs.existsSync(f)) {
    const t = fs.readFileSync(f, 'utf8');
    if (t.includes('AAAAC3NzaC1lZDI1NTE5')) defText += t;
  }
}
check('默认用途不含 port-forwarding（仍是纯 agent）', !defText.includes('port-forwarding'));
check('默认用途含 restrict', defText.includes('restrict'));

/* ============================================================
   5. ui 用途缺少目标时必须报错，不能默默用默认值
   ============================================================ */
console.log('\n== 5. ui 缺目标时报错 ==');

const noTarget = run(['accept', '--controller', 'pc', '--pubkey', PUB, '--kind', 'ui']);
check('--kind ui 但不给 --permit-open 时报错', noTarget.code !== 0, `退出码 ${noTarget.code}`);
// 除非本机已经配置过允许的目标，否则必须报错
check('错误提示里说明了需要 --permit-open',
  noTarget.out.includes('permit-open') || noTarget.out.includes('permit_open'),
  noTarget.out.trim().slice(0, 70));

/* ============================================================
   6. 未知用途必须被拒
   ============================================================ */
console.log('\n== 6. 未知用途被拒 ==');

for (const kind of ['admin', 'root', 'shell', '']) {
  const r = run(['accept', '--controller', 'pc', '--pubkey', PUB, '--kind', kind, '--permit-open', '127.0.0.1:8787']);
  check(`拒绝 --kind ${JSON.stringify(kind)}`, r.code !== 0, `退出码 ${r.code}`);
}

/* ---------- 清理 ---------- */
for (const d of [sandbox, fresh]) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { }
}

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
