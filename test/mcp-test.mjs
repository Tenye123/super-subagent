// 验证 MCP server 的协议实现
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(path.dirname(HERE), 'mcp', 'server.mjs');
const FLEET = path.join(path.dirname(HERE), 'fleet.mjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-mcp-'));
let pass = 0, fail = 0;
const check = (l, c, e = '') => { c ? (pass++, console.log(`✓ ${l} ${e}`)) : (fail++, console.log(`✗ ${l} ${e}`)); };

// 先初始化一个 controller 配置
const { spawnSync } = await import('node:child_process');
spawnSync(process.execPath, [FLEET, 'init', '--role', 'controller', '--name', 'test-pc'], {
  env: { ...process.env, DSH_FLEET_HOME: TMP, windowsHide: true }, encoding: 'utf8',
});

const env = { ...process.env, DSH_FLEET_HOME: TMP };
const child = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

let buf = '';
const pending = new Map();

child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const r = pending.get(msg.id);
    if (r) { pending.delete(msg.id); r(msg); }
  }
});

child.stderr.on('data', () => {}); // 日志忽略

function call(id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`超时：${method}`)), 15_000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

let id = 0;

/* ---- 1. initialize ---- */
{
  const r = await call(++id, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
  check('initialize 返回 protocolVersion', r.result?.protocolVersion === '2024-11-05', r.result?.protocolVersion);
  check('声明 tools 能力', Boolean(r.result?.capabilities?.tools));
  check('serverInfo 名正确', r.result?.serverInfo?.name === 'dsh-fleet');
}

/* ---- 2. notifications/initialized 不应有回复 ---- */
{
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  await new Promise((r) => setTimeout(r, 300));
  check('通知消息无回复（连接仍存活）', !child.killed);
}

/* ---- 3. tools/list ---- */
{
  const r = await call(++id, 'tools/list', {});
  const tools = r.result?.tools || [];
  check('返回工具列表', tools.length === 4, `共 ${tools.length} 个`);
  const names = tools.map((t) => t.name);
  check('含 fleet_run_task', names.includes('fleet_run_task'));
  check('含 fleet_list_devices', names.includes('fleet_list_devices'));
  check('含 fleet_ping', names.includes('fleet_ping'));
  check('含 fleet_jobs', names.includes('fleet_jobs'));
  check('每个工具都有 inputSchema', tools.every((t) => t.inputSchema?.type === 'object'));
  check('run_task 必填 device 与 task',
    JSON.stringify(tools.find((t) => t.name === 'fleet_run_task').inputSchema.required) === '["device","task"]');
}

/* ---- 4. tools/call: list_devices（空设备） ---- */
{
  const r = await call(++id, 'tools/call', { name: 'fleet_list_devices', arguments: {} });
  check('list_devices 返回文本', r.result?.content?.[0]?.type === 'text');
  check('无设备时给出引导', /没有可用设备/.test(r.result?.content?.[0]?.text || ''),
    (r.result?.content?.[0]?.text || '').slice(0, 40));
}

/* ---- 5. tools/call: 未知设备应报错 ---- */
{
  const r = await call(++id, 'tools/call', { name: 'fleet_ping', arguments: { device: 'nope' } });
  check('未知设备返回 isError', r.result?.isError === true);
  check('错误信息可读', /没有这台设备/.test(r.result?.content?.[0]?.text || ''));
}

/* ---- 6. tools/call: jobs 空列表 ---- */
{
  const r = await call(++id, 'tools/call', { name: 'fleet_jobs', arguments: {} });
  check('jobs 返回文本', r.result?.content?.[0]?.type === 'text');
}

/* ---- 7. 未知方法 ---- */
{
  const r = await call(++id, 'no/such/method', {});
  check('未知方法返回 -32601', r.error?.code === -32601, String(r.error?.code));
}

/* ---- 8. 非法 JSON 不应崩溃 ---- */
{
  child.stdin.write('{ this is not json }\n');
  await new Promise((r) => setTimeout(r, 300));
  const r = await call(++id, 'tools/list', {});
  check('非法 JSON 后仍可用', Array.isArray(r.result?.tools));
}

child.kill();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
