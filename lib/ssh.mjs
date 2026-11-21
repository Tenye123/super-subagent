// dsh-fleet —— SSH 远程执行

import fs from 'node:fs';
import path from 'node:path';
import { run, which, IS_WIN, log } from './util.mjs';

const SSH = () => which('ssh') || 'ssh';

/**
 * 构造 ssh 参数。
 * 关键：BatchMode=yes 确保绝不弹密码提示（否则脚本会挂住）。
 */
export function sshArgs(dev, extra = []) {
  const port = dev.port || 22;
  const args = [
    '-i', dev.keyPath,
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'LogLevel=ERROR',
  ];
  if (port !== 22) args.push('-p', String(port));
  return [...args, ...extra, `${dev.user}@${dev.tailscaleIp}`];
}

/** 在远程执行一条命令，返回 { code, stdout, stderr } */
export function exec(dev, remoteCmd, opts = {}) {
  const args = sshArgs(dev, opts.extraArgs || []);
  // SSH 会把所有参数拼成一行交给远端 shell，所以整体作为最后一个参数
  args.push(remoteCmd);
  // input 必须透传：派活时任务文本经 stdin 送进远端程序，
  // 走命令行要经过 cmd → PowerShell → 目标程序三层引号解析，
  // 任何一层都能把引号、换行或中文弄坏。stdin 不经过解析器。
  return run(SSH(), args, { timeout: opts.timeout ?? 120_000, input: opts.input });
}

/** 连通性测试 */
export function ping(dev, opts = {}) {
  const r = exec(dev, 'echo __FLEET_OK__', { timeout: opts.timeout ?? 20_000 });
  const ok = r.code === 0 && r.stdout.includes('__FLEET_OK__');
  return {
    ok,
    latencyMs: null,
    code: r.code,
    error: ok ? null : classifySshError(r),
    raw: ok ? null : r.stderr,
  };
}

/** 把 ssh 的报错归类成可执行建议 */
export function classifySshError(r) {
  const e = (r.stderr || '') + (r.error?.message || '');
  if (/Permission denied/i.test(e)) return 'publickey 被拒：检查 authorized_keys 是否含该公钥、ACL 是否正确';
  if (/Connection refused/i.test(e)) return '端口拒绝：目标 sshd 未运行，或端口不对';
  if (/Connection timed out|timed out/i.test(e)) return '连接超时：网络不通（Tailscale 是否在线？防火墙？）';
  if (/Could not resolve|Name or service not known/i.test(e)) return '域名/IP 无法解析：检查 tailscaleIp 是否填对';
  if (/Host key verification failed/i.test(e)) return '主机密钥不匹配：目标重装过或 IP 复用，需清理 known_hosts';
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(e)) return '主机密钥变更：ssh-keygen -R 目标';
  if (/administratively prohibited/i.test(e)) return '被 server 端策略禁止：authorized_keys 的 restrict/permitopen 生效中';
  return e.trim().slice(0, 200) || `ssh 退出码 ${r.code}`;
}

/** 拉取远端文件到本地 */
export function fetchFile(dev, remotePath, localPath, opts = {}) {
  const scp = which('scp') || 'scp';
  const args = [
    '-i', dev.keyPath,
    '-P', String(dev.port || 22),
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
    `${dev.user}@${dev.tailscaleIp}:${remotePath}`,
    localPath,
  ];
  return run(scp, args, { timeout: opts.timeout ?? 600_000 });
}

/** 推送本地文件到远端 */
export function pushFile(dev, localPath, remotePath, opts = {}) {
  const scp = which('scp') || 'scp';
  const args = [
    '-i', dev.keyPath,
    '-P', String(dev.port || 22),
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
    localPath,
    `${dev.user}@${dev.tailscaleIp}:${remotePath}`,
  ];
  return run(scp, args, { timeout: opts.timeout ?? 600_000 });
}

/**
 * 远程执行 DSH headless 任务。
 *
 * 用 base64 传任务文本 —— 避免任何引号/换行/中文编码问题。
 * （这类问题在 PowerShell + SSH + 中文环境下几乎必然出现）
 */
export function runRemoteTask(dev, task, opts = {}) {
  const b64 = Buffer.from(task, 'utf8').toString('base64');
  const sessionArg = opts.session ? ` --session-id ${opts.session}` : '';

  // DEFAULT WORKING DIRECTORY -- this is not cosmetic.
  //
  // Measured failure on the real agent machine: without --cwd, the SSH session
  // starts in the user's home directory (C:\Users\<user>). That home directory
  // CONTAINS %TEMP% (C:\Users\<user>\AppData\Local\Temp). DSH's Windows ACL
  // sandbox refuses to run under workspace-write mode when its temp root sits
  // inside the workspace, so EVERY pwsh tool call died before starting:
  //
  //     Error: Windows ACL temp root must be outside the workspace:
  //     workspace=C:\Users\<user>; temp=C:\Users\<user>\AppData\Local\Temp
  //
  // The agent burned 10 tool calls discovering this and could not run even
  // `hostname`. Any directory under the profile that does NOT contain
  // AppData is fine; %USERPROFILE%\dsh-workspace is predictable and is created
  // on demand below.
  const cwd = opts.cwd
    ? `cd "${opts.cwd}"; `
    : '$w=Join-Path $env:USERPROFILE "dsh-workspace"; if(-not (Test-Path $w)){ New-Item -ItemType Directory -Path $w -Force | Out-Null }; Set-Location $w; ';

  // 远端用 PowerShell 解 base64，再交给 dsh
  const ps = [
    `$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))`,
    `${cwd}dsh --profile headless --json${sessionArg} $t`,
  ].join('; ');

  const wrapped = `powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps.replace(/"/g, '\\"')}"`;
  return exec(dev, wrapped, { timeout: opts.timeout ?? 1_800_000 });
}

/** 解析 dsh --json 的 NDJSON 事件流 */
export function parseEvents(stdout) {
  const events = [];
  for (const line of stdout.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try {
      events.push(JSON.parse(s));
    } catch {
      /* 非 JSON 行忽略 */
    }
  }
  return events;
}

/** 从事件流里提取会话 id、最终答案、工具调用数 */
export function summarizeEvents(events) {
  let session = null;
  let final = null;
  let status = null;
  let toolCalls = 0;
  let error = null;

  for (const e of events) {
    if (e.type === 'session' && e.session) session = e.session;
    else if (e.type === 'final') final = e.text ?? '';
    else if (e.type === 'status' && e.status) status = e.status;
    else if (e.type === 'tool_call') toolCalls++;
    else if (e.type === 'error') error = e.message || 'error';
  }
  return { session, final, status, toolCalls, error };
}
