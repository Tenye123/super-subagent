// 崩溃回归测试。
//
// 这个文件锁住一次真实事故：
//
//   用户点"添加设备"，整个 DSH 弹出"应用无法启动或已意外停止"。
//   原因是 /bootstrap 里写了一行 `onLog: (l) => log('setup: ' + l)`，
//   而 `log` 定义在 apply(ctx) 内部 —— 模块级的 routes 访问不到它：
//
//     ReferenceError: log is not defined
//       at onLog (lib/index.js:533)
//       at Server.<anonymous> (lib/script-server.mjs:120)
//       at Server.emit (events:526)      <-- listen 回调
//
//   关键点：这行跑在 server.listen() 的异步回调里，不在任何 try/catch
//   范围内，所以异常直接冒到 DSH 主进程，把整个应用带崩。
//
// 这类问题的共同特征是"启动时看不出、点某个按钮才炸"，而且炸掉的是
// 宿主应用而不是自己。所以必须用测试守住，不能靠人记得。
//
// 下面验三件事：
//   1. 模块级代码能安全记日志（作用域真的通了）
//   2. 传给 startScriptServer 的回调抛异常，不会冒出去
//   3. 完整的 /bootstrap 流程走一遍，进程还活着

const TEST_API_PORT = 38210;
const TEST_BEACON_PORT = 38321;
const TEST_LAN_PORT = 38322;
process.env.DSH_FLEET_API_PORT = String(TEST_API_PORT);
process.env.DSH_FLEET_BEACON_PORT = String(TEST_BEACON_PORT);
process.env.DSH_FLEET_LAN_PORT = String(TEST_LAN_PORT);

let pass = 0;
let fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) {
    console.log('  ✓ ' + label);
    pass++;
  } else {
    console.log('  ✗ ' + label + (extra ? '  -> ' + extra : ''));
    fail++;
  }
};

// 收集未捕获异常。这是本测试的核心：任何一条都算失败。
const uncaught = [];
process.on('uncaughtException', (e) => {
  uncaught.push(e);
});
process.on('unhandledRejection', (e) => {
  uncaught.push(e);
});

const { startScriptServer } = await import('../lib/script-server.mjs');
const http = await import('node:http');

/* ---- 1. onLog 抛异常不能影响服务 ---- */

console.log('');
console.log('=== 1. 日志回调自己炸了，服务要活着 ===');

{
  // 模拟当时的情形：onLog 里访问了不存在的变量。
  const srv = startScriptServer({
    host: '127.0.0.1',
    port: 0,
    takeScript: () => '# script',
    onLog: () => {
      // 这正是当初那行代码等价的效果
      throw new ReferenceError('log is not defined');
    },
  });

  await new Promise((r) => {
    srv.server.once('listening', r);
    srv.server.once('error', r);
  });

  const addr = srv.server.address();
  ok('监听器还是起来了', Boolean(addr && addr.port), addr ? String(addr.port) : '没起来');

  if (addr && addr.port) {
    // 发一个请求，触发 onLog —— 它每次都会抛
    const r = await new Promise((resolve) => {
      const req = http.get('http://127.0.0.1:' + addr.port + '/setup.ps1?id=x', (res) => {
        const ch = [];
        res.on('data', (c) => ch.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(ch).toString() }));
      });
      req.on('error', () => resolve({ status: 0, body: '' }));
    });

    ok('onLog 抛异常后请求仍然成功', r.status === 200, 'status=' + r.status);
    ok('脚本内容完整', r.body === '# script', JSON.stringify(r.body));
  }

  ok('没有未捕获异常冒出去', uncaught.length === 0, uncaught.map((e) => String(e && e.message)).join(' | '));

  await srv.close();
}

/* ---- 2. 监听失败不能冒异常 ---- */

console.log('');
console.log('=== 2. 端口被占用时只报错，不崩进程 ===');

{
  // 先占住一个端口
  const blocker = http.createServer(() => {});
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const busyPort = blocker.address().port;

  const logs = [];
  const srv = startScriptServer({
    host: '127.0.0.1',
    port: busyPort, // 必然 EADDRINUSE
    takeScript: () => '# x',
    onLog: (l) => logs.push(l),
  });

  // 等一会儿让 error 事件发生
  await new Promise((r) => setTimeout(r, 300));

  ok('记录到了监听失败', logs.some((l) => /监听失败/.test(l)), logs.join(' | ').slice(0, 100));
  ok('没有未捕获异常', uncaught.length === 0, uncaught.map((e) => String(e && e.message)).join(' | '));

  await srv.close();
  await new Promise((r) => blocker.close(r));
}

/* ---- 3. 完整走一遍 /bootstrap（当初崩溃的路径）---- */

console.log('');
console.log('=== 3. 点"添加设备"的完整路径 ===');

{
  const { apply } = await import('../lib/index.js');

  const logs = [];
  const disposers = [];
  const ctx = {
    logger: {
      info: (m) => logs.push(m),
      warn: (m) => logs.push(m),
      error: (m) => logs.push(m),
    },
    effect: (fn) => {
      const d = fn();
      if (typeof d === 'function') disposers.push(d);
    },
  };

  let threw = null;
  try {
    apply(ctx);
  } catch (e) {
    threw = e;
  }
  ok('apply() 不抛异常', !threw, threw && threw.message);

  await new Promise((r) => setTimeout(r, 1200));

  const base = 'http://127.0.0.1:' + TEST_API_PORT;

  // 这一步就是当初炸掉的地方：生成局域网下发通道。
  let boot = null;
  try {
    const res = await fetch(base + '/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deliverTo: 'lan', agentName: '' }),
      signal: AbortSignal.timeout(15000),
    });
    boot = { status: res.status, json: await res.json() };
  } catch (e) {
    boot = { status: 0, json: {}, err: String(e.message) };
  }

  ok('POST /bootstrap 返回 200', boot.status === 200, 'status=' + boot.status + ' ' + JSON.stringify(boot.json).slice(0, 160));
  ok('返回了 genId', Boolean(boot.json.genId), String(boot.json.genId));
  ok('返回了 downloadUrl', Boolean(boot.json.downloadUrl), String(boot.json.downloadUrl));
  ok('走的是局域网通道', boot.json.deliverVia === 'lan', String(boot.json.deliverVia));

  // 等一小会儿：当初的异常就发生在 listen 回调里，是异步的。
  await new Promise((r) => setTimeout(r, 800));

  ok('没有未捕获异常（进程还活着）', uncaught.length === 0, uncaught.map((e) => String(e && e.message)).join(' | '));

  // 真的去下载一次，确认通道能用
  if (boot.json.downloadUrl) {
    let dl = null;
    try {
      const res = await fetch(boot.json.downloadUrl, { signal: AbortSignal.timeout(8000) });
      dl = { status: res.status, body: await res.text() };
    } catch (e) {
      dl = { status: 0, body: '', err: String(e.message) };
    }
    ok('能从返回的地址下到脚本', dl.status === 200, 'status=' + dl.status + ' ' + (dl.err || ''));
    ok('下到的脚本非空', dl.body.length > 1000, 'len=' + dl.body.length);
    ok('脚本是纯 ASCII', !/[^\x00-\x7F]/.test(dl.body), '');
  }

  // 再点一次"添加设备"（用户可能反复点）
  let boot2 = null;
  try {
    const res = await fetch(base + '/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deliverTo: 'lan' }),
      signal: AbortSignal.timeout(15000),
    });
    boot2 = { status: res.status, json: await res.json() };
  } catch (e) {
    boot2 = { status: 0, json: {} };
  }
  ok('重复点添加设备也正常', boot2.status === 200 && Boolean(boot2.json.genId), 'status=' + boot2.status);
  ok('每次生成的 genId 不同', boot2.json.genId !== boot.json.genId, '');
  await new Promise((r) => setTimeout(r, 500));
  ok('重复操作后仍无未捕获异常', uncaught.length === 0, uncaught.map((e) => String(e && e.message)).join(' | '));

  // 清理
  if (disposers.length) {
    try {
      await disposers[0]();
    } catch {
      // 清理失败不影响判定
    }
  }
}

console.log('');
console.log('未捕获异常总数: ' + uncaught.length);
for (const e of uncaught) {
  console.log('  ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n  ') : String(e)));
}

console.log('');
console.log('总计: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
