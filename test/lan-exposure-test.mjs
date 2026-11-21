// 从**主控机**验证代理机的端口暴露面。
//
// 这个测试补上一个本地测不出来的空洞：
//   - 代理机用自己 LAN IP 连自己 → 走回环，Windows 豁免防火墙 → 永远"可达"
//   - 从 WSL 连 → 经 Hyper-V vSwitch 绕过入站规则 → 也"可达"
// 所以"LAN 连不上 22"这个断言，只能在另一台机器上验证。
//
// 这里从 B 发起真实 TCP 连接：
//   A 的 LAN IP    : 22 → 必须 False（局域网打不开）
//   A 的 tailnet IP: 22 → 必须 True （通过 Tailscale 能进）
//
// 如果 A 不在线，tailnet 那条会失败 —— 那是环境问题，不是安全缺陷。
// 测试必须区分这两种情况，否则会把"机器没开"误报成"安全配置坏了"。

import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

let pass = 0, fail = 0;
const check = (l, c, e = '') => { c ? (pass++, console.log(`✓ ${l} ${e}`)) : (fail++, console.log(`✗ ${l} ${e}`)); };

function readConfig() {
  const home = process.env.FLEET_HOME || path.join(os.homedir(), '.dsh-fleet');
  const p = path.join(home, 'fleet.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function tcpProbe(host, port, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const finish = (ok, reason) => {
      if (done) return;
      done = true;
      try { s.destroy(); } catch { }
      resolve({ ok, reason });
    };
    s.setTimeout(timeoutMs);
    s.once('connect', () => finish(true, 'connected'));
    s.once('timeout', () => finish(false, 'timeout'));
    s.once('error', (e) => finish(false, e.code || 'error'));
    s.connect(port, host);
  });
}

const cfg = readConfig();
const dev = cfg?.devices?.find((d) => d.name === 'laptop-a');

if (!dev) {
  console.log('跳过：本地没有 laptop-a 的配置（这台可能不是主控机）');
  console.log('\n0 通过, 0 失败');
  process.exit(0);
}

console.log(`设备 laptop-a → tailnet ${dev.tailscaleIp}` + (dev.lanIp ? `, LAN ${dev.lanIp}` : ''));
console.log('');

/* ---------- 1. tailnet 可达：证明 A 在线且 sshd 在服务 ---------- */
const tail = await tcpProbe(dev.tailscaleIp, 22);
check('从主控机连 A 的 tailnet:22 成功', tail.ok, tail.ok ? '' : `(${tail.reason})`);

if (!tail.ok) {
  console.log('');
  console.log('A 当前不可达（tailnet 连接失败），跳过局域网暴露面断言——');
  console.log('否则会把"机器没开"误报成"安全配置有问题"。');
  console.log(`\n${pass} 通过, ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}

/* ---------- 2. LAN 不可达：核心安全断言 ---------- */
if (!dev.lanIp) {
  console.log('跳过：配置里没记录 A 的 lanIp，无法验证局域网暴露面');
  console.log('     （可在 fleet.json 的设备条目里补 "lanIp": "192.168.x.x"）');
} else {
  const lan = await tcpProbe(dev.lanIp, 22);
  check(`从主控机连 A 的 LAN:22 必须失败（${dev.lanIp}）`,
    !lan.ok,
    lan.ok ? '!! 严重：局域网能连上 22 端口' : `(已阻断：${lan.reason})`);

  /* ---------- 3. 两机是否同网段：证明不共享网络 ---------- */
  const localNets = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) localNets.push({ name, ip: a.address });
    }
  }

  const prefix = (ip) => ip.split('.').slice(0, 3).join('.');
  const sameSubnet = localNets.filter((n) => prefix(n.ip) === prefix(dev.lanIp));

  // 同一 /24 意味着两台机器共享网络，那"打游戏不卡"的前提就不成立了。
  // 注意这只在 A 的 lanIp 于本机不可达时才有意义 —— 已在上面验证过。
  check('主控机与代理机不在同一 /24 网段（不共享网络）',
    sameSubnet.length === 0,
    sameSubnet.length
      ? `!! 同网段接口: ${sameSubnet.map((n) => `${n.name}=${n.ip}`).join(', ')}`
      : `(本机: ${localNets.map((n) => n.ip).join(', ')})`);
}

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
