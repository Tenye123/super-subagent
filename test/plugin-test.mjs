// 插件本体的真实启动测试。
//
// 这里不用 mock 掉 HTTP，而是真的调 apply() 把服务起起来，再发真实请求。
// 理由：这个插件跑在 DSH 主进程里，一旦 apply() 抛异常或监听失败，
// 用户看到的是"整个 DSH 面板没了"。所以必须验证它真的能起来。
//
// 另外单独验证一件事：任何 handler 抛异常都不能让进程崩掉。
// 这条用 /run 打一个不存在的设备来触发真实的错误路径。
//
// 端口用环境变量挪开（见下方 assignTestPorts）。
//
// 为什么必须挪：插件平时就跑在本机 DSH 里，占着 6210 / 47321。测试若坚持
// 用同样的端口，必然 EADDRINUSE —— 那种失败说明不了代码有问题，只是
// 两个实例在抢同一个口。曾经因此出现 3 条假失败，很容易被当成真 bug 去查。

const TEST_API_PORT = 36210;
const TEST_BEACON_PORT = 37321;
const TEST_LAN_PORT = 37322;
process.env.DSH_FLEET_API_PORT = String(TEST_API_PORT);
process.env.DSH_FLEET_BEACON_PORT = String(TEST_BEACON_PORT);
process.env.DSH_FLEET_LAN_PORT = String(TEST_LAN_PORT);

// 必须在设完环境变量之后再导入：端口是模块加载时求值的。
const { apply } = await import('../lib/index.js');

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

// --- 伪造一个最小的 ctx，语义与 cordis 一致 ---
//
// cordis 的 ctx.effect(callback) 是**立即执行 callback**，并把 callback
// 的返回值当作 disposer（卸载时调用）。所以这里必须模拟这个行为：
// 直接把外层函数的返回值存起来。存外层函数本身是错的——那样调用
// 只会得到内层 disposer 而不执行它，测试就会误报"清理没生效"。
const logs = [];
const disposers = [];
const ctx = {
  logger: {
    info: (m) => logs.push('INFO ' + m),
    warn: (m) => logs.push('WARN ' + m),
    error: (m) => logs.push('ERROR ' + m),
  },
  effect: (fn) => {
    const disposer = fn();
    if (typeof disposer === 'function') disposers.push(disposer);
  },
};

console.log('=== apply() 启动 ===');

let threw = null;
try {
  apply(ctx);
} catch (e) {
  threw = e;
}
ok('apply() 不抛异常', !threw, threw && threw.message);
ok('注册了清理钩子', disposers.length === 1);

// 等监听器起来
await new Promise((r) => setTimeout(r, 1200));

ok('记录了启动日志', logs.some((l) => l.includes('本地 API 已启动')), logs.join(' | '));

const BASE = 'http://127.0.0.1:' + TEST_API_PORT;

/** 发一个请求，返回 {status, json}。失败时把原因带出来。 */
async function call(method, path, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers['content-type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, opt);
  let json = null;
  const text = await res.text();
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

console.log('');
console.log('=== GET /status ===');
{
  const r = await call('GET', '/status');
  ok('返回 200', r.status === 200, 'status=' + r.status);
  ok('ok=true', r.json.ok === true);
  ok('role=controller', r.json.role === 'controller');
  ok('报出自己的 tailscale 地址', Boolean(r.json.self && r.json.self.tailscaleIp), JSON.stringify(r.json.self));
  ok('报名端口是 37321（测试用端口）', r.json.beacon && r.json.beacon.port === TEST_BEACON_PORT, String(r.json.beacon && r.json.beacon.port));
  ok('令牌只显示前缀', String(r.json.beacon.tokenPrefix).endsWith('...'));
  console.log('    self=' + JSON.stringify(r.json.self));
}

console.log('');
console.log('=== GET /devices ===');
{
  const r = await call('GET', '/devices');
  ok('返回 200', r.status === 200);
  ok('devices 是数组', Array.isArray(r.json.devices));
  console.log('    已登记 ' + r.json.devices.length + ' 台: ' + r.json.devices.map((d) => d.name).join(', '));
}

console.log('');
console.log('=== GET /scan（真扫 tailnet）===');
{
  const r = await call('GET', '/scan');
  ok('返回 200', r.status === 200, 'status=' + r.status);
  ok('devices 是数组', Array.isArray(r.json.devices), JSON.stringify(r.json).slice(0, 200));
  if (Array.isArray(r.json.devices)) {
    for (const d of r.json.devices) {
      console.log(
        '    ' + String(d.name).padEnd(14) + String(d.tailscaleIp).padEnd(17) +
        'state=' + String(d.state).padEnd(12) + 'enrolled=' + d.enrolled,
      );
    }
  }
}

console.log('');
console.log('=== POST /bootstrap ===');
{
  const r = await call('POST', '/bootstrap', { agentName: 'test-agent' });
  ok('返回 200', r.status === 200, 'status=' + r.status + ' ' + JSON.stringify(r.json).slice(0, 200));
  if (r.status === 200) {
    ok('拿到脚本', typeof r.json.script === 'string' && r.json.script.length > 3000);
    ok('脚本是纯 ASCII', !/[^\x00-\x7F]/.test(r.json.script));
    // 脚本里的 URL 是运行时拼出来的："http://" + $ControllerIp + ":" + ...
    // 所以不能拿完整字面量去匹配，要分别核对三段都写对了。
    ok(
      '脚本里有拼装报名 URL 的三段',
      r.json.script.includes('"http://" + $ControllerIp') &&
        r.json.script.includes('":" + $BeaconPort') &&
        r.json.script.includes('"/beacon"'),
    );
    ok('脚本把控制端地址写死了', r.json.script.includes("$ControllerIp   = '" + r.json.controllerIp + "'"));
    console.log('    脚本 ' + r.json.script.length + ' 字符');
  }
}

console.log('');
console.log('=== POST /run 错误路径（必须不崩）===');
{
  const r = await call('POST', '/run', { device: '不存在的设备', task: 'test' });
  ok('缺参数时返回 200 并带 taskId（任务在后台失败）', r.status === 200);

  // 后台任务会失败，轮询看它有没有正确记录失败原因
  await new Promise((res) => setTimeout(res, 1500));
  const t = await call('GET', '/tasks?id=' + r.json.taskId);
  ok('任务被记录', t.status === 200);
  ok('任务状态是 failed', t.json.task && t.json.task.state === 'failed', JSON.stringify(t.json.task && t.json.task.state));
  ok('错误信息说明没找到设备', String(t.json.task && t.json.task.error).includes('没有这台设备'), String(t.json.task && t.json.task.error));
}

console.log('');
console.log('=== 未知路由 ===');
{
  const r = await call('GET', '/nope');
  ok('返回 404', r.status === 404);
}

console.log('');
console.log('=== 服务仍然活着（前面出过错也不该崩）===');
{
  const r = await call('GET', '/status');
  ok('仍然响应 200', r.status === 200);
}

console.log('');
console.log('=== 执行清理钩子 ===');
{
  ok('有可调用的 disposer', typeof disposers[0] === 'function');
  await disposers[0]();
  // 用 connection:close 探测：默认的 keep-alive 会复用连接池里的旧连接，
  // 即使端口已经关了也可能拿到缓存结果，那样测不出真实状态。
  const probe = async () => {
    try {
      const res = await fetch(BASE + '/status', { headers: { connection: 'close' } });
      return 'HTTP ' + res.status;
    } catch (e) {
      return 'REFUSED';
    }
  };
  let after = await probe();
  if (after !== 'REFUSED') {
    await new Promise((r) => setTimeout(r, 800));
    after = await probe();
  }
  ok('清理后端口已关闭', after === 'REFUSED', after);
}

console.log('');
console.log('日志摘要:');
for (const l of logs) console.log('  ' + l);

console.log('');
console.log('总计: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
