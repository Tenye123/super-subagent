// 验证"一条命令"这条链路真的成立。
//
// 这条链路是产品的核心卖点，也是最容易「本地测通、真机失败」的地方：
//   /bootstrap 生成脚本 → 缓存 → 目标机器从 tailnet 地址 irm 下来 → 是完整脚本
//
// 所以这里不用 127.0.0.1 测，而是用**本机 tailnet 地址**测——
// 那正是目标机器将来要访问的地址。如果这条通不了，任何前端包装都是假的。

import { apply } from '../lib/index.js';

let pass = 0;
let fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) {
    console.log('  ✓ ' + label);
    pass++;
  } else {
    console.log('  ✗ ' + label + (extra ? '  -> ' + extra : ''));
    fail++;
  }
};

const disposers = [];
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  effect: (fn) => {
    const d = fn();
    if (typeof d === 'function') disposers.push(d);
  },
};

apply(ctx);
await new Promise((r) => setTimeout(r, 1200));

console.log('=== 生成本机状态 ===');

const API = 'http://127.0.0.1:6210';
const status = await (await fetch(API + '/status')).json();
const tailIp = status.self && status.self.tailscaleIp;
ok('有 tailnet 地址', Boolean(tailIp), JSON.stringify(status.self));

if (!tailIp) {
  console.log('\n没有 tailnet 地址，后续测试无法进行');
  process.exit(1);
}

console.log('');
console.log('=== 生成脚本并拿到 genId ===');

const boot = await (
  await fetch(API + '/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentName: 'e2e-agent' }),
  })
).json();

ok('生成成功', boot.ok === true, JSON.stringify(boot).slice(0, 200));
ok('返回了 genId', typeof boot.genId === 'string' && boot.genId.length > 8, boot.genId);
ok('genId 不可猜（长度足够）', String(boot.genId).length >= 12, String(boot.genId).length + ' 字符');

console.log('');
console.log('=== 从 tailnet 地址下载脚本（目标机器视角）===');

// 这正是被控端要执行的地址。
const dlUrl = `http://${tailIp}:47321/setup.ps1?id=${encodeURIComponent(boot.genId)}`;
console.log('  GET ' + dlUrl);

let dl = null;
let dlErr = '';
try {
  const res = await fetch(dlUrl, { signal: AbortSignal.timeout(15000) });
  dl = { status: res.status, text: await res.text(), type: res.headers.get('content-type') };
} catch (e) {
  dlErr = String(e.message || e);
}

ok('tailnet 地址可达', !dlErr, dlErr);

if (dl) {
  ok('HTTP 200', dl.status === 200, 'status=' + dl.status);
  ok('content-type 是 text/plain', /text\/plain/.test(String(dl.type)), dl.type);
  ok('内容与生成的一致', dl.text === boot.script, '长度 ' + dl.text.length + ' vs ' + boot.script.length);
  ok('下载到的是纯 ASCII', !/[^\x00-\x7F]/.test(dl.text));
  ok('脚本含控制器地址', dl.text.includes("$ControllerIp   = '" + tailIp + "'"));
  console.log('  下载 ' + dl.text.length + ' 字节');
}

console.log('');
console.log('=== 失效与越权路径 ===');

// 1. 错的 id 必须 404，不能返回任何脚本
{
  const res = await fetch(`http://${tailIp}:47321/setup.ps1?id=nonexistent`, {
    signal: AbortSignal.timeout(10000),
  });
  const body = await res.text();
  ok('错误 id 返回 404', res.status === 404, 'status=' + res.status);
  ok('错误 id 不泄露脚本', !body.includes('$ControllerIp'));
}

// 2. 没有 id 也必须 404
{
  const res = await fetch(`http://${tailIp}:47321/setup.ps1`, {
    signal: AbortSignal.timeout(10000),
  });
  ok('缺 id 返回 404', res.status === 404, 'status=' + res.status);
}

// 3. 该端口上除 /beacon 和 /setup.ps1 外都应 404
{
  const res = await fetch(`http://${tailIp}:47321/anything`, {
    signal: AbortSignal.timeout(10000),
  });
  ok('未知路径返回 404', res.status === 404, 'status=' + res.status);
}

// 4. 报名接口仍然工作（同一个监听面上两个功能共存）
{
  const res = await fetch(`http://${tailIp}:47321/beacon`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ v: 1, token: 'wrong', ts: Date.now(), name: 'x', user: 'x', ips: ['1.2.3.4'] }),
    signal: AbortSignal.timeout(10000),
  });
  ok('报名接口仍在同一端口上工作（错误令牌被拒）', res.status === 403, 'status=' + res.status);
}

console.log('');
console.log('=== 清理 ===');
for (const d of disposers) await d();
await new Promise((r) => setTimeout(r, 600));

// 清理后该端口应当完全关闭，不能留下任何可达的服务
let closed = false;
try {
  await fetch(`http://${tailIp}:47321/setup.ps1?id=x`, {
    signal: AbortSignal.timeout(3000),
    headers: { connection: 'close' },
  });
} catch {
  closed = true;
}
ok('清理后 tailnet 监听面已关闭', closed);

console.log('');
console.log('总计: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
