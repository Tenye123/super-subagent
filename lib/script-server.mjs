// dsh-fleet —— 临时的引导脚本分发通道
//
// 为什么需要它（这是一个真实的设计缺陷）
//   原本脚本只从 tailnet 地址下发（100.x:47321）。但一台**还没进 tailnet**
//   的机器访问不到那个地址 —— 而"装 Tailscale"恰恰是脚本自己的第 3 步。
//   于是：
//
//     要从 tailnet 下载脚本 → 必须先进 tailnet
//     要进 tailnet          → 必须装了 Tailscale
//     装 Tailscale          → 在脚本第 3 步里
//
//   死结。任何全新机器（朋友的电脑、新买的服务器、VM 里的测试机）都会卡在
//   这里，而这不是环境问题，是产品缺陷。
//
// 做法
//   在用户明确要求时，额外开一个**只服务脚本下载**的监听器，绑在局域网地址
//   上，让还没进 tailnet 的机器也能取到脚本。它和报名监听器完全分开：
//
//   - 只认一个路径 GET /setup.ps1?id=<genId>
//   - 不服务 /beacon，报名永远只能从 tailnet 来
//   - genId 不可猜测（9 字节随机），过期即失效
//   - 到期自动关闭，不留常驻端口
//
// 为什么不做成常驻
//   常驻就等于"控制端的 47322 永远对公司内网开放"。哪怕有 genId 保护，
//   也没有理由让一个只需要用一次的东西一直开着。用户点一次"添加设备"、
//   复制一条命令，用完了通道就该消失。
//
// 为什么"下载成功就立即关"这个想法被否掉了
//   一开始的设计是"送到即关"。实测发现太脆：脚本执行失败想重跑、
//   PowerShell 的 irm 内部重试、用户先复制了一次但没及时执行 —— 任何一种
//   都会撞上已经关掉的端口，而症状是"连不上"，看不出是因为成功过一次。
//   所以改成**在有效期内可以反复取**，到期或用户重新生成时关闭。
//   代价是窗口期内拿到 genId 的人能反复下载，这个代价可以接受（见下）。
//
// 暴露面说明（诚实写在这里）
//   在通道存在的这段时间里，同网段的人可以访问 /setup.ps1。没有 genId 会
//   404，但**不能**说成"绝对安全"：拿到链接的任何人都能下到脚本，而脚本里
//   含报名令牌（能让一台机器伪装成新设备登记进来）。
//
//   所以：只在这个时刻开 —— 用户明确选了"目标机器还不在 tailnet"；
//   只在 30 分钟内有效；关了就没有了。这是有意接受的取舍，不是疏忽。

import http from 'node:http';

const MAX_ID_LEN = 64;

/**
 * 启动脚本分发通道。
 *
 * @param {object} opts
 * @param {string} opts.host        监听地址（局域网 IPv4）
 * @param {number} opts.port        端口
 * @param {number} [opts.ttlMs]     存活时间，到期自动关闭
 * @param {(id:string)=>(string|null)} opts.takeScript
 *        取出并**作废**该 id 对应的脚本。返回 null 表示不存在/已过期。
 * @param {(line:string)=>void} [opts.onLog]
 * @returns {{ server: import('node:http').Server, url:string, close:()=>Promise<void> }}
 */
export function startScriptServer({ host, port, ttlMs = 30 * 60 * 1000, takeScript, onLog = () => {} }) {
  let closed = false;
  let timer = null;

  const server = http.createServer((req, res) => {
    const reply = (code, text, type = 'text/plain; charset=utf-8') => {
      res.writeHead(code, { 'content-type': type, 'content-length': Buffer.byteLength(text) });
      res.end(text);
    };

    let url;
    try {
      url = new URL(req.url || '/', 'http://x');
    } catch {
      reply(400, 'bad request');
      return;
    }

    // 任何不是"下载脚本"的请求一律 404。
    // 这条通道的存在意义只有一个，多认一个路径都是多余的暴露。
    if (req.method !== 'GET' || url.pathname !== '/setup.ps1') {
      onLog(`拒绝 ${req.method} ${url.pathname}（来自 ${req.socket.remoteAddress}）`);
      reply(404, 'not found');
      return;
    }

    const id = url.searchParams.get('id') || '';
    if (!id || id.length > MAX_ID_LEN) {
      onLog('拒绝：缺少或非法的 id');
      reply(404, 'not found');
      return;
    }

    const script = takeScript(id);
    if (!script) {
      onLog(`拒绝：id ${id} 不存在或已过期`);
      reply(404, 'script not found or expired');
      return;
    }

    // PowerShell 的 irm 对 text/plain 处理最干净。
    res.writeHead(200, {
      'content-type': 'text/plain; charset=us-ascii',
      'content-length': Buffer.byteLength(script),
    });
    res.end(script);
    onLog(`已下发脚本 ${script.length} 字节给 ${req.socket.remoteAddress}`);

    // 这里**不关**。有效期内允许重复取：
    //   脚本执行失败想重跑、irm 内部重试、用户复制两次 —— 都会再来一次。
    //   送到即关会让这些情况表现为"连不上"，而原因完全看不出来。
    // 通道由 TTL 或"重新生成"关闭。
  });

  server.on('error', (e) => {
    onLog('监听失败：' + e.message);
  });

  // 只绑指定的那一个地址，**不要**改成 0.0.0.0。
  server.listen(port, host, () => {
    onLog(`脚本分发通道已启动 http://${host}:${port}/setup.ps1（${Math.round(ttlMs / 60000)} 分钟后自动关闭）`);
  });

  timer = setTimeout(() => {
    onLog('脚本分发通道到期，自动关闭');
    void close();
  }, ttlMs);
  if (typeof timer.unref === 'function') timer.unref();

  async function close() {
    if (closed) return;
    closed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    await new Promise((resolve) => {
      try {
        server.close(() => resolve());
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      } catch {
        resolve();
      }
    });
  }

  return { server, url: `http://${host}:${port}/setup.ps1`, close };
}

/**
 * 列出可用于局域网上报的地址。
 *
 * 为什么让用户选而不是自动挑：控制端可能同时连着一个 NAT 网卡、一个以太网、
 * 一个虚拟网卡，只有用户清楚目标机器在哪一边。猜错了就是"命令跑不通"，
 * 而这种失败没有任何提示，最难排查。
 *
 * @returns {Array<{address:string, iface:string, kind:string, hint:string}>}
 */
export function listLanAddresses(networkInterfaces) {
  const out = [];
  const ifaces = networkInterfaces ? networkInterfaces() : {};

  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      // 只要 IPv4、只要非回环、只要不是 Tailscale 自己的地址
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      if (a.address.startsWith('127.')) continue;
      if (a.address.startsWith('169.254.')) continue;

      const isTailnet = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address);
      if (isTailnet) continue;

      let kind = 'lan';
      let hint = '';
      if (/^192\.168\./.test(a.address) || /^10\./.test(a.address) || /^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) {
        kind = 'private';
      }
      if (/VMnet|VMware/i.test(name)) {
        kind = 'vmware';
        hint = '虚拟机 NAT 网段，VM 里的机器走这个';
      } else if (/^192\.168\.137\./.test(a.address)) {
        hint = 'Windows 移动热点网段';
      }

      out.push({ address: a.address, iface: name, kind, hint });
    }
  }

  // 排序：VMware 网段优先（VM 测试最常见），然后普通私网地址。
  out.sort((x, y) => {
    const rank = (z) => (z.kind === 'vmware' ? 0 : z.kind === 'private' ? 1 : 2);
    return rank(x) - rank(y) || x.address.localeCompare(y.address);
  });

  return out;
}
