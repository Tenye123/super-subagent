// 端到端自测：用隔离的 DSH_FLEET_HOME 验证完整流程
// 不碰真实配置，不启服务，不发网络请求。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const FLEET = path.join(ROOT, 'fleet.mjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-e2e-'));
process.env.DSH_FLEET_HOME = TMP;

let pass = 0;
let fail = 0;

function check(label, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`✓ ${label}${extra ? '  ' + extra : ''}`);
  } else {
    fail++;
    console.log(`✗ ${label}${extra ? '  ' + extra : ''}`);
  }
}

function fleet(args, opts = {}) {
  const r = spawnSync(process.execPath, [FLEET, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DSH_FLEET_HOME: opts.home || TMP,
      // 关键：必须把 HOME/USERPROFILE 指到临时目录。
      // accept 会往 "$HOME/.ssh/authorized_keys" 写授权行，
      // 不隔离的话每跑一次测试就往真实 ssh 配置里塞一把新钥匙（已实际踩到）。
      USERPROFILE: path.join(TMP, 'home'),
      HOME: path.join(TMP, 'home'), windowsHide: true
    },
    timeout: 60_000,
  });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

const cfgFile = path.join(TMP, 'fleet.json');
const readCfg = () => JSON.parse(fs.readFileSync(cfgFile, 'utf8'));

console.log(`隔离目录：${TMP}\n`);

/* ---- 1. 未初始化时 status 应报错 ---- */
{
  const r = fleet(['status']);
  check('未初始化时 status 拒绝', r.code === 2 && /尚未初始化/.test(r.err));
}

/* ---- 2. init controller ---- */
{
  const r = fleet(['init', '--role', 'controller', '--name', 'test-pc']);
  check('init controller 成功', r.code === 0, r.out.split('\n')[0]);
  const c = readCfg();
  check('配置写入 role=controller', c.role === 'controller');
  check('配置记录设备名', c.self?.name === 'test-pc');
}

/* ---- 3. keygen ---- */
{
  const r = fleet(['keygen', '--name', 'laptop-a']);
  check('keygen 成功', r.code === 0);
  check('输出含 ssh-ed25519 公钥', /ssh-ed25519 AAAA/.test(r.out));
  const priv = path.join(TMP, 'keys', 'laptop-a.key');
  const pub = path.join(TMP, 'keys', 'laptop-a.key.pub');
  check('私钥已生成', fs.existsSync(priv));
  check('公钥已生成', fs.existsSync(pub));
}

/* ---- 4. enroll ---- */
let enrolledPub = null;
{
  const r = fleet(['enroll', '--name', 'laptop-a', '--ip', '100.64.0.5', '--user', 'hp', '--expires', '30d']);
  check('enroll 成功', r.code === 0, r.err.split('\n')[0] || '');
  const c = readCfg();
  const d = c.devices.find((x) => x.name === 'laptop-a');
  check('设备已登记', Boolean(d));
  check('设备 IP 正确', d?.tailscaleIp === '100.64.0.5');
  check('有效期已设置', Boolean(d?.expiresAt));
  check('私钥路径已记录', Boolean(d?.keyPath));
  const m = /'ssh-ed25519 [^']+'/.exec(r.out);
  enrolledPub = m ? m[0].slice(1, -1) : null;
  check('输出含给 agent 的公钥', Boolean(enrolledPub));
}

/* ---- 5. list / status ---- */
{
  const r = fleet(['list', '--json']);
  const rows = JSON.parse(r.out);
  check('list --json 可解析', Array.isArray(rows) && rows.length === 1);
  check('状态为 active', rows[0]?.state === 'active');

  const s = fleet(['status']);
  check('status 显示 1 台设备', /1 台可用/.test(s.out));
}

/* ---- 6. revoke ---- */
{
  const r = fleet(['revoke', '--name', 'laptop-a']);
  check('revoke 成功', r.code === 0);
  const rows = JSON.parse(fleet(['list', '--json']).out);
  check('撤销后状态为 revoked', rows[0]?.state === 'revoked');

  // 撤销后不应允许派活
  const run = fleet(['run', '--device', 'laptop-a', '--task', 'echo hi']);
  check('撤销后拒绝派活', run.code === 2 && /已撤销/.test(run.err));
}

/* ---- 7. 过期设备应拒绝 ---- */
{
  const before = readCfg();
  const d = before.devices.find((x) => x.name === 'laptop-a');
  d.revoked = false;
  d.expiresAt = '2020-01-01T00:00:00.000Z';
  fs.writeFileSync(cfgFile, JSON.stringify(before, null, 2));

  const run = fleet(['run', '--device', 'laptop-a', '--task', 'echo hi']);
  check('过期后拒绝派活', run.code === 2 && /已过期/.test(run.err));
}

/* ---- 8. agent 侧 accept ---- */
{
  // 用另一个隔离目录模拟 agent
  const agentHome = path.join(TMP, 'agent-home');
  fs.mkdirSync(agentHome, { recursive: true });

  fleet(['init', '--role', 'agent', '--name', 'laptop-a'], { home: agentHome });
  const r = fleet(
    ['accept', '--controller', 'test-pc', '--pubkey', enrolledPub || 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAA', '--expires', '30d'],
    { home: agentHome }
  );

  // accept 的写入目标是系统目录（C:\ProgramData\ssh 或 ~/.ssh）。
  // 在无管理员权限的测试环境里，它必须"优雅失败并给出指引"，
  // 而不是抛未捕获异常（退出码为 null 或带 stack）。
  const crashed = r.err.includes('Error:') && r.err.includes('at ');
  check('accept 未崩溃', !crashed, crashed ? '出现未捕获异常' : '');
  check('accept 返回明确码', r.code === 0 || r.code === 1, `code=${r.code}`);

  const acPath = path.join(agentHome, 'fleet.json');
  const ac = JSON.parse(fs.readFileSync(acPath, 'utf8'));
  check('agent 记录了主控', ac.controller?.name === 'test-pc');
  check('agent 记录了有效期', Boolean(ac.controller?.expiresAt));

  if (r.code === 1) {
    check('失败时给出管理员指引', /管理员|administrators_authorized_keys/.test(r.out + r.err));
  } else {
    check('成功时报告写入路径', /写入：/.test(r.out));
  }

  // 隔离断言：授权行必须落在临时 HOME 里，绝不能碰真实 ~/.ssh
  const sandboxKeys = path.join(TMP, 'home', '.ssh', 'authorized_keys');
  const realKeys = path.join(os.homedir(), '.ssh', 'authorized_keys');
  check('授权写进沙箱 HOME', r.code !== 0 || fs.existsSync(sandboxKeys));

  // 真实文件要么不存在，要么不含本次测试写入的公钥
  if (fs.existsSync(realKeys)) {
    const real = fs.readFileSync(realKeys, 'utf8');
    const leaked = (enrolledPub || '').includes('AAAA')
      ? real.includes((enrolledPub || '').split(' ')[1] || '\u0000')
      : false;
    check('未污染真实 ~/.ssh/authorized_keys', !leaked, leaked ? `泄露到 ${realKeys}` : '');
  } else {
    check('未污染真实 ~/.ssh/authorized_keys', true, '真实文件不存在');
  }
}

/* ---- 9. 未知命令 ---- */
{
  const r = fleet(['nonsense-command']);
  check('未知命令返回 2', r.code === 2 && /未知命令/.test(r.err));
}

/* ---- 10. 无效有效期应报错 ---- */
{
  const r = fleet(['enroll', '--name', 'x', '--ip', '1.2.3.4', '--user', 'u', '--expires', '随便写']);
  check('无效有效期被拒绝', r.code === 2 && /无法解析有效期/.test(r.err));
}

/* ---- 清理 ---- */
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
