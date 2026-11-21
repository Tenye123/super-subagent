// dsh-fleet —— 被控端报名（beacon）
//
// 解决的问题
//   把一台新机器变成子代理，原本要手工往控制端配置里抄 IP、用户名、
//   密钥路径，再把公钥贴到对方机器上。漏一步就连不上，也没有任何提示。
//
// 做法
//   被控端安装完，自己向控制端发一条报名消息；控制端收到后登记，
//   于是「装完就出现在列表里」。控制端没开也不会丢——报名信息同时
//   落盘在对方机器上，控制端下次启动时主动扫 tailnet 补发现。
//
// 为什么能反向发消息
//   控制端在**自己的 tailnet 地址**上监听（不是 0.0.0.0）。这个地址
//   只存在于 tailnet 内部，公网无法访问，公司内网也看不到。实测：
//   A 向 B 的 100.x 地址 POST，返回 200。
//
// 鉴权（两道，缺一不可）
//   1. 一次性令牌：控制端生成，写进被控端安装脚本。核对用的是
//      timingSafeEqual，避免按字节比较泄露前缀。令牌只用于报名，
//      不用于后续派活（派活走 SSH 公钥）。
//   2. 时间戳：请求带 ts，与服务端时间相差超过 5 分钟即拒。挡重放。
//
// 为什么令牌不是永久的
//   令牌会出现在安装脚本里，可能被复制、被截图。所以：
//   - 默认单次有效：登记成功后立即作废
//   - 也可以显式要求「可重复使用」，用于批量安装，此时靠时间戳+来源校验

import http from 'node:http';
import crypto from 'node:crypto';

/** 报名消息最多允许多少字节。防止有人往里灌大包。 */
const MAX_BODY = 16 * 1024;

/** 时间戳允许的偏差（毫秒）。超过这个差值视为重放。 */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/** 报名消息的协议版本。将来改字段时靠它拒绝老客户端。 */
export const BEACON_VERSION = 1;

/**
 * 生成一个报名令牌。
 *
 * 用 32 字节随机数：它不是密码，不需要让人记住，越难猜越好。
 * 前缀 `fb_` 是为了在日志/脚本里一眼认出这是报名令牌。
 */
export function createToken() {
  return 'fb_' + crypto.randomBytes(32).toString('base64url');
}

/** 定长比较，避免 timing attack。长度不同直接返回 false。 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * 校验一条报名消息。
 *
 * 逐条返回失败原因，不要只返回一个 false —— 界面上要能告诉用户
 * 「是令牌不对」还是「是对方时钟差太多」，这两种的处理方式完全不同。
 *
 * @param {object} msg  解析后的报名消息
 * @param {object} expect
 * @param {string} expect.token          期望的令牌
 * @param {number} [expect.now]          当前时间（测试用）
 * @returns {{ok:boolean, reason?:string, agent?:object}}
 */
export function verifyBeacon(msg, { token, now = Date.now() } = {}) {
  if (!msg || typeof msg !== 'object') {
    return { ok: false, reason: '消息不是对象' };
  }
  if (msg.v !== BEACON_VERSION) {
    return { ok: false, reason: `协议版本不符（收到 ${msg.v}，期望 ${BEACON_VERSION}）` };
  }
  if (!safeEqual(msg.token || '', token || '')) {
    return { ok: false, reason: '令牌不匹配' };
  }

  const ts = Number(msg.ts);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: '缺少时间戳' };
  }
  const skew = Math.abs(now - ts);
  if (skew > CLOCK_SKEW_MS) {
    return {
      ok: false,
      reason: `时间戳偏差 ${Math.round(skew / 1000)} 秒，超过 ${CLOCK_SKEW_MS / 1000} 秒（可能重放，或两台机器时钟不同步）`,
    };
  }

  // 报名只需要这几项就能建立连接；其余是给人看的。
  const name = String(msg.name || '').trim();
  const host = String(msg.host || '').trim();
  const user = String(msg.user || '').trim();
  const ips = Array.isArray(msg.ips) ? msg.ips.filter((x) => typeof x === 'string') : [];
  const ipv4 = ips.find((x) => x.includes('.'));
  if (!ipv4) return { ok: false, reason: '报名消息里没有 IPv4 地址' };
  if (!user) return { ok: false, reason: '报名消息里没有 SSH 用户名' };

  return {
    ok: true,
    agent: {
      name: name || host || ipv4,
      host,
      user,
      tailscaleIp: ipv4,
      ips,
      os: String(msg.os || ''),
      dshVersion: String(msg.dshVersion || ''),
      nodeVersion: String(msg.nodeVersion || ''),
      publicKey: typeof msg.publicKey === 'string' ? msg.publicKey : '',
      reportedAt: new Date(ts).toISOString(),
    },
  };
}

/**
 * 启动报名监听器。
 *
 * @param {object} opts
 * @param {string} opts.host      监听地址（必须是本机 tailnet IPv4）
 * @param {number} opts.port      端口
 * @param {string} opts.token     期望的令牌
 * @param {(agent:object)=>void} opts.onAgent  校验通过后的回调
 * @param {(line:string)=>void} [opts.onLog]
 * @param {(req, res, url) => boolean} [opts.extraRoutes]
 *        额外路由处理器。返回 true 表示已处理（不要再走 /beacon 逻辑）。
 *        用于在同一个 tailnet 监听面上挂 /setup.ps1，避免为了下发
 *        脚本再开一个端口——每多一个监听面就多一份暴露。
 * @returns {{ server: import('node:http').Server, port:number, close:()=>Promise<void> }}
 */
export function startBeaconServer({
  host,
  port,
  token,
  onAgent,
  onLog = () => {},
  extraRoutes = null,
}) {
  const server = http.createServer((req, res) => {
    const reply = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
    };

    // 先给额外路由一次机会。它自己负责写响应并返回 true。
    if (extraRoutes) {
      try {
        if (extraRoutes(req, res, new URL(req.url || '/', 'http://x'))) return;
      } catch (e) {
        onLog('额外路由出错：' + e.message);
        if (!res.headersSent) reply(500, { ok: false, error: 'internal error' });
        return;
      }
    }

    // 只接受一个固定路径，别的一律 404 —— 减少暴露面。
    if (req.method !== 'POST' || req.url !== '/beacon') {
      onLog(`拒绝 ${req.method} ${req.url}`);
      reply(404, { ok: false, error: 'not found' });
      return;
    }

    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        onLog(`报名消息过大（>${MAX_BODY} 字节），断开`);
        req.destroy();
        return;
      }
      chunks.push(c);
    });

    req.on('end', () => {
      let msg;
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        onLog('报名消息不是合法 JSON');
        reply(400, { ok: false, error: 'invalid json' });
        return;
      }

      const v = verifyBeacon(msg, { token });
      if (!v.ok) {
        onLog(`拒绝报名：${v.reason}`);
        reply(403, { ok: false, error: v.reason });
        return;
      }

      onLog(`接受报名：${v.agent.name} (${v.agent.user}@${v.agent.tailscaleIp})`);
      try {
        onAgent(v.agent);
      } catch (e) {
        onLog(`登记失败：${e.message}`);
        reply(500, { ok: false, error: 'enroll failed: ' + e.message });
        return;
      }
      reply(200, { ok: true, enrolled: true, at: new Date().toISOString() });
    });

    req.on('error', (e) => onLog('请求出错：' + e.message));
  });

  server.on('error', (e) => onLog('监听失败：' + e.message));

  // 只在 tailnet 地址上监听。**不要**改成 0.0.0.0：
  // 那会把报名入口暴露到公司内网，等于给陌生人开了个注册通道。
  server.listen(port, host, () => onLog(`报名监听器已启动 ${host}:${port}`));

  return {
    server,
    port,
    close: () =>
      new Promise((resolve) => {
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
      }),
  };
}

/**
 * 被控端一侧：向控制端报名。
 *
 * 用 node 内置 http，不引入依赖。失败时把原因说清楚——
 * 安装脚本里这一步失败，用户需要知道是网络不通还是令牌不对。
 *
 * @param {object} opts
 * @param {string} opts.url      形如 http://100.x.y.z:47321/beacon
 * @param {string} opts.token
 * @param {object} opts.self     { name, host, user, ips, os, dshVersion, nodeVersion, publicKey }
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ok:boolean, status?:number, body?:string, error?:string}>}
 */
export function sendBeacon({ url, token, self, timeoutMs = 15_000 }) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      resolve({ ok: false, error: '报名地址不是合法 URL: ' + url });
      return;
    }

    const payload = JSON.stringify({
      v: BEACON_VERSION,
      token,
      ts: Date.now(),
      ...self,
    });

    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            body,
          });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: `报名超时（${timeoutMs}ms 内控制端无响应）` });
    });
    req.on('error', (e) => {
      resolve({ ok: false, error: '报名请求失败: ' + e.message });
    });

    req.write(payload);
    req.end();
  });
}
