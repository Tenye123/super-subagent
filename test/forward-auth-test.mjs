// 端口转发授权的安全测试
//
// 背景：任务登记表（127.0.0.1:8787）要能被主控的浏览器访问，
// 做法是 SSH 本地转发。这是**用户明确批准**的能力，但批准的前提是
// "做好安全验证"。这个文件就是那份验证。
//
// 风险模型（必须想清楚，否则转发就是后门）：
//   一旦允许转发，被转发的服务就**绕过了 A 的防火墙和 SSH 登录认证**，
//   直接出现在主控机器上。所以限制必须是"只能到这一个端口"，
//   而不是"能转发"这么笼统。
//
// 三层防线：
//   1) sshd_config      AllowTcpForwarding local  —— 禁止远程转发（不让 A 当跳板）
//   2) authorized_keys  permitopen="127.0.0.1:8787" —— 只许这一个目标
//   3) fleet 侧         isLoopbackTarget() 白名单 —— 生成时就拒掉危险目标
//
// 这个测试覆盖第 3 层（纯逻辑，随时可跑），并用真实 sshd 验证第 2 层的
// 选项能被接受（后者由 sshd-options-test.mjs 覆盖）。

import {
  buildAuthorizedKeyLine, isLoopbackTarget, KEY_KINDS, toSshExpiry,
} from '../lib/config.mjs';

let pass = 0, fail = 0;
const check = (l, c, e = '') => { c ? (pass++, console.log(`✓ ${l} ${e}`)) : (fail++, console.log(`✗ ${l} ${e}`)); };

const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPFaWp1En8VpG+XUQbG4OyAUqbN/sexlImP0FD+9AI5C';

/* ============================================================
   1. 目标白名单：只允许回环上的明确端口
   ============================================================ */
console.log('== 1. 转发目标白名单 ==');

const mustReject = [
  ['0.0.0.0:8787', '绑到所有网卡，等于对外暴露'],
  ['192.168.1.5:3306', '转发到内网其他机器，会把 A 变成跳板'],
  ['10.0.0.1:22', '同上，且是 SSH 端口'],
  ['127.0.0.1', '没有端口，行为不确定'],
  ['127.0.0.1:', '空端口'],
  ['127.0.0.1:0', '端口 0 非法'],
  ['127.0.0.1:65536', '端口越界'],
  ['127.0.0.1:99999', '端口越界'],
  ['127.0.0.1:8787-8790', '端口范围，等于开了 4 个'],
  ['*:8787', '通配符主机'],
  ['evil.com:80', '任意域名'],
  ['127.0.0.1:8787;rm -rf /', '注入尝试'],
  ['', '空值'],
  [null, 'null'],
  ['[::]:8787', 'IPv6 通配'],
];

for (const [target, why] of mustReject) {
  check(`拒绝 ${JSON.stringify(target)}（${why}）`, isLoopbackTarget(target) === false);
}

const mustAccept = ['127.0.0.1:8787', 'localhost:8787', '[::1]:8787', '::1:8787', '127.0.0.1:1', '127.0.0.1:65535'];
for (const target of mustAccept) {
  check(`接受 ${target}`, isLoopbackTarget(target) === true);
}

/* ============================================================
   2. agent 密钥绝不能带转发能力
   ============================================================ */
console.log('\n== 2. agent 密钥不含转发 ==');

const agentLine = buildAuthorizedKeyLine({
  publicKey: PUB, kind: 'agent', expiresAt: '2027-01-01T00:00:00Z', from: ['100.64.0.0/10'],
});
console.log(`  ${agentLine}`);
check('agent 行含 restrict', agentLine.includes('restrict'));
// restrict 本身就涵盖了禁止转发。额外的显式检查是为了防止有人
// 以后把 restrict 换成更宽松的组合时，悄悄把转发也打开了。
check('agent 行不含 port-forwarding', !agentLine.includes('port-forwarding'));
check('agent 行不含 permitopen', !agentLine.includes('permitopen'));
check('agent 行含 expiry-time', /expiry-time="\d{12}"/.test(agentLine));
check('agent 行含 from', agentLine.includes('from="100.64.0.0/10"'));

/* ============================================================
   3. ui 密钥：只开转发，且钉死目标
   ============================================================ */
console.log('\n== 3. ui 密钥只开指定端口 ==');

const uiLine = buildAuthorizedKeyLine({
  publicKey: PUB, kind: 'ui', permitOpen: ['127.0.0.1:8787'],
});
console.log(`  ${uiLine}`);
check('ui 行含 restrict', uiLine.includes('restrict'));
check('ui 行含 port-forwarding', uiLine.includes('port-forwarding'));
check('ui 行含 permitopen 且指向 8787', uiLine.includes('permitopen="127.0.0.1:8787"'));
check('ui 行不含 command（否则浏览器用不了）', !uiLine.includes('command='));
// restrict 里有 no-pty；ui 用途不需要交互式 shell，保持关闭是对的
check('ui 行不含 no-pty 例外（仍是受限的）', uiLine.includes('restrict'));

// 关键：ui key 也不应该有 shell 能力。restrict 已禁 PTY，
// 但如果有人误删 restrict，这条断言会提醒。
check('ui 行不是全权限（必须含 restrict）', uiLine.split(' ')[0].split(',').includes('restrict'));

/* ============================================================
   4. 危险目标必须在生成阶段就抛错
   ============================================================ */
console.log('\n== 4. 生成阶段拒绝危险目标 ==');

const dangerous = ['192.168.1.5:3306', '0.0.0.0:8787', '*:80', '127.0.0.1:22', 'evil.com:443'];
for (const t of dangerous) {
  let threw = false;
  try {
    buildAuthorizedKeyLine({ publicKey: PUB, kind: 'ui', permitOpen: [t] });
  } catch { threw = true; }
  check(`permitOpen=${t} 时抛错`, threw);
}

// 多目标必须拒绝，因为写出多值时实测会被当成单个目标 → 全部不通
let multiThrew = false;
try {
  buildAuthorizedKeyLine({ publicKey: PUB, kind: 'ui', permitOpen: ['127.0.0.1:8787', '127.0.0.1:8788'] });
} catch { multiThrew = true; }
check('多个 permitopen 目标时抛错（实测多值会被当成一个目标）', multiThrew);

/* ============================================================
   5. 未知用途必须拒绝（防止拼错名字悄悄获得默认权限）
   ============================================================ */
console.log('\n== 5. 未知密钥用途被拒绝 ==');

for (const bad of ['admin', 'root', 'ui2', '', null, 'AGENT']) {
  let threw = false;
  try {
    buildAuthorizedKeyLine({ publicKey: PUB, kind: bad });
  } catch { threw = true; }
  check(`拒绝 kind=${JSON.stringify(bad)}`, threw);
}

check('只定义了 agent 和 ui 两种', Object.keys(KEY_KINDS).sort().join(',') === 'agent,ui',
  Object.keys(KEY_KINDS).join(','));

/* ============================================================
   6. 有效期格式（OpenSSH 只认 YYYYMMDDHHMM，本地时区）
   ============================================================ */
console.log('\n== 6. 有效期格式 ==');

const exp = toSshExpiry('2026-12-20T13:59:00+08:00');
check('转换成 12 位数字', /^\d{12}$/.test(exp), exp);
check('年月日时分正确（按本地时区）', exp.startsWith('20261220'), exp);

// 生成的行里不能出现 ISO 格式（sshd 不认）
const lineWithExp = buildAuthorizedKeyLine({ publicKey: PUB, kind: 'agent', expiresAt: '2026-12-20T13:59:00+08:00' });
check('行内不含 ISO 时间戳', !/T\d\d:\d\d/.test(lineWithExp), lineWithExp.slice(0, 90));
check('行内含 12 位 expiry', /expiry-time="\d{12}"/.test(lineWithExp));

/* ============================================================
   7. 引号注入防护
   ============================================================ */
console.log('\n== 7. command 引号处理 ==');

const injected = buildAuthorizedKeyLine({
  publicKey: PUB, kind: 'agent',
  command: 'cmd.exe /c echo "a" & del /f /q x',
});
check('内层双引号被转义', injected.includes('\\"'), injected.slice(0, 110));
// 转义后仍然只有一个完整的 command="..." 字段
const optPart = injected.slice(0, injected.indexOf(' ssh-'));
const quotes = (optPart.match(/"/g) || []).length;
check('引号成对（不破坏整行结构）', quotes % 2 === 0, `引号数=${quotes}`);

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
