// 端口转发策略的端到端验证（真实流量，不是读配置）
//
// 为什么必须用真实流量：
//   这个项目里"看起来通过"的假阳性已经出现过三次：
//     - $?-based 判定把 ssh 的"连接失败"当成"被拒绝"
//     - `ssh -L` 的本地监听被当成"转发成功"（客户端总会监听，与策略无关）
//     - 只读 sshd_config 文本，结果 Match 块里的指令覆盖了全局值
//   唯一可信的判据是：**真实字节有没有穿过隧道**。
//
// 四个用例（case3 是关键）：
//   1 agent 密钥（只有 restrict）        -> 8787  必须被拒
//   2 ui 密钥（permitopen=8787）         -> 8787  必须成功
//   3 ui 密钥                            -> 8899  必须被拒  <- 证明限制真实存在
//   4 ui 密钥但 permitopen 指向 22       -> 22    必须被拒  <- 证明不能自开后门
//
// 没有 case3，case2 通过只能说明"转发是开着的"，说明不了"限制起了作用"。

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';

let pass = 0, fail = 0;
const check = (l, c, e = '') => { c ? (pass++, console.log(`✓ ${l} ${e}`)) : (fail++, console.log(`✗ ${l} ${e}`)); };

const SSHD = 'C:\\Program Files\\OpenSSH\\sshd.exe';
const SSH = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
const KEYGEN = 'C:\\Windows\\System32\\OpenSSH\\ssh-keygen.exe';

// 环境不具备就跳过，而不是报失败（例如在 CI 或非 Windows 上）
if (process.platform !== 'win32' || !fs.existsSync(SSHD) || !fs.existsSync(KEYGEN)) {
  console.log('跳过：本机没有 OpenSSH server');
  console.log('\n0 通过, 0 失败');
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fwtest-'));
const SSHD_PORT = 22022 + Math.floor(Math.random() * 500);

// Do NOT hardcode 8787 here.
//   The real task registry already listens on 127.0.0.1:8787 on this machine,
//   so binding it makes the test fail with EADDRINUSE -- and worse, if it did
//   bind, we could not tell our stub from the real service.
//   Use two arbitrary free ports instead: the policy only cares that one port
//   is allowed and the other is not.
const ALLOWED = 0;  // resolved below
const DENIED = 0;   // resolved below
let allowedPort, deniedPort;

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

/* ---------- 1. 密钥 ---------- */
function keygen(name) {
  const base = path.join(tmp, name);
  const r = spawnSync(KEYGEN, ['-t', 'ed25519', '-f', base, '-N', '', '-q'],
    { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`ssh-keygen 失败: ${r.stderr}`);
  return { priv: base, pub: fs.readFileSync(`${base}.pub`, 'utf8').trim() };
}

const agentKey = keygen('agentkey');
const uiKey = keygen('uikey');
const badKey = keygen('badkey');
const hostKey = keygen('hostkey');
check('生成 3 把测试密钥 + host key', Boolean(agentKey.pub && uiKey.pub && badKey.pub));

/* ---------- 2. 目标服务：同一个 server 监听两个端口 ---------- */
// 只让"端口号"成为唯一变量：策略允许 allowedPort，不允许 deniedPort。
allowedPort = await freePort();
deniedPort = await freePort();
const ALLOWED_PORT = allowedPort;
const DENIED_PORT = deniedPort;

const targetPorts = [ALLOWED_PORT, DENIED_PORT];
const targetServers = [];
for (const p of targetPorts) {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '6' });
    res.end('TARGET');
  });
  await new Promise((r) => srv.listen(p, '127.0.0.1', r));
  targetServers.push(srv);
}
check(`${ALLOWED_PORT} 与 ${DENIED_PORT} 上的目标服务已就绪`, targetServers.length === 2);

/* ---------- 3. 临时 sshd ---------- */
const akPath = path.join(tmp, 'authorized_keys');
fs.writeFileSync(akPath, [
  `restrict ${agentKey.pub} agent-test`,
  // ui：只打开转发，且钉死到被允许的那个端口
  `restrict,port-forwarding,permitopen="127.0.0.1:${ALLOWED_PORT}" ${uiKey.pub} ui-test`,
  // bad：故意把 permitopen 指向 SSH 端口，验证它同样被拒
  `restrict,port-forwarding,permitopen="127.0.0.1:22" ${badKey.pub} bad-test`,
].join('\r\n') + '\r\n', 'ascii');

const cfgPath = path.join(tmp, 'sshd_config');
fs.writeFileSync(cfgPath, [
  `Port ${SSHD_PORT}`,
  'ListenAddress 127.0.0.1',
  `HostKey ${path.join(tmp, 'hostkey')}`,
  `PidFile ${path.join(tmp, 'sshd.pid')}`,
  `AuthorizedKeysFile ${akPath}`,
  'StrictModes no',
  'PubkeyAuthentication yes',
  'PasswordAuthentication no',
  'PermitEmptyPasswords no',
  // 不要写 UsePAM：这个 sshd 构建（10.4p1）不认该选项，
  // 会输出 "Unsupported option UsePAM"，虽不致命但会污染判定。
  // 与生产配置保持一致 —— 生产里也没有它。
  // 与生产一致的三层防线
  'AllowTcpForwarding local',
  'AllowAgentForwarding no',
  'PermitTunnel no',
  'GatewayPorts no',
  'PermitOpen 127.0.0.1:' + ALLOWED_PORT,
  'X11Forwarding no',
  'LogLevel VERBOSE',
].join('\r\n') + '\r\n', 'ascii');

const t = spawnSync(SSHD, ['-t', '-f', cfgPath], { encoding: 'utf8', windowsHide: true });
check('临时 sshd_config 语法正确', t.status === 0, (t.stderr || '').trim().slice(0, 80));

const sshdProc = spawn(SSHD, ['-D', '-f', cfgPath], { stdio: 'ignore', windowsHide: true });
await new Promise((r) => setTimeout(r, 2500));

const sshdUp = await new Promise((resolve) => {
  const s = net.connect(SSHD_PORT, '127.0.0.1');
  s.on('connect', () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
});
check(`临时 sshd 已在 ${SSHD_PORT} 监听`, sshdUp);

/* ---------- 4. 真实流量测试 ---------- */
// 判据：能否从隧道里拿到 HTTP 状态行。
// 不能用 body 断言（HTTP/1.0 无 Content-Length 时 ReadToEnd 会提前返回），
// 也不能用"客户端本地端口在监听"断言（-L 下客户端总会监听，与策略无关）。
async function throughTunnel(keyFile, targetPort, label) {
  const localPort = await freePort();
  const errFile = path.join(tmp, `err-${label}.log`);
  const errStream = fs.openSync(errFile, 'w');

  const p = spawn(SSH, [
    '-i', keyFile,
    '-p', String(SSHD_PORT),
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=NUL',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ConnectTimeout=8',
    '-N',
    '-L', `${localPort}:127.0.0.1:${targetPort}`,
    `${process.env.USERNAME || 'hp'}@127.0.0.1`,
  ], { stdio: ['ignore', errStream, errStream], windowsHide: true });

  await new Promise((r) => setTimeout(r, 1800));

  const response = await new Promise((resolve) => {
    let data = '';
    const sock = net.connect(localPort, '127.0.0.1');
    const done = (v) => { try { sock.destroy(); } catch { } resolve(v); };
    sock.setTimeout(5000);
    sock.on('connect', () => {
      sock.write(`GET / HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n`);
    });
    sock.on('data', (b) => { data += b.toString('latin1'); });
    sock.on('end', () => done(data));
    sock.on('close', () => done(data));
    sock.on('timeout', () => done(data));
    sock.on('error', (e) => done(`SOCKERR:${e.code}`));
  });

  try { p.kill(); } catch { }
  await new Promise((r) => setTimeout(r, 300));
  try { fs.closeSync(errStream); } catch { }

  const err = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8') : '';
  return {
    ok: /^HTTP\/\d\.\d\s+\d{3}/.test(response.trim()),
    prohibited: /administratively prohibited/.test(err),
    response: response.split('\r\n')[0] || '(empty)',
  };
}

const c1 = await throughTunnel(agentKey.priv, ALLOWED_PORT, 'c1');
console.log(`  case1 agent->${ALLOWED_PORT}: ${c1.response} prohibited=${c1.prohibited}`);
check(`agent 密钥不能转发（即使目标是允许的端口）`, c1.ok === false && c1.prohibited === true);

const c2 = await throughTunnel(uiKey.priv, ALLOWED_PORT, 'c2');
console.log(`  case2 ui->${ALLOWED_PORT}: ${c2.response} prohibited=${c2.prohibited}`);
check(`ui 密钥可以转发到 ${ALLOWED_PORT}`, c2.ok === true);

// 关键对照组：没有这一条，case2 通过说明不了任何"限制"存在
const c3 = await throughTunnel(uiKey.priv, DENIED_PORT, 'c3');
console.log(`  case3 ui->${DENIED_PORT}: ${c3.response} prohibited=${c3.prohibited}`);
check(`ui 密钥不能转发到未授权端口 ${DENIED_PORT}`, c3.ok === false && c3.prohibited === true);

const c4 = await throughTunnel(badKey.priv, 22, 'c4');
console.log(`  case4 bad->22: ${c4.response} prohibited=${c4.prohibited}`);
check('permitopen 指向 SSH 端口时被拒（不能自己给自己开后门）', c4.ok === false && c4.prohibited === true);

/* ---------- 5. 清理 ---------- */
try { sshdProc.kill(); } catch { }
for (const s of targetServers) { try { s.close(); } catch { } }
await new Promise((r) => setTimeout(r, 500));
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { }

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
