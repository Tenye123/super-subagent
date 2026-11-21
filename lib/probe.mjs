// dsh-fleet —— 设备探测与环境检查

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { run, runCmd, which, IS_WIN, log } from './util.mjs';

/* ---------------- 基础探测 ---------------- */

export function machineId() {
  // Windows 优先用 MachineGuid（稳定、克隆机之外唯一）
  if (IS_WIN) {
    const r = run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']);
    const m = /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{36})/.exec(r.stdout);
    if (m) return m[1].toLowerCase();
  }
  return os.hostname().toLowerCase();
}

export function hostName() {
  return os.hostname();
}

export function tailscaleInfo() {
  const r = runCmd('tailscale', ['status', '--json'], { timeout: 10_000 });
  if (r.code !== 0) {
    return { installed: r.error?.code !== 'ENOENT', up: false, ips: [], error: r.stderr || 'not running' };
  }
  try {
    const j = JSON.parse(r.stdout);
    const ips = (j.TailscaleIPs || []).filter((x) => x.includes('.'));
    return {
      installed: true,
      up: j.BackendState === 'Running',
      ips,
      hostname: j.Self?.HostName,
      dnsName: j.Self?.DNSName?.replace(/\.$/, ''),
      online: Boolean(j.Self?.Online),
      error: j.BackendState === 'Running' ? null : j.BackendState,
    };
  } catch {
    return { installed: true, up: false, ips: [], error: 'unparsable status' };
  }
}

export function nodeInfo() {
  return {
    version: process.versions.node,
    execPath: process.execPath,
    ok: Number(process.versions.node.split('.')[0]) >= 18,
  };
}

export function dshInfo() {
  const r = runCmd('dsh', ['--version'], { timeout: 30_000 });
  if (r.code !== 0) return { installed: false, version: null, error: r.stderr || 'not found' };
  return { installed: true, version: r.stdout.split(/\s+/)[0], error: null };
}

export function sshInfo() {
  const r = run('ssh', ['-V'], { timeout: 10_000 });
  // ssh -V 输出走 stderr
  const ver = (r.stderr || r.stdout).match(/OpenSSH[_\w]*_([\d.]+p?\d*)/);
  return {
    clientVersion: ver ? ver[1] : null,
    clientAvailable: Boolean(ver) || r.code === 0,
  };
}

/** 本机 sshd 是否在跑 + 端口 */
export function sshdInfo() {
  const svc = run('sc', ['query', 'sshd']);
  const running = /STATE\s*:\s*\d+\s+RUNNING/i.test(svc.stdout);
  const configPath = IS_WIN ? 'C:\\ProgramData\\ssh\\sshd_config' : '/etc/ssh/sshd_config';
  const hasConfig = fs.existsSync(configPath);
  let port = null;
  if (hasConfig) {
    const cfg = fs.readFileSync(configPath, 'utf8');
    const m = /^\s*Port\s+(\d+)/m.exec(cfg);
    port = m ? Number(m[1]) : 22;
  }
  return { installed: hasConfig, running, port, configPath };
}

/** 判断当前是否管理员完整令牌 */
export function isElevated() {
  if (!IS_WIN) return process.getuid?.() === 0;
  const r = run('net', ['session']);
  return r.code === 0;
}

/** 是否管理员组成员（即便令牌被过滤） */
export function isAdminMember() {
  if (!IS_WIN) return false;
  const r = run('whoami', ['/groups']);
  return /S-1-5-32-544/.test(r.stdout);
}

/* ---------------- 环境快照 ---------------- */

export function snapshot() {
  const mem = os.totalmem() / 1024 ** 3;
  return {
    host: hostName(),
    machineId: machineId(),
    platform: process.platform,
    os: osVersion(),
    elevated: isElevated(),
    adminMember: isAdminMember(),
    cpu: os.cpus()[0]?.model?.trim(),
    cpuCount: os.cpus().length,
    ramGb: Math.round(mem * 10) / 10,
    node: nodeInfo(),
    dsh: dshInfo(),
    ssh: sshInfo(),
    sshd: sshdInfo(),
    tailscale: tailscaleInfo(),
    home: os.homedir(),
    takenAt: new Date().toISOString(),
  };
}

/**
 * 系统版本。
 * 不要用 `cmd /c ver` —— 中文系统的输出是 GBK，
 * spawnSync 按 UTF-8 解码会变成乱码（实测 "瓒呰秺鐏甸瓊"）。
 * os.release() + os.type() 是纯 API，没有编码问题。
 */
function osVersion() {
  if (!IS_WIN) return `${os.type()} ${os.release()}`;
  return `Windows ${os.release()}`;
}

/* ---------------- 检查项（doctor） ---------------- */

/**
 * 返回 { key, label, level, detail, fix }
 * level: ok | warn | fail
 */
export function checks({ role = 'node' } = {}) {
  const out = [];
  const add = (key, label, level, detail, fix = null) => out.push({ key, label, level, detail, fix });

  const node = nodeInfo();
  add('node', 'Node.js ≥ 18', node.ok ? 'ok' : 'fail',
    node.ok ? `v${node.version}` : `当前 v${node.version}，需要 18+`,
    node.ok ? null : 'winget install OpenJS.NodeJS.LTS  或  https://nodejs.org/');

  const dsh = dshInfo();
  add('dsh', 'DSH CLI 可用', dsh.installed ? 'ok' : 'fail',
    dsh.installed ? `v${dsh.version}` : '未找到 dsh 命令',
    dsh.installed ? null : 'npm i -g @deepseek-ai/dsh');

  const ssh = sshInfo();
  add('ssh-client', 'OpenSSH 客户端', ssh.clientAvailable ? 'ok' : 'fail',
    ssh.clientAvailable ? `v${ssh.clientVersion}` : '未找到 ssh',
    ssh.clientAvailable ? null
      : 'Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0');

  if (role === 'agent' || role === 'all') {
    const s = sshdInfo();
    add('sshd', 'SSH 服务端（供主控连接）', s.running ? 'ok' : (s.installed ? 'warn' : 'fail'),
      s.running ? `运行中，端口 ${s.port}` : (s.installed ? '已安装但未运行' : '未安装'),
      s.running ? null
        : s.installed ? 'Set-Service sshd -StartupType Automatic; Start-Service sshd'
        : 'Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0');
  }

  const ts = tailscaleInfo();
  add('tailscale', 'Tailscale 连通性', ts.up ? 'ok' : (ts.installed ? 'warn' : 'fail'),
    ts.up ? `IP ${ts.ips.join(', ') || '(none)'}` : (ts.installed ? `状态 ${ts.error}` : '未安装'),
    ts.up ? null : 'winget install Tailscale.Tailscale  然后 tailscale up');

  const el = isElevated();
  add('elevation', '管理员权限', el ? 'ok' : 'warn',
    el ? '已提权' : (isAdminMember() ? '是管理员组，但当前是 UAC 过滤令牌' : '普通用户'),
    el ? null : '需要改系统设置时右键「以管理员身份运行」');

  return out;
}

export function summarize(items) {
  const n = { ok: 0, warn: 0, fail: 0 };
  for (const i of items) n[i.level]++;
  return n;
}
