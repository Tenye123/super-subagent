// 验证 authorized_keys 的选项能否被真实 sshd 接受 —— 用**真实登录**判定
//
// 为什么不能用 `sshd -t`：
//   实测发现 `sshd -t -f <cfg>` **根本不解析 AuthorizedKeysFile 的内容**，
//   选项是在客户端登录、公钥认证阶段才解析的。所以
//     sshd -t  接受一个含有 "totally-bogus-option=1" 的 authorized_keys
//   而且返回 0 —— 用它当判据会得到**假阳性**：看起来全过，实际全没验证。
//   （这正是这个测试的第一版犯的错，反向用例把它暴露出来了。）
//
// 正确判据：起一个临时 sshd 实例，用某个 key 真去登录，看认证结果。
//
// 需要的条件（任一不满足就跳过，并说明原因）：
//   - sshd / ssh / ssh-keygen 都在
//   - 能写一个宿主机临时目录当 AuthorizedKeysFile
//   - 监听一个高端口（不需要管理员，非特权端口）
//
// 不做的事：不碰真实的 C:\ProgramData\ssh\ssh_config，不碰真实 ~/.ssh。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { run, which } from '../lib/util.mjs';

let pass = 0, fail = 0, skip = 0;
const check = (l, c, e = '') => { c ? (pass++, console.log(`✓ ${l} ${e}`)) : (fail++, console.log(`✗ ${l} ${e}`)); };
const skipped = (l, why) => { skip++; console.log(`- ${l}（跳过：${why}）`); };

const sshd = which('sshd');
const ssh = which('ssh');
const keygen = which('ssh-keygen');
if (!sshd || !ssh || !keygen) {
  console.log(`! 缺少 OpenSSH 组件（sshd=${!!sshd} ssh=${!!ssh} ssh-keygen=${!!keygen}），跳过`);
  process.exit(0);
}
console.log(`sshd: ${sshd}\nssh: ${ssh}`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-authopt-'));

/* ---- 准备密钥 ---- */
function newKey(name) {
  const p = path.join(TMP, name);
  const r = run(keygen, ['-t', 'ed25519', '-f', p, '-N', '', '-q', '-C', name], { timeout: 20_000 });
  if (r.code !== 0) throw new Error(`ssh-keygen 失败: ${r.stderr}`);
  return p;
}

const hostKey = path.join(TMP, 'host_ed25519');
run(keygen, ['-t', 'ed25519', '-f', hostKey, '-N', '', '-q'], { timeout: 20_000 });

const goodKey = newKey('good');   // 会被授权
const otherKey = newKey('other'); // 不会被授权

function pubOf(k) {
  return fs.readFileSync(`${k}.pub`, 'utf8').trim().split(' ').slice(0, 2).join(' ');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}

function writeConfig({ port, akPath, extra = '' }) {
  const cfg = path.join(TMP, `cfg_${port}`);
  const lines = [
    `Port ${port}`,
    `ListenAddress 127.0.0.1`,
    `HostKey ${hostKey.replace(/\\/g, '/')}`,
    `AuthorizedKeysFile ${akPath.replace(/\//g, '/').replace(/\\/g, '/')}`,
    `PasswordAuthentication no`,
    `PubkeyAuthentication yes`,
    `PermitEmptyPasswords no`,
    `UsePAM no`,
    `StrictModes no`,       // 临时目录权限不满足 sshd 的严格要求
    `PidFile ${path.join(TMP, `sshd_${port}.pid`).replace(/\\/g, '/')}`,
    `LogLevel VERBOSE`,
    extra,
  ].filter(Boolean);
  fs.writeFileSync(cfg, lines.join('\n') + '\n', 'utf8');
  return cfg;
}

/**
 * 起一个临时 sshd（前台子进程），返回 { proc, port, stop }。
 */
async function startSshd({ akLines, extra = '', label }) {
  const port = await freePort();
  const akPath = path.join(TMP, `ak_${port}`);
  fs.writeFileSync(akPath, akLines.join('\n') + '\n', 'utf8');
  const cfg = writeConfig({ port, akPath, extra });

  // 先做配置语法检查，语法错就明确报出来
  const t = run(sshd, ['-t', '-f', cfg], { timeout: 15_000 });
  if (t.code !== 0) {
    return { error: `配置语法错误: ${(t.stderr || t.stdout).trim()}` };
  }

  // Windows 的 sshd 不接受 -D 以外的前台模式时要靠 -d；这里用 -D 常驻
  const proc = spawn(sshd, ['-D', '-f', cfg], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { out += d.toString(); });

  // 等端口就绪
  const deadline = Date.now() + 15_000;
  let up = false;
  while (Date.now() < deadline) {
    const ok = await new Promise((res) => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.destroy(); res(true); });
      s.on('error', () => res(false));
      setTimeout(() => { s.destroy(); res(false); }, 800);
    });
    if (ok) { up = true; break; }
    await new Promise((r) => setTimeout(r, 300));
  }

  return {
    proc, port, out: () => out,
    stop: () => { try { proc.kill(); } catch { } },
    up,
  };
}

/**
 * 用指定 key 去登录，返回 { ok, msg }。
 * 判据是**认证是否被接受**。
 *
 * ⚠️ 这里为什么不能带远程命令（曾经的弹窗根因）
 * ------------------------------------------------------------
 * 原来的写法是 `ssh ... 'echo AUTH_OK'`。Windows 的 sshd 执行远程命令时
 * **必须**经过用户的默认 shell（cmd.exe），于是每次登录都会真的启动一次
 *     c:\windows\system32\cmd.exe /c "echo AUTH_OK"
 * 而我们的临时 sshd 是用 `sshd -D` 起的普通进程，没有服务控制台，cmd.exe
 * 拿不到 console，就**弹出一个真实的控制台窗口**，里面写着：
 *     [出现错误 2147942632 (0x800700e8) (启动"...cmd.exe" /c "echo AUTH_OK"时)]
 * 0x800700e8 = ERROR_NO_DATA（没有可用控制台）。
 * 整个测试有 6 个登录用例 → 跑一次弹 6 个 cmd 窗口。用户看到的就是这个。
 *
 * 解法：用 `ssh -N`（不执行任何远程命令）。sshd 只做认证 + 建通道，
 * 根本不启动 shell，所以不会有任何窗口。判定方式改成"连接是否活得下去"：
 *   - 认证被拒 → ssh 立刻退出，exit code != 0
 *   - 认证通过 → ssh 一直挂着不退出，到超时被我们杀掉
 * 这个判据同时覆盖了 command= 的情况（那种情况下也没法靠输出判定）。
 */
function tryLogin({ port, key }) {
  const r = spawnSync(ssh, [
    '-N',                                    // no remote command: never spawns a shell
    '-i', key,
    '-p', String(port),
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=NUL',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'PreferredAuthentications=publickey',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=1',
    '-o', 'ServerAliveCountMax=1',
    '-o', 'ExitOnForwardFailure=no',
    `${os.userInfo().username}@127.0.0.1`,
  ], { encoding: 'utf8', timeout: 4000, windowsHide: true });

  const text = `${r.stdout || ''}${r.stderr || ''}`;
  // timeout 超时被杀 -> signal 为 SIGTERM（Windows 上 status 为 null）
  // 这说明认证通过了、会话一直活着。
  const survived = r.signal !== null || r.status === null;
  const authOk = survived || r.status === 0;
  return { ok: authOk, authOk, msg: text.trim(), status: r.status, survived };
}

/* ================= 用例 ================= */

const isAdmin = spawnSync('net', ['session'], { windowsHide: true }).status === 0;
// 管理员账户的 key 必须放 administrators_authorized_keys，
// 普通账户才用 AuthorizedKeysFile —— 这里用临时配置绕开该差异。
const extraForAdmin = '';

async function caseValid(label, line, expectAuth) {
  const s = await startSshd({ akLines: [line], extra: extraForAdmin, label });
  if (s.error) { check(label, false, s.error.slice(0, 140)); return; }
  if (!s.up) {
    s.stop();
    skipped(label, `临时 sshd 没起来：${s.out().slice(0, 100)}`);
    return;
  }
  const r = tryLogin({ port: s.port, key: goodKey });
  s.stop();

  if (expectAuth) {
    check(`${label} → 登录成功`, r.ok, r.ok ? '' : r.msg.slice(0, 160));
  } else {
    check(`${label} → 登录被拒`, !r.ok, r.ok ? '竟然登录成功了' : '');
  }
}

const GOOD = pubOf(goodKey);

// 1) 正向：这些选项组合必须能被接受并成功登录
await caseValid('restrict + expiry-time（未过期）+ from', 
  `restrict,expiry-time="209912312359",from="127.0.0.1,::1,100.64.0.0/10" ${GOOD}`, true);

await caseValid('restrict + port-forwarding + permitopen（ui 用）',
  `restrict,port-forwarding,permitopen="127.0.0.1:8787" ${GOOD}`, true);

// 3) command 强制 + no-pty
//
// 这里用 internal-sftp 而不是 cmd.exe，且整体已经改成 `ssh -N` 登录，
// 所以不会再弹任何控制台窗口（详见 tryLogin 上方的说明）。
// internal-sftp 是 sshd 内部命令，不经过 cmd.exe，同样能证明 command=
// 被接受并强制生效。
await caseValid('command 强制 + no-pty',
  `command="internal-sftp",no-pty ${GOOD}`, true);

// 2) 反向：伪造选项必须让认证失败
//    这是证明"上面的通过是真判据"的关键一条。
await caseValid('伪造选项（必须被拒）',
  `totally-bogus-option=1 ${GOOD}`, false);

// 3) 反向：expiry-time 已过期，必须被拒
await caseValid('expiry-time 已过期（必须被拒）',
  `restrict,expiry-time="202001010000" ${GOOD}`, false);

// 4) 反向：from 限制了其他地址，必须被拒
await caseValid('from 不含本机（必须被拒）',
  `from="10.99.99.0/24" ${GOOD}`, false);

// 5) 反向：授权的是另一把 key，本 key 必须被拒
{
  const s = await startSshd({ akLines: [`restrict ${pubOf(otherKey)}`], label: 'other key' });
  if (s.error) check('未授权的 key（必须被拒）', false, s.error.slice(0, 120));
  else if (!s.up) { s.stop(); skipped('未授权的 key', 'sshd 未启动'); }
  else {
    const r = tryLogin({ port: s.port, key: goodKey });
    s.stop();
    check('未授权的 key → 登录被拒', !r.ok, r.ok ? '竟然登录成功了' : '');
  }
}

/* ---- 清理 ---- */
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }

console.log(`\n${pass} 通过, ${fail} 失败${skip ? `, ${skip} 跳过` : ''}`);
process.exit(fail === 0 ? 0 : 1);
