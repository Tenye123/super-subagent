// 插件包完整性测试。
//
// 这些检查针对的是**已经真实发生过**的失败，不是假想的：
//
//   1. locale/zh.json 曾被写入成损坏的 JSON（中文引号在写入时被截断），
//      而 PowerShell 的 ConvertFrom-Json 报错信息是 GBK 乱码，很容易
//      被误判成"只是显示问题"而放过。所以必须用 JSON.parse 验证，
//      不能用肉眼看。
//   2. package.json 的 exports 指向的文件必须真实存在，否则 DSH 加载
//      插件时会在启动阶段失败，表现为"设置页里没有这一项"，毫无线索。
//   3. client.js 必须在语法上可解析（它跑在浏览器里，出错只会在
//      控制台，普通用户看不到）。

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

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

console.log('=== package.json ===');

let pkg = null;
try {
  pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  ok('package.json 可解析', true);
} catch (e) {
  ok('package.json 可解析', false, e.message);
}

if (pkg) {
  ok('name 正确', pkg.name === 'dsh-super-subagent', pkg.name);
  ok('type=module', pkg.type === 'module');
  ok('有 bin 入口', Boolean(pkg.bin && pkg.bin.fleet), JSON.stringify(pkg.bin));
  ok('保留 engines', Boolean(pkg.engines && pkg.engines.node), JSON.stringify(pkg.engines));
  ok('保留 scripts.test', Boolean(pkg.scripts && pkg.scripts.test));
  ok('保留 keywords', Array.isArray(pkg.keywords) && pkg.keywords.length > 0);
  ok('license 是 MIT', pkg.license === 'MIT', pkg.license);

  console.log('');
  console.log('=== exports 指向的文件必须存在 ===');
  for (const [key, val] of Object.entries(pkg.exports || {})) {
    if (String(val).includes('*')) {
      // 通配符：检查目录下有匹配文件
      const dir = join(ROOT, String(val).replace(/\/\*.*$/, ''));
      ok(`exports["${key}"] 目录存在`, existsSync(dir), dir);
      continue;
    }
    const f = join(ROOT, String(val).replace(/^\.\//, ''));
    ok(`exports["${key}"] -> ${val}`, existsSync(f), f);
  }

  console.log('');
  console.log('=== DSH 插件元数据 ===');
  ok('dsh.bundle.patch 有声明', Boolean(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch));
  const patchRel = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch;
  if (patchRel) {
    const patchFile = join(ROOT, patchRel.replace(/^\.\//, ''));
    ok('patch 文件存在', existsSync(patchFile), patchFile);
    if (existsSync(patchFile)) {
      const yml = readFileSync(patchFile, 'utf8');
      ok('patch 里引用了包名', yml.includes(pkg.name), yml.trim().slice(0, 120));
      ok('patch 里没有 TAB（YAML 不允许）', !yml.includes('\t'));
      ok('patch 声明了 insert', yml.includes('insert'));
    }
  }
  ok('dsh.client.platform=web', pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === 'web');
  ok(
    'dsh.client.inject 含 locale',
    pkg.dsh && pkg.dsh.client && JSON.stringify(pkg.dsh.client.inject).includes('locale'),
  );
}

console.log('');
console.log('=== locale JSON 必须真的可解析 ===');
for (const f of ['zh.json', 'en.json']) {
  const p = join(ROOT, 'locale', f);
  if (!existsSync(p)) {
    ok(f + ' 存在', false);
    continue;
  }
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    ok(f + ' 可解析', true);
    ok(f + ' 有 meta.title', Boolean(j.meta && j.meta.title), JSON.stringify(j.meta));
    ok(f + ' 有 meta.description', Boolean(j.meta && j.meta.description));
    // 中文文件必须真的含中文，否则说明写入时丢字符了
    if (f === 'zh.json') {
      ok('zh.json 含中文字符', /[\u4e00-\u9fa5]/.test(j.meta.title), j.meta.title);
    }
  } catch (e) {
    ok(f + ' 可解析', false, e.message);
  }
}

console.log('');
console.log('=== 前端与后端脚本语法 ===');
for (const rel of ['lib/index.js', 'lib/client.js', 'lib/beacon.mjs', 'lib/discover.mjs', 'lib/bootstrap-script.mjs']) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) {
    ok(rel + ' 存在', false);
    continue;
  }
  try {
    execFileSync(process.execPath, ['--check', p], { stdio: 'pipe', timeout: 30000 });
    ok(rel + ' 语法通过', true);
  } catch (e) {
    ok(rel + ' 语法通过', false, String(e.stderr || e.message).slice(0, 200));
  }
}

console.log('');
console.log('=== icon 是合法 SVG ===');
{
  const p = join(ROOT, 'icon.svg');
  if (existsSync(p)) {
    const s = readFileSync(p, 'utf8');
    ok('有 <svg 根元素', /<svg[\s>]/.test(s));
    ok('有 viewBox', /viewBox=/.test(s));
    ok('标签闭合', s.trim().endsWith('</svg>'));
  } else {
    ok('icon.svg 存在', false);
  }
}

console.log('');
console.log('=== 前后端端口必须一致 ===');
{
  // 这条检查来自一个真实 bug：前端生成的一行命令里写的是 6210，
  // 但脚本实际由 tailnet 监听面（47321）下发。控制端看起来一切正常，
  // 目标机器上却永远 irm 不下来。硬编码端口跨越两个文件，人眼靠不住。
  const idx = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8');
  const cli = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');

  const apiMatch = /API_PORT\s*=\s*(\d+)/.exec(idx);
  const beaconMatch = /BEACON_PORT\s*=\s*(\d+)/.exec(idx);
  ok('index.js 定义了 API_PORT', Boolean(apiMatch), String(apiMatch && apiMatch[1]));
  ok('index.js 定义了 BEACON_PORT', Boolean(beaconMatch), String(beaconMatch && beaconMatch[1]));

  const apiPort = apiMatch ? apiMatch[1] : '';
  const beaconPort = beaconMatch ? beaconMatch[1] : '';

  ok('API 端口与 BEACON 端口不同', apiPort !== beaconPort);

  // 前端调 API 用的必须是 API 端口
  ok('client.js 用 API 端口调本地 API', cli.includes('127.0.0.1:' + apiPort), apiPort);

  // 一行命令里的端口必须是 BEACON 端口（脚本由 tailnet 面下发）
  const oneLiner = /http:\/\/' \+ ctrlIp \+ ':(\d+)\/setup\.ps1/.exec(cli);
  ok('client.js 生成了一行命令', Boolean(oneLiner));
  ok(
    '一行命令用的是 tailnet 端口 ' + beaconPort,
    oneLiner ? oneLiner[1] === beaconPort : false,
    '实际 ' + (oneLiner ? oneLiner[1] : 'n/a'),
  );
  ok(
    '一行命令没用回环地址',
    !cli.includes("'http://127.0.0.1:" + apiPort + "/setup.ps1'"),
  );
}

console.log('');
console.log('总计: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
