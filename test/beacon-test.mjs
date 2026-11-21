import { createToken, verifyBeacon, startBeaconServer, sendBeacon, BEACON_VERSION } from '../lib/beacon.mjs';

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { console.log('  ✓ ' + label); pass++; }
  else { console.log('  ✗ ' + label + (extra ? '  -> ' + extra : '')); fail++; }
};

const now = Date.now();
const token = createToken();
const base = {
  v: BEACON_VERSION,
  token,
  ts: now,
  name: 'laptop-b',
  host: 'TENYE-B',
  user: 'hp',
  ips: ['100.71.88.99', 'fd7a::1'],
  os: 'windows',
  dshVersion: '0.2.2',
  nodeVersion: '24.14.1',
  publicKey: 'ssh-ed25519 AAAAC3...',
};

console.log('=== verifyBeacon 单元测试 ===');

// 正常通过
const good = verifyBeacon(base, { token, now });
ok('合法消息通过', good.ok, good.reason);
ok('取出 IPv4', good.ok && good.agent.tailscaleIp === '100.71.88.99');
ok('取出用户名', good.ok && good.agent.user === 'hp');

// 令牌错误
const badToken = verifyBeacon({ ...base, token: createToken() }, { token, now });
ok('令牌不对被拒', !badToken.ok && badToken.reason.includes('令牌'));

// 缺令牌
ok('缺令牌被拒', !verifyBeacon({ ...base, token: '' }, { token, now }).ok);

// 重放：时间戳太旧
const old = verifyBeacon({ ...base, ts: now - 10 * 60 * 1000 }, { token, now });
ok('时间戳过旧被拒（挡重放）', !old.ok && old.reason.includes('时间戳'));

// 时间戳在未来太远
const future = verifyBeacon({ ...base, ts: now + 10 * 60 * 1000 }, { token, now });
ok('时间戳过未来被拒', !future.ok);

// 边界：刚好 4 分钟应通过
const edge = verifyBeacon({ ...base, ts: now - 4 * 60 * 1000 }, { token, now });
ok('4 分钟偏差仍通过', edge.ok, edge.reason);

// 版本不符
ok('协议版本不符被拒', !verifyBeacon({ ...base, v: 999 }, { token, now }).ok);

// 缺 IPv4
const noIp = verifyBeacon({ ...base, ips: ['fd7a::1'] }, { token, now });
ok('只有 IPv6 被拒（无法当 SSH 目标）', !noIp.ok && noIp.reason.includes('IPv4'));

// 缺用户名
ok('缺用户名被拒', !verifyBeacon({ ...base, user: '' }, { token, now }).ok);

// 不是对象
ok('非对象被拒', !verifyBeacon(null, { token, now }).ok);
ok('字符串被拒', !verifyBeacon('hello', { token, now }).ok);

// 空令牌配置不能匹配任何东西
ok('服务端无令牌时拒绝一切', !verifyBeacon(base, { token: '', now }).ok);

console.log('');
console.log('=== 端到端：真实 HTTP 报名 ===');

const HOST = '100.71.88.73';
const PORT = 47322;
const enrollToken = createToken();
const received = [];

const srv = startBeaconServer({
  host: HOST,
  port: PORT,
  token: enrollToken,
  onAgent: (a) => received.push(a),
  onLog: (l) => console.log('    [srv] ' + l),
});

await new Promise((r) => setTimeout(r, 800));

// 1. 用正确令牌报名
const r1 = await sendBeacon({
  url: `http://${HOST}:${PORT}/beacon`,
  token: enrollToken,
  self: { name: 'laptop-b', host: 'TENYE-B', user: 'hp', ips: ['100.71.88.99'], os: 'windows' },
});
ok('正确令牌报名成功', r1.ok, JSON.stringify(r1));
ok('服务端收到并登记', received.length === 1, 'received=' + received.length);
ok('登记的 IP 正确', received[0] && received[0].tailscaleIp === '100.71.88.99');

// 2. 用错误令牌报名
const r2 = await sendBeacon({
  url: `http://${HOST}:${PORT}/beacon`,
  token: createToken(),
  self: { name: 'attacker', host: 'EVIL', user: 'x', ips: ['100.71.88.66'], os: 'windows' },
});
ok('错误令牌被拒（403）', !r2.ok && r2.status === 403, 'status=' + r2.status);
ok('错误令牌没有登记', received.length === 1);

// 3. 错误路径
const r3 = await sendBeacon({
  url: `http://${HOST}:${PORT}/wrong-path`,
  token: enrollToken,
  self: { name: 'x', host: 'x', user: 'x', ips: ['100.71.88.1'], os: 'windows' },
});
ok('错误路径返回 404', !r3.ok && r3.status === 404, 'status=' + r3.status);

await srv.close();

console.log('');
console.log('总计: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
