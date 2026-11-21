// dsh-fleet —— 设备发现与就绪探测
//
// 为什么分两级
//   「出现在 tailnet 里」和「能派活」是两件事。实测过：A 在 tailnet
//   显示 online=True，但从 B 连它的 22 端口超时（sshd 没起来），
//   于是派活直接失败。
//
//   所以这里严格区分：
//     discovered —— tailscale status 里有它
//     reachable  —— 22 端口能连上
//     ready      —— 22 通 + DSH 桌面端在跑 + 我们能读到它的凭据
//
//   界面上必须分开显示，否则用户看到一列「在线」却个个报错。
//
// 探测顺序是刻意的
//   先做 TCP（便宜、快、失败原因明确），再做需要 SSH 的检查（贵）。
//   这样绝大多数「不可用」在第一步就判定完，不必等 SSH 超时。
//
// 为什么每次都重新发现端口
//   DSH 桌面的 API 端口每次启动随机（实测 50817 → 58480 → 61257）。
//   缓存它必然过期，所以每个设备每次探测都重新问。

import net from 'node:net';
import { tailscaleInfo } from './probe.mjs';
import { runCmd } from './util.mjs';
import { exec } from './ssh.mjs';

/** 单次 TCP 探测的默认超时。超过就是"连不上"，不必等更久。 */
const TCP_TIMEOUT_MS = 4_000;

/**
 * 读本机 tailnet 的全部设备（不含自己）。
 *
 * 直接复用 probe.tailscaleInfo 拿不到 Peer 列表，所以这里自己解析
 * `tailscale status --json`。失败时返回空数组 + 原因，不抛异常——
 * 控制端没装 Tailscale 时界面应该显示"未连接"，而不是整个插件崩掉。
 *
 * @returns {{ devices: object[], error: string|null }}
 */
export function listTailnetDevices() {
  const info = tailscaleInfo();
  if (!info.installed) return { devices: [], error: '本机未安装 Tailscale' };
  if (!info.up) return { devices: [], error: `Tailscale 未就绪：${info.error || 'unknown'}` };

  // probe.mjs 只保留 Self 的信息，Peer 列表要自己再解析一次。
  // 为了让 probe 保持单一职责（只回答"本机能不能用"），值得多跑一次命令。
  const r = runCmd('tailscale', ['status', '--json'], { timeout: 15_000 });
  if (r.code !== 0) {
    return { devices: [], error: '读取 tailscale status 失败: ' + (r.stderr || '').slice(0, 200) };
  }

  let j;
  try {
    j = JSON.parse(r.stdout);
  } catch {
    return { devices: [], error: 'tailscale status 输出不是合法 JSON' };
  }

  const peers = Object.values(j.Peer || {});
  const devices = peers.map((p) => {
    const ips = Array.isArray(p.TailscaleIPs) ? p.TailscaleIPs : [];
    const ipv4 = ips.find((x) => typeof x === 'string' && x.includes(':') === false);
    return {
      // DNSName 形如 "host.tailXXXX.ts.net."，取首段当默认显示名
      name: (p.DNSName || '').split('.')[0] || p.HostName || ipv4 || '(unknown)',
      host: p.HostName || '',
      tailscaleIp: ipv4 || null,
      ips,
      os: p.OS || '',
      online: Boolean(p.Online),
      // LastSeen 是零值时表示"从未握手"，不要显示成 0001 年
      lastSeen: p.LastSeen && !String(p.LastSeen).startsWith('0001') ? p.LastSeen : null,
      rxBytes: p.RxBytes || 0,
      txBytes: p.TxBytes || 0,
      // 这是 tailnet 内的直连地址，将来可以直接 HTTP 访问对方
      peerApiUrl: typeof p.PeerAPIURL === 'string' ? p.PeerAPIURL : null,
    };
  });

  // 只保留有 IPv4 的：纯 IPv6 节点没法当 SSH 目标（我们的 ssh 配置用 IPv4）。
  return { devices: devices.filter((d) => d.tailscaleIp), error: null };
}

/**
 * 探测单个 TCP 端口能否连上。
 *
 * 不抛异常：连不上是**正常结果**，不是错误。用 resolved value 区分，
 * 调用方就不必写 try/catch 包住每一次探测。
 *
 * @returns {Promise<{open:boolean, ms:number, error?:string}>}
 */
export function probeTcp(host, port, timeoutMs = TCP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = new net.Socket();
    let settled = false;

    const done = (result) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve({ ms: Date.now() - started, ...result });
    };

    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done({ open: true }));
    sock.once('timeout', () => done({ open: false, error: 'timeout' }));
    sock.once('error', (e) => done({ open: false, error: e.code || e.message }));

    try {
      sock.connect(port, host);
    } catch (e) {
      done({ open: false, error: e.code || e.message });
    }
  });
}

/**
 * 在远端找 DSH 桌面端的 API 端口。
 *
 * 逻辑与 dispatch-rpc.findAgentPort 一致，但这里不抛异常：
 * 探测阶段"没找到"是常见情况（对方 DSH 没开），不该中断整轮扫描。
 *
 * @returns {{port:number|null, error:string|null}}
 */
export function findRemoteDshPort(dev, { timeoutMs = 20_000 } = {}) {
  const script = [
    "$p = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })",
    'if ($p.Count -eq 0) { exit 0 }',
    '$c = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $p -contains $_.OwningProcess })',
    '$c | ForEach-Object { $_.LocalPort }',
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');

  try {
    const r = exec(dev, 'powershell -NoProfile -NonInteractive -EncodedCommand ' + encoded, {
      timeout: timeoutMs,
    });
    const ports = String(r.stdout || '')
      .split(/\s+/)
      .map((x) => Number(x.trim()))
      .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
    // 取最大的那个：DSH 的 API 端口通常高于固定的辅助端口。
    if (ports.length) return { port: Math.max(...ports), error: null };
    return { port: null, error: 'DSH 桌面端未运行' };
  } catch (e) {
    return { port: null, error: 'SSH 查询失败: ' + String(e.message || e) };
  }
}

/**
 * 对一台候选设备做完整就绪探测。
 *
 * @param {object} dev  { name, user, tailscaleIp, keyPath, port }
 * @returns {Promise<object>} 探测结果，含 state 字段
 */
export async function probeDevice(dev) {
  const result = {
    name: dev.name,
    host: dev.host || dev.name,
    tailscaleIp: dev.tailscaleIp,
    user: dev.user,
    state: 'unknown',
    detail: '',
    ssh: { open: false, ms: 0, error: null },
    dsh: { port: null, found: false, error: null },
    checkedAt: new Date().toISOString(),
  };

  // --- 1. TCP 22 ---
  const sshPort = dev.port || 22;
  const tcp = await probeTcp(dev.tailscaleIp, sshPort);
  result.ssh = tcp;
  if (!tcp.open) {
    result.state = 'unreachable';
    result.detail =
      tcp.error === 'timeout'
        ? `SSH 端口 ${sshPort} 连接超时（对方 sshd 未运行，或被防火墙拦住）`
        : `SSH 端口 ${sshPort} 连不上：${tcp.error}`;
    return result;
  }

  // --- 2. 远端 DSH 端口 ---
  // 只有 TCP 通过才做这一步：SSH 不通时再问也是白等 20 秒。
  const portInfo = findRemoteDshPort(dev);
  result.dsh = { port: portInfo.port, found: Boolean(portInfo.port), error: portInfo.error };
  if (!portInfo.port) {
    result.state = 'no-dsh';
    result.detail = `SSH 可达，但${portInfo.error || 'DSH 桌面端未运行'}——对方打开 DSH 后才能派活`;
    return result;
  }

  // --- 3. 判据：DSH 端口在监听，就认为可派活 ---
  //
  // 更严格的判据应该是"能读到 .credentials.yaml 里 browser-session 密钥"，
  // 但那需要多一次 SSH + 一次 HTTP 握手。放在这里会让扫描变慢一倍，
  // 而它失败的场景（凭据缺失）极少——凭据是 DSH 自己生成的，除非用户
  // 手工删过。所以这里用端口监听作判据，把真正的鉴权失败留给派活时报。
  //
  // 这个取舍是有代价的：凭据坏掉时，设备会显示"可派活"但派活失败。
  // 因此派活路径必须把鉴权错误原样透出，不能让用户只看到"失败"。
  result.state = 'ready';
  result.detail = `SSH 通（${tcp.ms}ms），DSH API 端口 ${portInfo.port}`;

  return result;
}

/**
 * 批量探测。
 *
 * 串行还是并行？这里选并行但限制并发。
 * 串行：10 台设备 × (4s TCP + 20s SSH) 最坏要 4 分钟，界面会假死。
 * 无限并行：一次开几十个 SSH，反而更慢且可能触发对方连接数限制。
 *
 * @param {object[]} devices
 * @param {object} [opts]
 * @param {number} [opts.concurrency]
 * @param {(r:object)=>void} [opts.onResult] 每台出结果就回调，便于界面渐进刷新
 */
export async function probeAll(devices, { concurrency = 4, onResult = () => {} } = {}) {
  const queue = [...devices];
  const out = [];

  async function worker() {
    while (queue.length) {
      const dev = queue.shift();
      let r;
      try {
        r = await probeDevice(dev);
      } catch (e) {
        r = {
          name: dev.name,
          tailscaleIp: dev.tailscaleIp,
          user: dev.user,
          state: 'error',
          detail: '探测异常: ' + String(e.message || e),
          checkedAt: new Date().toISOString(),
        };
      }
      out.push(r);
      onResult(r);
    }
  }

  const n = Math.max(1, Math.min(concurrency, devices.length || 1));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

/**
 * 状态的严重程度，用于排序和汇总。
 * 小的排前面：就绪的设备应该一眼看到。
 */
const STATE_RANK = {
  ready: 0,
  'no-credential': 1,
  'no-dsh': 2,
  unreachable: 3,
  unprobed: 4,
  offline: 5,
  error: 6,
  unknown: 7,
};

export function sortByState(results) {
  return [...results].sort((a, b) => {
    const d = (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9);
    return d !== 0 ? d : String(a.name).localeCompare(String(b.name));
  });
}

export function summarizeStates(results) {
  // 初始值必须把**所有可能出现**的状态都列出来。
  // 之前漏了 offline / unprobed / ready 之外的那几个，界面上就出现了
  // "离线 undefined" —— 访问不存在的键得到 undefined，不是 0。
  const s = {
    ready: 0,
    unprobed: 0,
    'no-dsh': 0,
    unreachable: 0,
    'no-credential': 0,
    offline: 0,
    error: 0,
    unknown: 0,
  };
  for (const r of results) {
    const k = r && r.state ? r.state : 'unknown';
    s[k] = (s[k] || 0) + 1;
  }
  return s;
}

export function stateLabel(state) {
  return (
    {
      ready: '可派活',
      unprobed: '未探测',
      'no-dsh': 'DSH 未启动',
      unreachable: '连不上',
      'no-credential': '凭据缺失',
      offline: '离线',
      error: '探测出错',
      unknown: '未探测',
    }[state] || state
  );
}
