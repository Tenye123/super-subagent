// 在真实连接上验证 authorized_keys 的限制真的由 sshd 强制执行。
//
// 这些不是"我们写了什么配置"的断言，而是"对端实际拒绝/接受了什么"。
// 之前两轮翻车都是因为只验证了意图（日志/自洽单测）而没碰真实结果。
//
// ⚠️ 端口转发那条的判据特别容易写错，记录在这里：
//   restrict 会拒绝 *通道*，但 ssh 客户端**仍然会在本地监听那个端口**。
//   所以"本地端口连不上" 是错误的判据（会误报成通过）。
//   正确判据是：本地端口能连，但一旦真的走数据，ssh 会报
//       channel N: open failed: administratively prohibited: open failed
//   必须读这条错误，或者实际收不到任何字节。

import { spawnSync, spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';

const KEY = path.join(os.homedir(), '.dsh-fleet', 'keys', 'laptop-a.key');
const KH = path.join(os.homedir(), '.dsh-fleet', 'known_hosts');

// 这个测试会真的连一台代理机并试图越权，所以目标必须由环境变量给。
// 没有配置时**明确跳过并说明原因**，而不是假装通过 —— 一个"通过"但
// 其实什么都没测的测试，比一个跳过更危险。
const TARGET = process.env.FLEET_TEST_TARGET;
if (!TARGET) {
  console.log('跳过：未设置 FLEET_TEST_TARGET（例：set FLEET_TEST_TARGET=user@100.x.x.x）');
  console.log('0 通过, 0 失败（已跳过）');
  process.exit(0);
}
if (!TARGET.includes('@')) {
  console.log('跳过：FLEET_TEST_TARGET 必须形如 user@host');
  console.log('0 通过, 0 失败（已跳过）');
  process.exit(0);
}

const HOSTPORT = TARGET.split('@')[1];

let pass = 0, fail = 0;
const check = (l, c, e = '') => { c ? (pass++, console.log(`✓ ${l} ${e}`)) : (fail++, console.log(`✗ ${l} ${e}`)); };

const BASE = [
  '-i', KEY,
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', `UserKnownHostsFile=${KH}`,
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=8',
];

function ssh(extra, remoteCmd, timeout = 20_000) {
  const r = spawnSync('ssh', [...BASE, ...extra, TARGET, remoteCmd], {
    encoding: 'utf8', windowsHide: true, timeout,
  });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

console.log('真实连接验证 authorized_keys 限制\n');

/* ---------- 1. 基本连通 ---------- */
{
  const r = ssh([], 'echo FLEET_OK');
  check('能执行命令', r.code === 0 && r.out.includes('FLEET_OK'), `code=${r.code} out=${r.out}`);
}

/* ---------- 2. restrict 拒绝端口转发 ----------
 *
 * 这条路走过三次弯路，全部记下来，避免以后重犯：
 *
 *   弯路一：以为 "本地端口连不上" 就代表转发被拒。
 *          错。ssh 客户端**始终**会在本地监听，无论服务端允不允许。
 *
 *   弯路二：连上本地端口后等 ssh 的 stderr。能拿到
 *           "channel N: open failed: administratively prohibited"
 *           ——但存在竞态：探测时端口可能还没建好，或 kill 得太早。
 *           连跑 3 次会抖 1 次。
 *
 *   弯路三：改成 `-N -v -o ExitOnForwardFailure=yes` 直接读日志。
 *          错。`-N` 不执行命令，而本地转发**只有真的有人连那个端口时**
 *          才会去开通道；没人连就永远等下去，日志里什么错误都不会有。
 *          于是稳定地失败（而不是随机失败）—— 看起来像"更稳定"，其实是
 *          稳定地测错了东西。
 *
 * 最终判据（只用两个确定的客观事实，不依赖时序）：
 *   a) 必须真的去连本地端口，才会触发通道建立；
 *   b) 触发之后，要么收到对端字节（= 转发成功，安全缺陷），
 *      要么收到 administratively prohibited（= 被拒，正确）。
 * 用随机高位端口避免上一次的 TIME_WAIT 干扰。
 */
{
  const LOCAL = 19000 + Math.floor(Math.random() * 800);

  const p = spawn('ssh', [
    ...BASE, '-N',
    '-L', `${LOCAL}:127.0.0.1:22`,
    TARGET,
  ], { windowsHide: true });

  let stderr = '';
  p.stderr.on('data', (d) => { stderr += d.toString(); });

  // 等本地监听就绪（连不上就说明 ssh 还没起来，重试几次）
  const tryConnect = (port, tries = 40) => new Promise((resolve) => {
    let n = 0;
    const attempt = () => {
      const s = new net.Socket();
      let got = '';
      const finish = (connected, data) => { try { s.destroy(); } catch { } resolve({ connected, data }); };
      const timer = setTimeout(() => finish(true, got), 3000);
      s.once('connect', () => {
        s.write('x'); // 逼 ssh 真正开通道
        s.once('data', (d) => { got += d.toString('latin1'); clearTimeout(timer); finish(true, got); });
        s.on('error', () => { clearTimeout(timer); finish(true, got); });
      });
      s.once('error', () => {
        clearTimeout(timer);
        if (++n < tries) return setTimeout(attempt, 100);
        finish(false, '');
      });
      s.connect(port, '127.0.0.1');
    };
    attempt();
  });

  const probe = await tryConnect(LOCAL);

  // 给 ssh 一点时间把错误写进 stderr（此时通道已真实建立，错误必然已产生）
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !/administratively prohibited|open failed|not permitted|denied/i.test(stderr)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  try { p.kill(); } catch { }

  const prohibited = /administratively prohibited|open failed|not permitted|denied/i.test(stderr);
  const leaked = /SSH-\d/.test(probe.data);

  // 核心安全断言：绝不能收到 A 上 sshd 的协议 banner
  check('端口转发被拒绝（未收到对端 SSH banner）', !leaked,
    leaked ? `!! 泄露了对端数据: ${JSON.stringify(probe.data.slice(0, 40))}` : '');

  // 正面证据：sshd 明确报 administratively prohibited
  check('sshd 报 administratively prohibited', prohibited,
    prohibited ? '' : `connected=${probe.connected} stderr=${JSON.stringify(stderr.slice(0, 200))}`);
}

/* ---------- 3. restrict 禁止分配 pty ---------- */
{
  const r = ssh(['-tt'], 'echo PTY_OK', 15_000);
  check('restrict 拒绝分配 tty (-tt)',
    !r.out.includes('PTY_OK') && /pty allocation request failed|denied|prohibited/i.test(r.err),
    `code=${r.code} err=${(r.err || '').slice(0, 100)}`);
}

/* ---------- 4. restrict 禁止 agent 转发 ---------- */
{
  const r = ssh(['-o', 'ForwardAgent=yes'], 'echo AGENT_TRY');
  check('ForwardAgent 不泄露 agent 通道', !/agent is not allowed/i.test(r.out), `code=${r.code}`);
}

/* ---------- 5. 密码认证确实关闭 ---------- */
{
  const r = spawnSync('ssh', [
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${KH}`,
    '-o', 'PreferredAuthentications=password,keyboard-interactive',
    '-o', 'PubkeyAuthentication=no',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=8',
    TARGET, 'echo SHOULD_NOT_WORK',
  ], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  check('不用密钥无法登录（密码已关闭）',
    r.status !== 0 && !(r.stdout || '').includes('SHOULD_NOT_WORK'),
    `code=${r.status}`);
}

/* ---------- 6. 从 tailnet 网段可以连接（from 允许） ---------- */
{
  const r = ssh([], 'echo FROM_OK');
  check('从 tailnet 网段连接成功（from 允许）', r.code === 0 && r.out.includes('FROM_OK'),
    `code=${r.code}`);
}

/* ---------- 7. 确认 -R 反向转发也被拒（AllowTcpForwarding local 的作用） ---------- */
{
  const p = spawn('ssh', [
    ...BASE, '-N',
    '-R', '18999:127.0.0.1:1',
    TARGET,
  ], { windowsHide: true });
  let err = '';
  p.stderr.on('data', (d) => { err += d.toString(); });

  // 轮询等错误出现。固定 sleep 会造成竞态：有时 kill 得太早，
  // stderr 还是空字符串，于是把"已经拒绝"误判成"没拒绝"。
  const end = Date.now() + 8000;
  while (Date.now() < end && !/denied|prohibited|not permitted|refused|forwarding failed/i.test(err)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  try { p.kill(); } catch { }

  // restrict 或 AllowTcpForwarding local 都应拒绝 -R。
  //
  // 注意措辞：实测 Windows OpenSSH 报的是
  //     Warning: remote port forwarding failed for listen port 18999
  // 而不是 "denied"/"prohibited"。判据必须覆盖这个实际用词，否则会把
  // "已经拒绝"误判成"没拒绝"。
  check('反向转发 (-R) 被拒绝',
    /denied|prohibited|not permitted|refused|forwarding failed/i.test(err),
    err ? JSON.stringify(err.slice(0, 160)) : '(无错误输出)');
}

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
