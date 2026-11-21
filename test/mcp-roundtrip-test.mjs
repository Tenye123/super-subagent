// 真实 MCP 客户端往返测试：通过 stdio 与 mcp/server.mjs 通信，
// 完全按 MCP 协议走一遍 initialize → tools/list → tools/call。
//
// 这不是"读源码看它写了什么"，而是真的把 JSON-RPC 发过去、把结果收回来。
// 只有这样才能证明 B 的模型能像调用本地工具一样调用 A。

import { spawn } from 'node:child_process';
import path from 'node:path';

let pass = 0, fail = 0;
const check = (l, c, e = '') => { c ? (pass++, console.log(`✓ ${l} ${e}`)) : (fail++, console.log(`✗ ${l} ${e}`)); };

const serverPath = path.join('mcp', 'server.mjs');
const child = spawn(process.execPath, [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (d) => { stdout += d.toString(); });
child.stderr.on('data', (d) => { stderr += d.toString(); });

// 按行切分 NDJSON，返回一个可以从队列里等下一条响应的工具
const pending = new Map();
let buffer = '';
child.stdout.on('data', () => {
  let idx;
  while ((idx = stdout.indexOf('\n')) >= 0) {
    const line = stdout.slice(0, idx).trim();
    stdout = stdout.slice(idx + 1);
    if (!line.startsWith('{')) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let nextId = 1;
function request(method, params, timeoutMs = 120_000) {
  const id = nextId++;
  const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(payload + '\n');
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

try {
  /* ---------- 1. initialize ---------- */
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'fleet-roundtrip-test', version: '1.0.0' },
  });
  check('initialize 返回 result', !!init.result, init.error ? JSON.stringify(init.error) : '');
  check('serverInfo 名称正确', init.result?.serverInfo?.name === 'dsh-fleet',
    `(${init.result?.serverInfo?.name})`);
  check('声明了 tools 能力', !!init.result?.capabilities?.tools);

  notify('notifications/initialized', {});

  /* ---------- 2. tools/list ---------- */
  const list = await request('tools/list', {});
  const tools = list.result?.tools || [];
  const names = tools.map((t) => t.name);
  check('tools/list 返回 4 个工具', tools.length === 4, `(实际 ${tools.length}: ${names.join(', ')})`);
  for (const want of ['fleet_list_devices', 'fleet_ping', 'fleet_run_task', 'fleet_jobs']) {
    check(`存在工具 ${want}`, names.includes(want));
  }
  // 每个工具必须有 inputSchema，否则模型无法正确调用
  check('每个工具都有 inputSchema', tools.every((t) => t.inputSchema && t.inputSchema.type === 'object'));

  /* ---------- 3. fleet_list_devices（真实读配置） ---------- */
  const devs = await request('tools/call', { name: 'fleet_list_devices', arguments: {} });
  const devText = devs.result?.content?.[0]?.text || '';
  check('fleet_list_devices 调用成功', !devs.result?.isError, devText.slice(0, 160));
  check('返回内容包含 laptop-a', devText.includes('laptop-a'), devText.slice(0, 200));

  /* ---------- 4. fleet_ping（真实 SSH 到 A） ---------- */
  const ping = await request('tools/call', {
    name: 'fleet_ping',
    arguments: { device: 'laptop-a' },
  }, 180_000);
  const pingText = ping.result?.content?.[0]?.text || '';
  check('fleet_ping 调用成功（真实 SSH 到 A）', !ping.result?.isError, pingText.slice(0, 200));
  // 必须出现真实的往返延迟数字，而不是错误信息
  check('fleet_ping 返回了延迟数据', /\d+\s*ms/i.test(pingText), pingText.slice(0, 200));

  /* ---------- 4b. fleet_ping 用 name 别名也必须能用 ---------- */
  // CLI 里是 `fleet ping --name laptop-a`，模型很自然会写 {"name": "..."}。
  // 之前这种写法会得到 "没有这台设备：undefined"，纯粹是命名造成的假故障。
  const pingAlias = await request('tools/call', {
    name: 'fleet_ping',
    arguments: { name: 'laptop-a' },
  }, 180_000);
  const aliasText = pingAlias.result?.content?.[0]?.text || '';
  check('fleet_ping 接受 name 别名', !pingAlias.result?.isError, aliasText.slice(0, 200));
  check('name 别名返回真实延迟', /\d+\s*ms/i.test(aliasText), aliasText.slice(0, 160));

  /* ---------- 4c. 完全缺参必须给出可读错误，而不是 undefined ---------- */
  const noArg = await request('tools/call', { name: 'fleet_ping', arguments: {} });
  const noArgText = noArg.result?.content?.[0]?.text || '';
  check('缺参时错误信息可读（不含 undefined）',
    (noArg.result?.isError || !!noArg.error) && !/undefined/.test(noArgText),
    noArgText.slice(0, 160));

  /* ---------- 5. fleet_run_task：通过 MCP 真实派活 ---------- */
  // 这是整条链路的终点：B 的模型调用 MCP 工具 -> A 上的 DSH 执行 -> 结果回到 B。
  const runTask = await request('tools/call', {
    name: 'fleet_run_task',
    arguments: {
      device: 'laptop-a',
      task: '用 pwsh 执行 hostname，把原始输出原样告诉我，不要额外解释。',
    },
  }, 600_000);
  const taskText = runTask.result?.content?.[0]?.text || '';
  check('fleet_run_task 调用成功（MCP 全链路派活）', !runTask.result?.isError, taskText.slice(0, 240));
  // A 的主机名是 Tenye，出现在结果里才说明真的在 A 上执行了
  check('任务结果来自 A（包含主机名 Tenye）', /Tenye/i.test(taskText), taskText.slice(0, 240));

  /* ---------- 6. fleet_jobs ---------- */
  const jobs = await request('tools/call', { name: 'fleet_jobs', arguments: { limit: 5 } });
  const jobsText = jobs.result?.content?.[0]?.text || '';
  check('fleet_jobs 调用成功', !jobs.result?.isError, jobsText.slice(0, 160));

  /* ---------- 6. 未知工具必须报错，而不是静默成功 ---------- */
  const bad = await request('tools/call', { name: 'no_such_tool', arguments: {} });
  check('未知工具返回错误', !!bad.error || bad.result?.isError,
    JSON.stringify(bad.error || bad.result).slice(0, 160));
} catch (e) {
  check('MCP 往返整体完成', false, e.message);
} finally {
  child.kill();
}

// stderr 只应有启动横幅
check('stderr 没有异常堆栈', !/Error|at \w+ \(/.test(stderr), stderr.slice(0, 200));

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
