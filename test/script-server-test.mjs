// dsh-fleet —— 临时脚本分发通道的测试
//
// 这组测试锁住了一个真实缺陷的修复：
//
//   原本脚本只从 tailnet 地址下发。一台还没进 tailnet 的机器（全新电脑、
//   VM 里的测试机）访问不到那个地址，而"装 Tailscale"正是脚本自己的第 3 步。
//   结果是用户拿到一条永远连不上的命令，且完全看不出原因。
//
// 下面每一条都对应一个具体的失败方式，而不是为了凑覆盖率。

import assert from 'node:assert';
import http from 'node:http';
import { startScriptServer, listLanAddresses } from '../lib/script-server.mjs';

let pass = 0;
let fail = 0;

function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log('  \u2713 ' + name + (extra ? '  (' + extra + ')' : ''));
  } else {
    fail++;
    console.log('  \u2717 ' + name + (extra ? '  (' + extra + ')' : ''));
  }
}

/** 起一个服务并等它真的在监听。 */
function serve(opts) {
  return new Promise((resolve, reject) => {
    const srv = startScriptServer(opts);
    srv.server.once('listening', () => resolve(srv));
    srv.server.once('error', reject);
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy(new Error('timeout'));
    });
  });
}

async function main() {
  /* ---- 1. 基本下发 ---- */

  console.log('\n=== 1. 能把脚本送到 ===');

  {
    const stores = new Map([['abc', '# hello script']]);
    const srv = await serve({
      host: '127.0.0.1',
      port: 0,
      takeScript: (id) => stores.get(id) || null,
      onLog: () => {},
    });
    const port = srv.server.address().port;

    const r = await get('http://127.0.0.1:' + port + '/setup.ps1?id=abc');
    ok('有效 id 返回 200', r.status === 200, 'status=' + r.status);
    ok('脚本内容正确', r.body === '# hello script', JSON.stringify(r.body.slice(0, 20)));
    ok('content-type 是纯文本', /text\/plain/.test(r.headers['content-type'] || ''), r.headers['content-type']);
    ok('声明 us-ascii（PowerShell 5.1 才不会按 GBK 解）', /us-ascii/.test(r.headers['content-type'] || ''), r.headers['content-type']);
    ok('content-length 与实际一致', Number(r.headers['content-length']) === Buffer.byteLength('# hello script'), r.headers['content-length']);

    await srv.close();
  }

  /* ---- 2. 有效期内可重复取，过期就死 ---- */

  console.log('\n=== 2. 有效期内可以反复取（因为用户可能重跑） ===');

  {
    // 这条测试记录了一个设计上的教训。
    //
    // 最初实现是"送到一次就关"。实测太脆：脚本执行失败想重跑、irm 内部
    // 重试、用户复制了两次 —— 都会撞上已关的端口，症状是"连不上"，
    // 完全看不出是因为已经成功过一次。
    const srv = await serve({
      host: '127.0.0.1',
      port: 0,
      takeScript: (id) => (id === 'repeat' ? '# repeat me' : null),
      onLog: () => {},
    });
    const port = srv.server.address().port;

    const a = await get('http://127.0.0.1:' + port + '/setup.ps1?id=repeat');
    ok('第一次取到', a.status === 200, 'status=' + a.status);

    const b = await get('http://127.0.0.1:' + port + '/setup.ps1?id=repeat');
    ok('第二次也能取到（允许重跑）', b.status === 200, 'status=' + b.status);
    ok('内容一致', a.body === b.body, 'len=' + b.body.length);

    const c = await get('http://127.0.0.1:' + port + '/setup.ps1?id=wrong');
    ok('无效 id 仍然是 404', c.status === 404, 'status=' + c.status);

    await srv.close();
  }

  /* ---- 2b. 响应必须完整，不能被中途掐断 ---- */

  console.log('\n=== 2b. 响应要完整送达（不能 ECONNRESET） ===');

  {
    // 曾经在 res.end() 之后同步 close()，客户端偶尔收到 ECONNRESET，
    // 或者拿到半截脚本。脚本被截断后用 PowerShell 执行，报的是语法错误，
    // 极难联想到"下载不完整"。
    const big = '# ' + 'x'.repeat(200000) + '\n$done = 1\n';
    const srv = await serve({
      host: '127.0.0.1',
      port: 0,
      takeScript: () => big,
      onLog: () => {},
    });
    const port = srv.server.address().port;

    let complete = null;
    try {
      const r = await get('http://127.0.0.1:' + port + '/setup.ps1?id=big');
      complete = r;
    } catch (e) {
      complete = { status: -1, body: '', err: e.message };
    }

    ok('大脚本也能完整取到', complete.status === 200, 'status=' + complete.status);
    ok('内容没有被截断', complete.body === big, '收到 ' + complete.body.length + ' / 期望 ' + big.length);
    ok('结尾标记在', complete.body.endsWith('$done = 1\n'), JSON.stringify(complete.body.slice(-20)));

    await srv.close();
  }

  /* ---- 3. 非法请求一律 404 ---- */

  console.log('\n=== 3. 多认一个路径都是多余的暴露 ===');

  {
    const srv = await serve({
      host: '127.0.0.1',
      port: 0,
      takeScript: () => '# x',
      onLog: () => {},
    });
    const port = srv.server.address().port;
    const base = 'http://127.0.0.1:' + port;

    const cases = [
      ['POST /setup.ps1 被拒', 'POST', base + '/setup.ps1?id=a'],
      ['/beacon 被拒（报名绝不能走这条通道）', 'GET', base + '/beacon'],
      ['/ 被拒', 'GET', base + '/'],
      ['/setup.ps1 无 id 被拒', 'GET', base + '/setup.ps1'],
      ['超长 id 被拒', 'GET', base + '/setup.ps1?id=' + 'a'.repeat(100)],
    ];

    for (const [label, method, url] of cases) {
      const r = await new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = http.request(
          { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method },
          (res) => {
            const ch = [];
            res.on('data', (c) => ch.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(ch).toString() }));
          },
        );
        req.on('error', reject);
        req.end();
      });
      ok(label, r.status === 404, 'status=' + r.status);
    }

    await srv.close();
  }

  /* ---- 4. 到期自动关 ---- */

  console.log('\n=== 4. 不留常驻端口 ===');

  {
    const logs = [];
    const srv = await serve({
      host: '127.0.0.1',
      port: 0,
      ttlMs: 150,
      takeScript: () => '# x',
      onLog: (l) => logs.push(l),
    });
    const port = srv.server.address().port;

    const before = await get('http://127.0.0.1:' + port + '/setup.ps1?id=a');
    ok('到期前能用', before.status === 200, 'status=' + before.status);

    await new Promise((r) => setTimeout(r, 400));

    let after = null;
    try {
      after = await get('http://127.0.0.1:' + port + '/setup.ps1?id=a');
    } catch {
      after = { status: 0, body: '' };
    }
    ok('到期后连不上（端口已释放）', after.status === 0, 'status=' + after.status);
    ok('日志里说明了自动关闭', logs.some((l) => /到期/.test(l)), logs.join(' | ').slice(0, 80));

    await srv.close();
  }

  /* ---- 5. 关闭是幂等的 ---- */

  console.log('\n=== 5. 反复关闭不能报错 ===');

  {
    const srv = await serve({ host: '127.0.0.1', port: 0, takeScript: () => '# x', onLog: () => {} });
    let threw = null;
    try {
      await srv.close();
      await srv.close();
      await srv.close();
    } catch (e) {
      threw = e;
    }
    ok('连续 close() 不抛异常', threw === null, threw ? threw.message : '');
  }

  /* ---- 6. 局域网地址枚举 ---- */

  console.log('\n=== 6. 地址列表要让用户能选对 ===');

  {
    const fake = () => ({
      'Tailscale': [
        { address: '100.71.88.73', family: 'IPv4', internal: false },
        { address: 'fd7a:115c::1', family: 'IPv6', internal: false },
      ],
      'VMware Network Adapter VMnet8': [
        { address: '192.168.252.1', family: 'IPv4', internal: false },
      ],
      '以太网': [
        { address: '192.168.1.2', family: 'IPv4', internal: false },
      ],
      'Loopback Pseudo-Interface 1': [
        { address: '127.0.0.1', family: 'IPv4', internal: true },
      ],
      '以太网 3': [
        { address: '169.254.5.5', family: 'IPv4', internal: false },
      ],
    });

    const list = listLanAddresses(fake);
    const addrs = list.map((x) => x.address);

    ok('排除了 tailnet 地址（100.64/10）', !addrs.some((a) => a.startsWith('100.')), addrs.join(','));
    ok('排除了 IPv6', !addrs.some((a) => a.includes(':')), addrs.join(','));
    ok('排除了回环', !addrs.includes('127.0.0.1'), addrs.join(','));
    ok('排除了链路本地 169.254', !addrs.includes('169.254.5.5'), addrs.join(','));
    ok('VMware 网段排在最前（VM 测试最常见）', list[0] && list[0].kind === 'vmware', list[0] ? list[0].address + ' ' + list[0].kind : '空');
    ok('局域网地址也在列表里', addrs.includes('192.168.1.2'), addrs.join(','));
    ok('VMware 那条带了提示', Boolean(list[0] && list[0].hint), list[0] ? list[0].hint : '');

    const empty = listLanAddresses(() => ({}));
    ok('没有地址时返回空数组而不是报错', Array.isArray(empty) && empty.length === 0, JSON.stringify(empty));
  }

  /* ---- 7. 端到端：模拟 VM 的处境 ---- */

  console.log('\n=== 7. 端到端：一台还不在 tailnet 的机器 ===');

  {
    // 这是最关键的一条。修复前这台机器什么也拿不到。
    // 现在它能通过局域网地址取到脚本，然后自己装 Tailscale 进网。
    const realScript = '# Generated by super-subagent -- agent bootstrap\n$ErrorActionPreference = "Stop"\n';
    const srv = await serve({
      host: '127.0.0.1',
      port: 0,
      takeScript: (id) => (id === 'gen123' ? realScript : null),
      onLog: () => {},
    });
    const port = srv.server.address().port;

    const r = await get('http://127.0.0.1:' + port + '/setup.ps1?id=gen123');
    ok('全新机器能取到脚本', r.status === 200, 'status=' + r.status);
    ok('内容与生成的一致', r.body === realScript, 'len=' + r.body.length);

    await srv.close();
  }

  console.log('\n' + (fail === 0 ? '全部通过' : '有失败') + ': ' + pass + ' 通过, ' + fail + ' 失败\n');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('测试自身出错: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
