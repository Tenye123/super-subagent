// 通过 DSH 桌面端自己的 Connection RPC 在远程设备上派活。
//
// 为什么不用 `dsh --profile headless --print`（旧实现）：
//   headless 跑完就丢，会话不登记进任何 workspace。结果是在那台机器上
//   打开 DSH 界面什么都看不到——活干了，但人没法接着聊、没法复查、
//   没法在界面上继续追问。对"超级子代理"来说这是硬伤：子代理的价值
//   一半在于可续接。
//
//   走桌面端的 workspace/create + session/create，会话是由应用自己的
//   SessionController 创建的，所以**天然**登记进 workspace.json，
//   在界面上可见、可续聊。而且无需停止应用、无需改它的状态文件。
//
// 为什么不用 SDK JSON-RPC（profile sdk）：
//   那条路同样不登记 workspace，且 dsh-sdk-jsonrpc-server 只实现了
//   initialize / session/prompt / shutdown 三个方法，做不了会话管理。
//
// 协议事实（都是实测踩出来的，不是文档抄的）：
//   · POST /api/<namespace>/<method>，body 必须含恰好一个 plain-object 的
//     args 字段，否则报 "Remote payload must contain exactly one plain-object
//     args field"。
//   · 每个请求都要 browser-session cookie。启动 token 只在进程内存里
//     （WeakMap），永远拿不到；但签名密钥持久化在 .credentials.yaml 里，
//     所以可以自签。cookie 名 = "dsh-auth-" + base64url(sha256(authority))，
//     值 = "v1.<base64url(payload)>.<base64url(HMAC-SHA256(secret, body))>"。
//   · 桌面端**每次启动随机选端口**。任何写死的端口只能活到下次重启。
//     所以端口从应用自己的监听 socket 现场发现。
//   · session/page 的 throughSeq 没有"取全部"的值：-1 表示"第一条事件之前"，
//     返回空集。真正的 cursor 只能靠故意越界拿到，错误信息里会给出：
//     "session history cut <n> exceeds <cursor>"。
//   · 响应里 records 是 [{type:'event', event:{...}}]，不是裸事件；
//     assistant 的回复在 event.data.message.content[].text，
//     且只有 event.type === 'assistant/message' 时才有。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { execFileSync } from 'node:child_process';

const b64u = (b) => Buffer.from(b).toString('base64')
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

/* ---------------- 端口发现 ---------------- */

/**
 * 找出远程设备上 DSH 桌面端正在监听的端口。
 *
 * 桌面端每次启动都会随机分配端口，所以这个值不能写进配置。
 * 从「名为 DeepSeek Harness 的进程所持有的 LISTEN socket」反查。
 *
 * @returns {number|null} 端口；应用没在跑时返回 null
 */
export function discoverPort(runPowerShell) {
  const ps = [
    "$p = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id });",
    'if ($p.Count -eq 0) { exit 0 };',
    '$c = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $p -contains $_.OwningProcess });',
    '$c | ForEach-Object { $_.LocalPort }',
  ].join(' ');

  let out;
  try {
    out = runPowerShell(ps);
  } catch {
    return null;
  }
  const ports = String(out).split('\n')
    .map((s) => s.replace('\r', '').trim())
    .filter((s) => /^[0-9]+$/.test(s));
  return ports.length ? Number(ports[0]) : null;
}

/* ---------------- cookie ---------------- */

/**
 * 从 .credentials.yaml 里的持久化密钥自签一个合法的 browser-session cookie。
 *
 * 记录在不同机器上写法不同：有的写成嵌套块，有的写成行内 flow mapping，
 * 所以只匹配 key，不假设布局。
 */
export function mintCookie(credentialsYaml, authority) {
  const m = String(credentialsYaml).match(/client-connection\/browser-session:[\s\S]*?secret:\s*(\S+)/);
  if (!m) return null;
  const secret = Buffer.from(m[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  const now = Date.now();
  const body = b64u(Buffer.from(JSON.stringify({
    version: 1,
    authority,
    issuedAt: now,
    expiresAt: now + 7 * 86400000,
  }), 'utf8'));
  const sig = crypto.createHmac('sha256', secret).update(body).digest();
  const name = 'dsh-auth-' + b64u(crypto.createHash('sha256').update(authority).digest());
  return name + '=v1.' + body + '.' + b64u(sig);
}

/* ---------------- 传输 ---------------- */

/**
 * 一个绑定到具体端口、已带 cookie 的客户端。
 *
 * `send` 走 SSH 隧道到目标机器的 loopback：调用方负责把 createRequester
 * 接到远程执行上，本模块只负责组包/解析。
 */
export function createRpcClient({ port, cookie, request }) {
  const authority = '127.0.0.1:' + port;

  async function call(namespace_method, args) {
    // 这里交出去的是**对象**，不是字符串。编码只在最后一层（远端信使）发生
    // 一次 —— 否则会双重编码，服务端回 "invalid client-request message"，
    // 看起来像协议不兼容，其实只是 stringify 了两遍。
    const body = {
      type: 'client-request',
      rpcId: 'fleet-' + crypto.randomUUID(),
      method: namespace_method,
      payload: { args },
    };
    const raw = await request('/api/' + namespace_method, body);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('回包不是 JSON: ' + String(raw).slice(0, 300));
    }
    const result = parsed.result;
    if (!result) {
      throw new Error('回包缺少 result 字段');
    }
    if (result.ok === false) {
      const err = new Error(
        result.error && result.error.message ? result.error.message : 'RPC 失败',
      );
      err.code = result.error && result.error.code;
      err.details = result.error && result.error.details;
      throw err;
    }
    return result.value;
  }

  return { port, authority, call };
}

/* ---------------- 上层动作 ---------------- */

/**
 * 确保 workspace 已登记，返回它的 id。
 *
 * workspace/create 对已存在的路径是幂等的（返回 created:false），
 * 所以这个函数可以安全地反复调用，既当创建又当读取。
 */
export async function ensureWorkspace(client, workspacePath) {
  const value = await client.call('workspace/create', { request: { path: workspacePath } });
  const ws = value && value.workspace;
  if (!ws || !ws.workspaceId) {
    throw new Error('workspace/create 没有返回 workspaceId');
  }
  return { workspaceId: ws.workspaceId, created: Boolean(value.created), sessionIds: ws.sessionIds || [] };
}

/**
 * 在指定 workspace 里新建会话。
 *
 * session/create 会调用 workspace.attachSession()，**这正是会话出现在界面上的原因**。
 */
export async function createSession(client, workspaceId) {
  const value = await client.call('session/create', { request: { workspaceId } });
  if (!value || !value.sessionId) {
    throw new Error('session/create 没有返回 sessionId');
  }
  return value.sessionId;
}

/** 把一条文本任务投进会话。mode 是必填项，缺了会报边界校验失败。 */
export async function prompt(client, sessionId, text, { mode = 'queue' } = {}) {
  const requestId = 'fleet-' + crypto.randomUUID();
  const value = await client.call('session/prompt', {
    request: {
      sessionId,
      requestId,
      mode,
      content: [{ type: 'text', text }],
    },
  });
  return { accepted: Boolean(value && value.accepted), requestId };
}

/**
 * 读出会话的完整事件日志。
 *
 * throughSeq 没有"全部"这个值，所以必须先知道 cursor。cursor 只能靠
 * 故意越界取得——服务端会在错误信息里告诉我们真实值。这是读它自己
 * 给出的诊断，不是猜。
 */
export async function readEvents(client, sessionId) {
  const address = { kind: 'session', sessionId };
  let cursor = -1;

  try {
    const v = await client.call('session/page', {
      request: { address, throughSeq: 1000000000 },
    });
    // 空会话会正常返回 0 条，而不是报错
    if (v && Array.isArray(v.records)) {
      return { events: v.records.filter((r) => r && r.type === 'event').map((r) => r.event), cursor: -1 };
    }
  } catch (e) {
    const m = String(e && e.message || e).match(/exceeds[ ]+([0-9]+)/);
    if (!m) {
      // 别的失败不能当成"没有输出"吞掉——那样看起来和"agent 什么都没说"一模一样
      throw e;
    }
    cursor = Number(m[1]);
  }

  if (cursor < 0) return { events: [], cursor };

  const v = await client.call('session/page', {
    request: { address, throughSeq: cursor },
  });
  const records = v && Array.isArray(v.records) ? v.records : [];
  return { events: records.filter((r) => r && r.type === 'event').map((r) => r.event), cursor };
}

/** 从事件里取出 assistant 说过的话。只认 assistant/message，避免把用户的提问回显也算进去。 */
export function extractAnswer(events) {
  let out = '';
  for (const ev of events) {
    if (!ev || ev.type !== 'assistant/message') continue;
    const content = ev.data && ev.data.message && ev.data.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') out += block.text;
    }
  }
  return out.trim();
}

/** 这一轮结束了没有。turn/end 之后出现的事件才属于下一轮。 */
export function turnFinished(events, requestId) {
  const idx = events.findIndex((e) => e && e.type === 'user/message' &&
    JSON.stringify(e.data || {}).includes(requestId));
  if (idx < 0) return false;
  return events.slice(idx).some((e) => e && e.type === 'turn/end');
}

/**
 * 把一次派活跑完整：建会话 → 投任务 → 轮询到本轮结束 → 取答案。
 *
 * @param {object} client       createRpcClient 的返回值
 * @param {object} opts
 * @param {string} opts.workspacePath  目标 machine 上的 workspace 目录
 * @param {string} opts.task           任务文本
 * @param {number} [opts.timeoutMs]    超时
 * @param {number} [opts.pollMs]       轮询间隔
 * @param {(msg:string)=>void} [opts.onProgress]
 */
export async function runTask(client, opts) {
  const timeoutMs = opts.timeoutMs ?? 1_800_000;
  const pollMs = opts.pollMs ?? 1000;
  const onProgress = opts.onProgress || (() => {});

  const ws = await ensureWorkspace(client, opts.workspacePath);
  onProgress(`workspace ${ws.workspaceId}${ws.created ? '（新建）' : '（复用）'}`);

  const sessionId = await createSession(client, ws.workspaceId);
  onProgress(`会话 ${sessionId}`);

  // 确认会话真的登记进去了。只看"创建成功"不够——要证明它出现在工作区列表里。
  const after = await ensureWorkspace(client, opts.workspacePath);
  const registered = (after.sessionIds || []).includes(sessionId);
  onProgress(registered ? '已登记进工作区' : '⚠ 未出现在工作区列表');

  const p = await prompt(client, sessionId, opts.task);
  onProgress(p.accepted ? '任务已投递' : '⚠ 任务未被接受');

  const deadline = Date.now() + timeoutMs;
  let events = [];
  let finished = false;
  while (Date.now() < deadline) {
    const r = await readEvents(client, sessionId);
    events = r.events;
    if (turnFinished(events, p.requestId)) {
      finished = true;
      break;
    }
    await new Promise((res) => setTimeout(res, pollMs));
  }

  return {
    workspaceId: ws.workspaceId,
    workspaceCreated: ws.created,
    sessionId,
    registered,
    accepted: p.accepted,
    finished,
    answer: extractAnswer(events),
    eventCount: events.length,
  };
}

export const _internal = { b64u };
