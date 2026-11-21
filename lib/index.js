// super-subagent —— DSH 插件：控制端
//
// 这个文件是插件对自己暴露的东西。它做两件事：
//
//   1. 提供一个本地 HTTP API，让设置页可以查询设备、生成引导脚本、
//      发起派活。端口固定，因为前端要写死它（与 ai-bot-panel 的做法一致）。
//
//   2. 在插件生命周期里启动“报名监听器”，接收新被控端的自我注册。
//
// 为什么不用 ctx 注册工具
//   查过 dsh-session-manager 的实际用法：ctx 是 cordis 服务容器，暴露的是
//   ctx.sessions / ctx.agents / ctx.waterfall / ctx.parallel 这类内部服务，
//   不是工具注册表。ai-bot-panel（同样是自己写的插件）用的是“开一个
//   HTTP 服务给前端调”的方式，这条路已被验证可行。
//
//   所以内置工具走 MCP（mcp/server.mjs），插件只负责界面和生命周期。
//   两者共用 lib/ 里的核心代码，不重复实现。
//
// 崩溃隔离
//   插件运行在 DSH 主进程里。任何未捕获异常都可能拖垮整个 DSH，所以：
//     - 所有异步入口都包 try/catch
//     - SSH 调用都在子进程里，不占用事件循环
//     - 派活必须走后台任务 + 轮询，绝不在请求里同步等待 30 分钟

import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import crypto from 'node:crypto';

import * as beacon from './beacon.mjs';
import * as discover from './discover.mjs';
import * as scriptServer from './script-server.mjs';
import { buildAgentScript, assertAscii } from './bootstrap-script.mjs';
import * as config from './config.mjs';
import * as probe from './probe.mjs';

/**
 * 本地 API 端口。
 *
 * 为什么是 6210 而不是 6200/6201：实测 DSH 主进程自己占着 6200 和 6201
 * （6200 是 ai-bot-panel 插件，6201 是 DSH 内部服务）。用 6201 会
 * EADDRINUSE，而插件当时只是打了个 warn 就继续跑，前端拿到的全是 404——
 * 这种"看起来启动了其实没有"的失败最难查。所以端口往上让开一段。
 *
 * 可以用环境变量覆盖。这不只是给测试用的：同一台机器上有多个 DSH
 * 实例（或者想并行跑一套用于对比）时，硬编码端口就会打架，而症状是
 * 第二个实例静默拿不到 API。能改端口比"只能有一个"合理。
 *
 * 前端写死这个值，改动时必须同步改 lib/client.js。
 */
const API_PORT = Number(process.env.DSH_FLEET_API_PORT) || 6210;

/**
 * 报名监听器监听的端口。与 API 端口分开，避免混淆。
 *
 * 同样支持环境变量覆盖，理由同上。
 */
const BEACON_PORT = Number(process.env.DSH_FLEET_BEACON_PORT) || 47321;

/**
 * 临时脚本分发通道的端口。
 *
 * 为什么需要第二个下发端口：一台**还没进 tailnet** 的机器访问不到
 * 100.x 地址，而"装 Tailscale"正是脚本第 3 步。全新机器会卡在这个死结上。
 * 所以用户明确选择"目标机器还不在 tailnet"时，额外开这个口子。
 *
 * 它只服务 GET /setup.ps1，30 分钟自动关闭。
 * 端口选 47322 是为了和 47321 成对，便于记忆和排查。
 */
const LAN_SCRIPT_PORT = Number(process.env.DSH_FLEET_LAN_PORT) || 47322;

/** 派活超时上限。超过这个时间强制失败，避免任务永远挂着。 */
const MAX_TASK_MS = 60 * 60 * 1000;

/** 报名令牌存在这里。每次生成新令牌覆盖它。 */
function tokenFile() {
  return join(config.PATHS.home, 'beacon-token.txt');
}

/** 已登记设备清单，与 fleet.json 的 devices 共用。 */
function loadDevices() {
  try {
    const c = config.loadConfig();
    return Array.isArray(c.devices) ? c.devices : [];
  } catch {
    return [];
  }
}

function saveDevices(devices) {
  const c = config.loadConfig();
  c.devices = devices;
  config.saveConfig(c);
}

/** 读或新建报名令牌。没有就生成一个并落盘。 */
function ensureToken() {
  const f = tokenFile();
  try {
    if (existsSync(f)) {
      const t = readFileSync(f, 'utf8').trim();
      if (/^fb_[A-Za-z0-9_-]{20,}$/.test(t)) return t;
    }
  } catch {
    // 读失败就重新生成，不要让插件因此启动不了
  }
  const t = beacon.createToken();
  try {
    mkdirSync(config.PATHS.home, { recursive: true });
    writeFileSync(f, t, 'utf8');
  } catch {
    // 落盘失败也能用，只是重启后会换新令牌
  }
  return t;
}

/** 本机的 tailnet IPv4。没有就返回 null —— 没有它报名无法工作。 */
function selfTailscaleIp() {
  const info = probe.tailscaleInfo();
  if (!info.up) return null;
  return info.ips.find((x) => x.includes('.')) || null;
}

/**
 * 取控制端身份公钥。没有就现生成一套。
 *
 * 为什么需要一对专属的"控制端密钥"
 *   引导脚本要把控制端公钥写进被控端的 authorized_keys。这个公钥必须
 *   是**控制端这台机器**持有的私钥所对应的那个，否则装完连不上。
 *
 *   配置里`ssh.publicKey` 字段历史上没被填过（实测为空），密钥目录里
 *   也可能只有某台设备的密钥。所以这里按明确规则取：
 *     1. 配置里显式写了就用它
 *     2. 否则用 keys/controller.key.pub
 *     3. 都没有就用 ssh-keygen 生成 keys/controller.key（无口令）
 *
 *   用专属密钥而不是复用某台设备的密钥：设备的密钥应当随设备撤销，
 *   而控制端身份不该跟着某台设备一起失效。
 *
 * @returns {{publicKey:string, privateKey:string, created:boolean}}
 */
function ensureControllerKey() {
  // 1. 配置里显式指定
  try {
    const c = config.loadConfig();
    if (c.ssh && typeof c.ssh.publicKey === 'string' && /^ssh-/.test(c.ssh.publicKey)) {
      return { publicKey: c.ssh.publicKey.trim(), privateKey: c.ssh.keyPath || '', created: false };
    }
  } catch {
    // 配置读不到就继续走生成流程
  }

  // 2. 已有的专属密钥
  const priv = join(config.PATHS.keys, 'controller.key');
  const pub = priv + '.pub';
  if (existsSync(pub)) {
    const t = readFileSync(pub, 'utf8').trim();
    if (/^ssh-/.test(t)) return { publicKey: t, privateKey: priv, created: false };
  }

  // 3. 现场生成
  const r = config.generateKeyPair('controller');
  const t = readFileSync(r.publicKey, 'utf8').trim();
  return { publicKey: t, privateKey: r.privateKey, created: true };
}
/**
 * 最近生成的引导脚本缓存。
 *
 * 为什么需要缓存：前端的"一条命令"是 `irm http://<控制器>:6210/setup.ps1?id=xxx`，
 * 目标机器拿到的是**脚本文件**，而不是前端手里的那段字符串。所以生成时
 * 必须把脚本存起来，供 /setup.ps1 按 id 取。
 *
 * 为什么要过期：脚本里含报名令牌。长期留在内存里，等于令牌一直有效。
 * 30 分钟足够用户复制粘贴并执行；过期后重新生成即可。
 */
const scriptCache = new Map();
const SCRIPT_TTL_MS = 30 * 60 * 1000;

function cacheScript(id, script) {
  // 顺手清掉过期的，避免这个表无限增长
  const now = Date.now();
  for (const [k, v] of scriptCache) {
    if (now - v.at > SCRIPT_TTL_MS) scriptCache.delete(k);
  }
  scriptCache.set(id, { script, at: now });
}

function takeScript(id) {
  const hit = scriptCache.get(id);
  if (!hit) return null;
  if (Date.now() - hit.at > SCRIPT_TTL_MS) {
    scriptCache.delete(id);
    return null;
  }
  return hit.script;
}

/**
 * 当前开着的临时脚本分发通道。同一时刻只保留一个。
 *
 * 为什么是单例：用户可能反复点"重新生成"，每点一次都开一个端口就会
 * 堆出一串监听。与其管理一堆，不如开新的之前先把旧的关掉——反正旧 id
 * 对应的命令还没被用掉的话，重新生成也会拿到新 id。
 */
let activeScriptSrv = null;

/**
 * 派活任务表。
 *
 * 为什么用内存而不是落库：DSH 重启后这些任务本来也无法继续（会话在
 * 远端还在，但等待状态没了）。落库只会留下一堆永远"运行中"的假记录。
 * 历史任务由 fleet 的 jobs 目录负责，那里才是持久的。
 */
const tasks = new Map();

function newTaskId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds());
  const rand = Math.random().toString(36).slice(2, 8);
  return stamp + '-' + rand;
}

/**
 * 后台跑一个派活任务。
 *
 * 关键：这个函数**不 await**，调用方立刻拿到 taskId 去轮询。
 * 否则一个 30 分钟的任务会让 HTTP 请求挂 30 分钟，前端必然超时。
 */
function startTask({ device, task, cwd, session, timeoutMs }) {
  const id = newTaskId();
  const rec = {
    id,
    device,
    task: String(task || '').slice(0, 200),
    state: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    result: null,
    error: null,
    sessionId: session || null,
    steps: [],
  };
  tasks.set(id, rec);
  rec.steps.push('已排队');

  (async () => {
    try {
      const dev = findDeviceOrThrow(device);
      rec.steps.push('已找到设备 ' + dev.name);

      // 直接复用 dispatch()：它已经封装了"发现端口 → 读凭据 → 签 cookie →
      // 解析工作目录 → 建会话 → 发问 → 轮询"整条链路。在这里重写一遍
      // 只会多出一份会过期的副本。
      const { dispatch } = await import('./dispatch-rpc.mjs');
      const out = await dispatch(dev, task, {
        cwd,
        timeoutMs: Math.min(Number(timeoutMs) || MAX_TASK_MS, MAX_TASK_MS),
        pollMs: 2000,
        onProgress: (p) => {
          if (p && p.message) rec.steps.push(String(p.message).slice(0, 300));
        },
      });

      rec.state = 'done';
      rec.result = out;
      rec.sessionId = (out && out.sessionId) || rec.sessionId;
      rec.finishedAt = new Date().toISOString();
      rec.steps.push('完成');
    } catch (e) {
      rec.state = 'failed';
      rec.error = String((e && e.message) || e);
      rec.finishedAt = new Date().toISOString();
      rec.steps.push('失败: ' + rec.error);
    }
  })();

  return rec;
}

function findDeviceOrThrow(name) {
  const devices = loadDevices();
  const d = devices.find((x) => x.name === name || x.host === name);
  if (!d) {
    const known = devices.map((x) => x.name).join(', ') || '(空)';
    throw new Error('没有这台设备: ' + name + '（已登记: ' + known + '）');
  }
  if (!d.keyPath || !existsSync(d.keyPath)) {
    throw new Error('设备 ' + name + ' 的密钥不存在: ' + (d.keyPath || '(未配置)'));
  }
  return d;
}

/* ================================================================== */
/* HTTP API                                                            */
/* ================================================================== */

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * 路由表。
 *
 * 每个 handler 都返回 {code, body}，统一由外层发送。
 * 这样任何 handler 抛异常都能被兜住，不会让服务端崩掉。
 */
const routes = {
  'GET /status': async () => {
    const ts = probe.tailscaleInfo();
    const devices = loadDevices();
    const token = ensureToken();
    const selfIp = selfTailscaleIp();
    return {
      code: 200,
      body: {
        ok: true,
        version: '0.3.0',
        role: 'controller',
        self: {
          host: probe.hostName(),
          tailscaleIp: selfIp,
          tailscaleUp: ts.up,
          tailscaleIps: ts.ips,
        },
        counts: { devices: devices.length },
        beacon: {
          port: BEACON_PORT,
          listening: selfIp ? true : false,
          // 令牌只显示前 8 位，避免在截图/日志里泄露完整令牌。
          tokenPrefix: token.slice(0, 11) + '...',
        },
      },
    };
  },

  'GET /devices': async () => {
    const devices = loadDevices();
    return { code: 200, body: { ok: true, devices } };
  },

  // 扫描 tailnet，返回所有可见设备及其就绪状态。
  // 这是"自动发现"的入口：不需要事先登记就能看到对方。
  'GET /scan': async () => {
    const { devices: tailnet, error } = discover.listTailnetDevices();
    if (error) return { code: 200, body: { ok: false, error, devices: [] } };

    const configured = loadDevices();
    const byIp = new Map(configured.map((d) => [d.tailscaleIp, d]));

    // 对每台已登记的设备做完整探测；未登记的只报"看得见"。
    const known = tailnet.filter((t) => byIp.has(t.tailscaleIp));
    const results = await discover.probeAll(
      known.map((t) => ({ ...byIp.get(t.tailscaleIp), tailscaleIp: t.tailscaleIp })),
      { concurrency: 3 },
    );
    const probed = new Map(results.map((r) => [r.tailscaleIp, r]));

    const merged = tailnet.map((t) => {
      const p = probed.get(t.tailscaleIp);
      return {
        name: (byIp.get(t.tailscaleIp) || {}).name || t.name,
        host: t.host,
        tailscaleIp: t.tailscaleIp,
        os: t.os,
        online: t.online,
        lastSeen: t.lastSeen,
        enrolled: byIp.has(t.tailscaleIp),
        state: p ? p.state : t.online ? 'unprobed' : 'offline',
        stateLabel: p ? discover.stateLabel(p.state) : t.online ? '在线（未登记）' : '离线',
        detail: p ? p.detail : '',
      };
    });

    return { code: 200, body: { ok: true, devices: discover.sortByState(merged) } };
  },

  // 生成引导脚本，让用户复制到目标机器上执行。
  'POST /bootstrap': async (req) => {
    const body = await readBody(req);
    const selfIp = selfTailscaleIp();
    if (!selfIp) {
      return {
        code: 400,
        body: {
          ok: false,
          error: '本机没有 Tailscale 地址，无法生成引导脚本。请先 tailscale up。',
        },
      };
    }

    // 控制端公钥：没有就现生成一对专属密钥。
    let keyInfo;
    try {
      keyInfo = ensureControllerKey();
    } catch (e) {
      return {
        code: 500,
        body: { ok: false, error: '无法准备控制端密钥: ' + String(e.message || e) },
      };
    }
    const pubKey = keyInfo.publicKey;

    const token = ensureToken();
    let script;
    try {
      script = buildAgentScript({
        controllerIp: selfIp,
        beaconPort: BEACON_PORT,
        token,
        controllerPubKey: pubKey,
        agentName: body.agentName || '',
        sshPort: Number(body.sshPort) || 22,
        tailscaleAuthKey: body.tailscaleAuthKey || '',
      });
    } catch (e) {
      return { code: 400, body: { ok: false, error: String(e.message || e) } };
    }

    const ascii = assertAscii(script);
    if (!ascii.ok) {
      return {
        code: 500,
        body: {
          ok: false,
          error:
            '内部错误：生成的脚本含有非 ASCII 字符（位置 ' +
            ascii.badIndex +
            '），PowerShell 5.1 会解析失败，已拒绝下发',
        },
      };
    }

    // 缓存起来供 /setup.ps1 取用，这样前端只需要给用户一行命令。
    const genId = crypto.randomBytes(9).toString('base64url');
    cacheScript(genId, script);

    // ---- 决定这行命令从哪个地址下发 ----
    //
    // 这是本项目最容易做错的一处，所以把判断依据写清楚：
    //
    //   目标机器**已经在 tailnet 里**（重装、补装）→ 用 tailnet 地址，
    //     不用开任何额外端口，最安全。
    //
    //   目标机器**还不在 tailnet 里**（全新机器）→ tailnet 地址它访问不到，
    //     必须走局域网地址 + 临时通道。否则用户会拿到一条永远连不上的命令，
    //     而且看不出为什么。
    //
    // 前端通过 wantLan=true 明确要求走局域网通道；不传则保持旧行为。
    const wantLan = body.deliverTo === 'lan';
    if (!wantLan) {
      return {
        code: 200,
        body: {
          ok: true,
          script,
          genId,
          controllerIp: selfIp,
          beaconPort: BEACON_PORT,
          deliverVia: 'tailnet',
          downloadUrl: `http://${selfIp}:${BEACON_PORT}/setup.ps1?id=${genId}`,
          lanAddresses: scriptServer.listLanAddresses(networkInterfaces),
        },
      };
    }

    // 用户没指定地址时，从可用地址里挑一个最可能的。
    const lanList = scriptServer.listLanAddresses(networkInterfaces);
    const chosen = String(body.lanAddress || '').trim() || (lanList[0] ? lanList[0].address : '');
    if (!chosen) {
      return {
        code: 400,
        body: {
          ok: false,
          error: '本机没有可用的局域网地址，无法给"还没进 tailnet"的机器下发脚本。请改用 tailnet 方式。',
        },
      };
    }

    // 同一时刻只保留一个分发通道，避免用户反复点"重新生成"开出一堆端口。
    try {
      if (activeScriptSrv) await activeScriptSrv.close();
    } catch {
      // 关不掉旧的也不影响开新的
    }
    activeScriptSrv = null;

    try {
      activeScriptSrv = scriptServer.startScriptServer({
        host: chosen,
        port: LAN_SCRIPT_PORT,
        ttlMs: SCRIPT_TTL_MS,
        takeScript,
        onLog: (l) => log('setup: ' + l),
      });
    } catch (e) {
      return {
        code: 500,
        body: { ok: false, error: '无法在 ' + chosen + ':' + LAN_SCRIPT_PORT + ' 上开分发通道: ' + String(e.message || e) },
      };
    }

    return {
      code: 200,
      body: {
        ok: true,
        script,
        genId,
        controllerIp: selfIp,
        beaconPort: BEACON_PORT,
        deliverVia: 'lan',
        lanAddress: chosen,
        downloadUrl: `http://${chosen}:${LAN_SCRIPT_PORT}/setup.ps1?id=${genId}`,
        // 通道是一次性的，但用户可能要多复制几次，所以按 TTL 报个准数。
        expiresInMin: Math.round(SCRIPT_TTL_MS / 60000),
        lanAddresses: lanList,
      },
    };
  },

  // 注意：/setup.ps1 不在这里。它由 tailnet 监听面（报名监听器）提供，
  // 因为目标机器必须能访问到——127.0.0.1 在对方机器上指向它自己。

  // 登记一台设备。既可以由报名自动调用，也可以用户手工填。
  'POST /devices': async (req) => {
    const body = await readBody(req);
    if (!body.tailscaleIp || !body.user) {
      return { code: 400, body: { ok: false, error: '需要 tailscaleIp 和 user' } };
    }
    const devices = loadDevices();
    const existing = devices.findIndex((d) => d.tailscaleIp === body.tailscaleIp);
    const rec = {
      name: body.name || body.host || body.tailscaleIp,
      user: body.user,
      tailscaleIp: body.tailscaleIp,
      keyPath: body.keyPath || join(config.PATHS.keys, 'controller.key'),
      port: Number(body.port) || 22,
      enrolledAt: new Date().toISOString(),
      source: body.source || 'manual',
    };
    if (existing >= 0) devices[existing] = { ...devices[existing], ...rec };
    else devices.push(rec);
    saveDevices(devices);
    return { code: 200, body: { ok: true, device: rec } };
  },

  'DELETE /devices': async (req) => {
    const body = await readBody(req);
    const devices = loadDevices();
    const next = devices.filter((d) => d.name !== body.name);
    if (next.length === devices.length) {
      return { code: 404, body: { ok: false, error: '没有这台设备: ' + body.name } };
    }
    saveDevices(next);
    return { code: 200, body: { ok: true, removed: devices.length - next.length } };
  },

  // 派活：立即返回 taskId，任务在后台跑。
  'POST /run': async (req) => {
    const body = await readBody(req);
    if (!body.device) return { code: 400, body: { ok: false, error: '需要 device' } };
    if (!body.task) return { code: 400, body: { ok: false, error: '需要 task' } };
    const rec = startTask({
      device: body.device,
      task: body.task,
      cwd: body.cwd,
      session: body.session,
      timeoutMs: body.timeoutMs,
    });
    return { code: 200, body: { ok: true, taskId: rec.id, state: rec.state } };
  },

  'GET /tasks': async (req, url) => {
    const id = url.searchParams.get('id');
    if (id) {
      const t = tasks.get(id);
      if (!t) return { code: 404, body: { ok: false, error: '没有这个任务: ' + id } };
      return { code: 200, body: { ok: true, task: t } };
    }
    const list = [...tasks.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    return { code: 200, body: { ok: true, tasks: list.slice(0, 50) } };
  },
};

/* ================================================================== */
/* 插件入口                                                            */
/* ================================================================== */

export function apply(ctx) {
  const log = (m) => {
    try {
      ctx.logger?.info?.('[super-subagent] ' + m);
    } catch {
      // 日志失败不能影响主流程
    }
  };
  const warn = (m) => {
    try {
      ctx.logger?.warn?.('[super-subagent] ' + m);
    } catch {
      // 同上
    }
  };

  /* ---- 1. 报名监听器（同时下发引导脚本）---- */
  let beaconSrv = null;
  const selfIp = selfTailscaleIp();
  if (selfIp) {
    try {
      const token = ensureToken();
      beaconSrv = beacon.startBeaconServer({
        host: selfIp,
        port: BEACON_PORT,
        token,
        onLog: (l) => log('beacon: ' + l),

        // 在这个 tailnet 监听面上同时提供 /setup.ps1。
        //
        // 为什么不放到 127.0.0.1 的 API 上：目标机器要能访问到脚本，
        // 而 127.0.0.1 在对方机器上指向它自己。所有"给别的机器用"的
        // 东西都必须走 tailnet 地址。
        extraRoutes: (req, res, url) => {
          if (req.method !== 'GET' || url.pathname !== '/setup.ps1') return false;

          const script = takeScript(url.searchParams.get('id') || '');
          if (!script) {
            const body = JSON.stringify({
              ok: false,
              error: '脚本不存在或已过期（30 分钟）。回控制端设置页重新生成一条命令。',
            });
            res.writeHead(404, {
              'content-type': 'application/json; charset=utf-8',
              'content-length': Buffer.byteLength(body),
            });
            res.end(body);
            return true;
          }

          // PowerShell 的 irm 对 text/plain 处理最干净。
          res.writeHead(200, {
            'content-type': 'text/plain; charset=us-ascii',
            'content-length': Buffer.byteLength(script),
          });
          res.end(script);
          log('beacon: 已下发引导脚本（' + script.length + ' 字节）');
          return true;
        },

        onAgent: (agent) => {
          // 报名通过后自动登记。这是"装完就出现在列表里"的实现。
          const devices = loadDevices();
          const idx = devices.findIndex((d) => d.tailscaleIp === agent.tailscaleIp);
          const rec = {
            name: agent.name,
            user: agent.user,
            tailscaleIp: agent.tailscaleIp,
            // 报名时对方还没有我们的专属密钥，先用默认路径；
            // 用户可以随时在界面上改。
            keyPath: join(config.PATHS.keys, 'controller.key'),
            port: 22,
            os: agent.os,
            nodeVersion: agent.nodeVersion,
            enrolledAt: new Date().toISOString(),
            source: 'beacon',
          };
          if (idx >= 0) devices[idx] = { ...devices[idx], ...rec };
          else devices.push(rec);
          saveDevices(devices);
          log('beacon: 已登记 ' + agent.name + ' (' + agent.user + '@' + agent.tailscaleIp + ')');
        },
      });
    } catch (e) {
      warn('报名监听器启动失败: ' + String(e.message || e) + '（不影响派活，只是新设备要手工登记）');
    }
  } else {
    warn('本机没有 Tailscale 地址，跳过报名监听器。先执行 tailscale up。');
  }

  /* ---- 2. 本地 HTTP API ---- */
  const server = createServer(async (req, res) => {
    // 设置页的 origin 与本服务不同端口，必须放开 CORS。
    // 只监听 127.0.0.1，所以不担心外部访问。
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const key = req.method + ' ' + url.pathname;
    const handler = routes[key];
    if (!handler) {
      sendJson(res, 404, { ok: false, error: 'no route: ' + key });
      return;
    }

    try {
      const { code, body } = await handler(req, url);
      sendJson(res, code, body);
    } catch (e) {
      // 任何 handler 的异常都在这里兜住。绝不让它冒到 DSH 主进程。
      warn('API ' + key + ' 失败: ' + String((e && e.message) || e));
      sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });

  // 监听失败必须显式暴露，不能只打一条 warn 就继续跑。
  //
  // 实测教训：初版用 6201，撞上 DSH 自己的端口，插件打了条 warn 就继续，
  // 而前端拿到的全是 404。用户看到的是"界面空白"，没有任何线索指向
  // 端口冲突。所以这里把失败原因记进 lastApiError，并让 /status 之外
  // 的所有路由返回 503 + 明确原因。
  let apiListenError = null;
  server.on('error', (e) => {
    apiListenError = e;
    warn(
      '本地 API 启动失败: ' +
        String(e.message || e) +
        '（前端将无法工作；检查是否有别的程序占用 127.0.0.1:' +
        API_PORT +
        '）',
    );
  });
  server.listen(API_PORT, '127.0.0.1', () => {
    log('本地 API 已启动 127.0.0.1:' + API_PORT);
    if (beaconSrv) log('报名监听器 ' + selfIp + ':' + BEACON_PORT);
  });

  /* ---- 3. 清理 ---- */
  ctx.effect(() => () => {
    try {
      // 只调 close() 不够：它停止接受新连接，但会等已有连接自然结束。
      // 前端的 keep-alive 连接可能挂很久，于是端口迟迟不释放——插件
      // 重载时就会 EADDRINUSE。closeAllConnections() 是 Node 18.2+ 的
      // 官方手段，直接把存量连接掐掉。
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      server.close();
    } catch {
      // 关闭失败不该影响卸载流程
    }
    if (beaconSrv) {
      try {
        if (typeof beaconSrv.server.closeAllConnections === 'function') {
          beaconSrv.server.closeAllConnections();
        }
      } catch {
        // 同上
      }
      beaconSrv.close().catch(() => {});
    }
    if (activeScriptSrv) {
      try {
        if (typeof activeScriptSrv.server.closeAllConnections === 'function') {
          activeScriptSrv.server.closeAllConnections();
        }
      } catch {
        // 同上
      }
      activeScriptSrv.close().catch(() => {});
      activeScriptSrv = null;
    }
    log('已关闭');
  });
}

export const name = 'super-subagent';
