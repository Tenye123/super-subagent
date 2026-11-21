// dsh-fleet —— 自举：让新机器用一行命令把自己装好
//
// 为什么需要这个：
//   如果新机器（比如以后加的设备 C）要先手动 git clone / 拷目录，
//   "安装器一手包办"就不成立了。这里让主控起一个临时的只读 HTTP 服务，
//   新机器一行命令拉取整个包并运行安装器。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { log, IS_WIN, run, ROOT } from './util.mjs';
import { tailscaleInfo } from './probe.mjs';

/**
 * 打包成一个 tar.gz（Windows 10+ 自带 bsdtar）。
 *
 * 参数顺序有讲究：bsdtar 把 `--exclude` 放在 `-czf` 之前会被当成文件名，
 * 报 "Failed to open '--exclude=*.log'"。正确顺序是
 *   tar -czf <输出> <排除项...> <目录>
 */
function makeBundle(outFile) {
  const tar = IS_WIN ? 'C:\\Windows\\System32\\tar.exe' : 'tar';
  const parent = path.dirname(ROOT);
  const name = path.basename(ROOT);
  const args = [
    '-czf', outFile,
    '--exclude=node_modules',
    '--exclude=.git',
    '--exclude=.bootstrap',
    '--exclude=test',
    '--exclude=*.log',
    '-C', parent,
    name,
  ];
  const r = run(tar, args, { timeout: 120_000 });
  if (r.code !== 0) throw new Error(`打包失败：${r.stderr || r.code}`);
  return outFile;
}

/**
 * 启动自举服务。
 * 只读、只服务一个 tar.gz、token 保护、默认只听 Tailscale 网卡。
 */
export function bootstrap({ port = 8931, ttlMinutes = 30 } = {}) {
  const tmpDir = path.join(ROOT, '.bootstrap');
  fs.mkdirSync(tmpDir, { recursive: true });

  const bundle = path.join(tmpDir, 'dsh-fleet-bundle.tar.gz');
  log.step('打包');
  makeBundle(bundle);
  const size = fs.statSync(bundle).size;
  log.ok(`${(size / 1024 / 1024).toFixed(2)} MB`);

  // 一次性 token，防止同网段其他人拉取
  const token = crypto.randomBytes(16).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  // Bind to loopback AND the Tailscale address.
  //
  // Why both:
  //   - the Tailscale address is what a NEW machine connects to
  //   - loopback is needed for the health check / local use, and it is not a
  //     security compromise: loopback traffic never leaves the machine
  //
  // Earlier this bound ONLY to the Tailscale IP, which broke as soon as
  // Tailscale was actually installed: the server said "listening on
  // 100.x.x.x" while anything connecting to 127.0.0.1 got ECONNREFUSED.
  // Note we deliberately do NOT bind 0.0.0.0 -- that would expose the bundle
  // to the whole company LAN.
  //
  // A single http.Server can only listen() once, so we create one per address.
  const tsIp = tailscaleInfo().ips[0] || null;
  const binds = tsIp ? ['127.0.0.1', tsIp] : ['127.0.0.1'];

  const handler = (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }

    if (url.pathname !== `/bootstrap/${tokenHash}`) {
      res.writeHead(404);
      return res.end('not found');
    }

    if (req.method !== 'GET') {
      res.writeHead(405);
      return res.end('method not allowed');
    }

    const stat = fs.statSync(bundle);
    res.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Length': stat.size,
      'Content-Disposition': 'attachment; filename="dsh-fleet-bundle.tar.gz"',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(bundle).pipe(res);
  };

  const servers = [];
  let listening = 0;
  let announced = false;

  const announce = () => {
    if (announced) return;
    announced = true;

    const base = tsIp ? `http://${tsIp}:${port}` : `http://127.0.0.1:${port}`;
    const url = `${base}/bootstrap/${tokenHash}`;

    log.ok(`自举服务已启动：${base}`);
    log.info('');
    log.info('在新机器上执行（PowerShell，一行）：');
    log.info('');
    const ps = `$u='${url}'; $d="$env:TEMP\\dsh-fleet"; New-Item -ItemType Directory -Force $d|Out-Null; Invoke-WebRequest $u -OutFile "$d\\b.tar.gz"; tar -xzf "$d\\b.tar.gz" -C $d; & node "$d\\dsh-fleet\\fleet.mjs" install --role agent`;
    log.info(`  ${ps}`);
    log.info('');
    log.dim(`  token 有效期 ${ttlMinutes} 分钟，只读，监听 ${binds.join(' + ')}:${port}`);
    log.dim('  按 Ctrl+C 结束');

    const timer = setTimeout(() => {
      log.warn('自举服务到期，自动关闭');
      closeAll();
    }, ttlMinutes * 60_000);
    timer.unref?.();
  };

  function closeAll() {
    for (const s of servers) {
      try { s.close(); } catch { /* 忽略 */ }
    }
    cleanup();
  }

  for (const bind of binds) {
    const srv = http.createServer(handler);
    srv.on('error', (e) => {
      // 某个地址绑不上（例如 Tailscale 正好掉线）不应让整个自举失败
      log.warn(`监听 ${bind}:${port} 失败：${e.code || e.message}`);
      listening++;
      if (listening >= binds.length) announce();
    });
    srv.listen(port, bind, () => {
      listening++;
      if (listening >= binds.length) announce();
    });
    servers.push(srv);
  }

  const server = servers[0];
  server.servers = servers;
  server.closeAll = closeAll;

  function cleanup() {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }

  process.on('SIGINT', () => {
    closeAll();
    process.exit(0);
  });

  return server;
}

/** 给新机器生成一条可直接执行的引导命令（不启动服务，只打印） */
export function printBootstrapHint(port = 8931) {
  const bind = tailscaleInfo().ips[0];
  if (!bind) {
    log.warn('没有 Tailscale IP，新机器只能在同一网段访问');
  }
  log.info('在主控上先运行：fleet bootstrap');
  log.info('它会打印一条完整的一行命令，复制到新机器执行即可。');
}
