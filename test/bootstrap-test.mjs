// 验证自举链路：打包 → HTTP 分发 → 新机器解压 → 能独立跑起来
// 这是"新设备 C 一行命令装好"的核心保证。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { bootstrap } from '../lib/bootstrap.mjs';
import { ROOT } from '../lib/util.mjs';

let pass = 0, fail = 0;
const check = (l, c, e = '') => { c ? (pass++, console.log(`✓ ${l} ${e}`)) : (fail++, console.log(`✗ ${l} ${e}`)); };

const PORT = 8952;
const server = bootstrap({ port: PORT, ttlMinutes: 1 });
await new Promise((r) => setTimeout(r, 2500)); // 等打包完成并监听

const bundle = path.join(ROOT, '.bootstrap', 'dsh-fleet-bundle.tar.gz');
check('bundle 已生成', fs.existsSync(bundle));

const size = fs.existsSync(bundle) ? fs.statSync(bundle).size : 0;
check('bundle 大小合理（>20KB）', size > 20_000, `${(size / 1024).toFixed(1)} KB`);

// 用 token 从 /health 拿不到内容，得先知道 token。
// 这里直接验证 HTTP 层的行为：无 token 应 404，有 token 应 200。
// token 在 bootstrap 内部生成，测试里用 health 端点确认服务活着。
const healthOk = await new Promise((resolve) => {
  http.get(`http://127.0.0.1:${PORT}/health`, (res) => {
    res.resume();
    resolve(res.statusCode === 200);
  }).on('error', () => resolve(false));
});
check('健康端点可用', healthOk);

const noToken = await new Promise((resolve) => {
  http.get(`http://127.0.0.1:${PORT}/bootstrap/deadbeef`, (res) => {
    res.resume();
    resolve(res.statusCode);
  }).on('error', () => resolve(0));
});
check('错误 token 返回 404', noToken === 404, `实际 ${noToken}`);

// ---- 模拟新机器：解压到一个干净目录，验证能独立运行 ----
const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-newmachine-'));
const tar = 'C:\\Windows\\System32\\tar.exe';
const x = spawnSync(tar, ['-xzf', bundle, '-C', fake], { encoding: 'utf8', windowsHide: true });
check('解压成功', x.status === 0, x.stderr?.slice(0, 80) || '');

const extracted = path.join(fake, 'dsh-fleet');
check('解出 dsh-fleet 目录', fs.existsSync(extracted));
check('入口文件存在', fs.existsSync(path.join(extracted, 'fleet.mjs')));
check('安装脚本存在', fs.existsSync(path.join(extracted, 'install', 'install.ps1')));
check('MCP server 存在', fs.existsSync(path.join(extracted, 'mcp', 'server.mjs')));

// 不该带过去的东西
check('未包含 node_modules', !fs.existsSync(path.join(extracted, 'node_modules')));
check('未包含 test', !fs.existsSync(path.join(extracted, 'test')));
check('未包含 .bootstrap', !fs.existsSync(path.join(extracted, '.bootstrap')));

// ---- 关键：解压出来的副本能独立运行 ----
const home = path.join(fake, 'home');
const r = spawnSync(process.execPath, [path.join(extracted, 'fleet.mjs'), 'init', '--role', 'agent', '--name', 'device-c'], {
  env: { ...process.env, DSH_FLEET_HOME: home, windowsHide: true },
  encoding: 'utf8',
  timeout: 30_000,
});
check('新机器上 init 成功', r.status === 0, (r.stderr || '').slice(0, 100));
check('新机器生成配置', fs.existsSync(path.join(home, 'fleet.json')));

// 帮助输出正常，说明所有 import 都能解析
const h = spawnSync(process.execPath, [path.join(extracted, 'fleet.mjs'), 'help'], {
  env: { ...process.env, DSH_FLEET_HOME: home, windowsHide: true },
  encoding: 'utf8',
  timeout: 30_000,
});
check('新机器上 help 正常', h.status === 0 && /dsh-fleet/.test(h.stdout));

server.close();
fs.rmSync(fake, { recursive: true, force: true });
fs.rmSync(path.join(ROOT, '.bootstrap'), { recursive: true, force: true });

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
