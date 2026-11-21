// dsh-fleet —— 把任务经 DSH 桌面端的 Connection RPC 派到远端设备
//
// 与旧实现（`dsh --profile headless --print`）的区别只有一个，但很关键：
//
//   headless 跑完就丢，会话不登记进任何 workspace。你到那台机器上打开
//   DSH 界面，什么都看不到——活干了，但没法复查、没法接着聊。
//
//   这里用 workspace/create + session/create，会话由应用自己的
//   SessionController 创建，**天然**出现在界面上、可续接。
//
// 传输链路（每一环都是被迫的选择）：
//
//   主控 --ssh--> agent 上的 node 小信使 --http--> 127.0.0.1:<随机端口>
//
//   · 桌面端只监听 loopback，这是有意的安全设计，不该为了派活去放开；
//     SSH 是我们已有且加固过的唯一入口。
//   · 端口每次启动随机，所以现场从进程的 LISTEN socket 发现。
//   · 请求体走 stdin：任务文本可以是任意内容，走命令行要过三层引号解析。

import fs from 'node:fs';
import path from 'node:path';

import * as rpc from './rpc.mjs';
import { exec } from './ssh.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

/**
 * 小信使程序。
 *
 * 它要穿过 ssh → cmd → 一层双引号，所以必须压成单行、且不含任何
 * 双引号字面量（源码里一律用单引号）。这是把「引号地狱」压缩到
 * 唯一一处、并在这里一次说清，而不是散落在每次调用里。
 */
function loadMessenger() {
  const src = fs.readFileSync(path.join(HERE, 'rpc-remote.mjs'), 'utf8');
  const single = src
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))       // 去掉行尾注释
    .join(' ')
    .replace(/\s+/g, ' ')                        // 压平空白
    .trim();
  if (single.includes('"')) {
    throw new Error('信使源码不能含双引号（会被 shell 解析掉）');
  }
  return single;
}

const MESSENGER = loadMessenger();

/**
 * 在远端执行一段 PowerShell 并取回 stdout。
 *
 * 用 base64 传脚本：PowerShell 5.1 按 GBK 读无 BOM 的 .ps1，中文会直接语法错；
 * 而 -EncodedCommand 收的是 UTF-16LE 的 base64，绕开编码判断。
 */
function runPowerShell(dev, script, { timeoutMs = 60_000 } = {}) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return exec(dev, 'powershell -NoProfile -NonInteractive -EncodedCommand ' + encoded, {
    timeout: timeoutMs,
  });
}

/**
 * 找出远端 DSH 桌面端的监听端口。
 *
 * 这是整个链路里唯一会"过期"的值，所以每次派活都重新问，不缓存。
 */
export function findAgentPort(dev, { timeoutMs = 60_000 } = {}) {
  const script = [
    "$p = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })",
    'if ($p.Count -eq 0) { exit 0 }',
    '$c = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $p -contains $_.OwningProcess })',
    '$c | ForEach-Object { $_.LocalPort }',
  ].join('\n');

  const r = runPowerShell(dev, script, { timeoutMs });
  if (r.code !== 0) {
    throw new Error('无法在远端枚举端口: ' + (r.stderr || '').slice(0, 300));
  }
  const ports = String(r.stdout).split('\n')
    .map((s) => s.trim())
    .filter((s) => /^[0-9]+$/.test(s));
  if (ports.length === 0) {
    throw new Error(
      '远端没有正在监听的 DeepSeek Harness 进程。' +
      '请在那台机器上启动 DSH 桌面端（仅 CLI 不足以提供服务）。',
    );
  }
  return Number(ports[0]);
}

/** 读出远端的 .credentials.yaml，用于自签 cookie。 */
function readCredentials(dev, dshHome, { timeoutMs = 60_000 } = {}) {
  const p = String(dshHome || '~/.dsh').replace(/\\/g, '/')
    .replace(/^~/, '$env:USERPROFILE');
  const script = `$p = "${p}/.credentials.yaml"; if (-not (Test-Path $p)) { Write-Output "__MISSING__" } else { [Convert]::ToBase64String([IO.File]::ReadAllBytes($p)) }`;
  const r = runPowerShell(dev, script, { timeoutMs });
  const out = String(r.stdout).trim();
  if (!out || out === '__MISSING__') {
    throw new Error(
      '远端没有 .credentials.yaml。DSH 桌面端需要至少启动过一次并完成初始化。',
    );
  }
  return Buffer.from(out, 'base64').toString('utf8');
}

/**
 * 解析远端工作目录。
 *
 * workspace/create 要求路径**完全限定**，收到 `~/.dsh-workspace` 会直接报
 * "Workspace path is not fully qualified"。而 `~` 的展开只有远端才知道
 * （取决于那边的用户名），所以这里不能让主控猜，必须问题目本身。
 *
 * 默认值选 `<用户目录>/dsh-workspace` 而不是用户目录本身：DSH 的 Windows
 * ACL 沙箱拒绝在自己的 temp root 落在 workspace 内部时运行，而用户目录
 * 里包含 AppData\Local\Temp——把 workspace 设成家目录会让每条工具调用
 * 在启动前就失败（实测过，报 "Windows ACL temp root must be outside the
 * workspace"）。
 */
function resolveWorkspacePath(dev, workspacePath, runPowerShell) {
  const raw = workspacePath || dev.workspace || '';
  if (raw && !raw.startsWith('~')) return raw.replace(/\\/g, '/');

  const rel = raw.startsWith('~/') ? raw.slice(2) : 'dsh-workspace';
  const script = [
    `$p = Join-Path $env:USERPROFILE '${rel.replace(/'/g, "''")}'`,
    'if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null }',
    'Write-Output $p',
  ].join('\n');
  const r = runPowerShell(dev, script);
  const out = String(r.stdout).trim().split('\n').filter(Boolean).pop();
  if (!out) {
    throw new Error('无法在远端解析工作目录: ' + (r.stderr || '').slice(0, 300));
  }
  return out.replace(/\\/g, '/');
}

/**
 * 建立到远端设备的 RPC 客户端。
 *
 * @param {object} dev  配置里的设备（含 user / tailscaleIp / keyPath / port）
 * @param {object} [opts]
 * @param {number} [opts.port]     已知端口时跳过发现（仅测试用；生产别写死）
 * @param {string} [opts.dshHome]  远端 .dsh 目录
 */
export function connect(dev, opts = {}) {
  const port = opts.port || findAgentPort(dev);
  const authority = '127.0.0.1:' + port;

  const creds = readCredentials(dev, opts.dshHome || dev.dshHome);
  const cookie = rpc.mintCookie(creds, authority);
  if (!cookie) {
    throw new Error(
      '无法从 .credentials.yaml 取出 browser-session 密钥。' +
      '该字段是 DSH 自签 cookie 的依据，缺失时无法通过 /api 鉴权。',
    );
  }

  // 远端信使：命令行上只有一个 base64 blob，stdin 送请求体。
  //
  // 信使源码刻意写成 CommonJS，因为 `node -e` 按 CJS 求值，静态 import
  // 会报 "Cannot use import statement outside a module"。这样不必落临时
  // 文件、不必动态 import，少一层出错空间。
  const request = async (reqPath, bodyText) => {
    const envelope = JSON.stringify({ port, cookie, path: reqPath, body: bodyText });
    const wrapped = `node -e "${MESSENGER}"`;
    const res = exec(dev, wrapped, { timeout: 120_000, input: envelope });
    const line = String(res.stdout).trim().split('\n').filter(Boolean).pop();
    if (!line) {
      throw new Error('远端无输出: ' + (res.stderr || '').slice(0, 300));
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error('远端输出不是 JSON: ' + line.slice(0, 300));
    }
    if (parsed.error) throw new Error('远端请求失败: ' + parsed.error);
    if (parsed.status !== 200) throw new Error('HTTP ' + parsed.status + ': ' + String(parsed.body).slice(0, 400));
    return parsed.body;
  };

  return rpc.createRpcClient({ port, cookie, request });
}

/**
 * 派一个任务并等它跑完。
 *
 * @returns {Promise<object>} rpc.runTask 的结果
 */
export async function dispatch(dev, task, opts = {}) {
  const client = connect(dev, opts);
  const workspacePath = resolveWorkspacePath(dev, opts.cwd, (d, s) => runPowerShell(d, s));
  return rpc.runTask(client, {
    workspacePath,
    task,
    timeoutMs: opts.timeoutMs,
    pollMs: opts.pollMs,
    onProgress: opts.onProgress,
  });
}

export { rpc };
