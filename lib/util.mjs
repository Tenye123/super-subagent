// dsh-fleet —— 通用工具（零依赖）

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 本文件在 <项目根>/lib/ 下，所以 ROOT 要再上一层 ——
// 之前写成 dirname(本文件) 得到的是 lib 目录，
// 结果 bootstrap 打包时把 "lib" 当成整个项目，产出的包只有 0.01MB。
export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const IS_WIN = process.platform === 'win32';

/** 跨机共享的配置根目录 */
export function fleetHome() {
  // 优先级：
  //   1. DSH_FLEET_HOME —— 显式覆盖（测试、多套配置）
  //   2. FLEET_HOME    —— 给 MCP 场景用：DSH 会 scrub 掉所有 DSH_* 环境变量
  //                       （见 dsh-mcp-client README 的 environment scrubbing），
  //                       所以 MCP 配置里必须用非 DSH_ 前缀的名字传进来
  //   3. ~/.dsh-fleet  —— 默认值
  return (
    process.env.DSH_FLEET_HOME ||
    process.env.FLEET_HOME ||
    path.join(os.homedir(), '.dsh-fleet')
  );
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export function readJson(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(p, data) {
  ensureDir(path.dirname(p));
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, p);
  return p;
}

/* ---------------- 日志 ---------------- */

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function colorEnabled() {
  if (process.env.NO_COLOR) return false;
  return process.stdout.isTTY === true;
}

function paint(code, s) {
  return colorEnabled() ? `${code}${s}${C.reset}` : s;
}

export const log = {
  info: (m) => console.log(m),
  step: (m) => console.log(`\n${paint(C.cyan, '▸')} ${paint(C.cyan, m)}`),
  ok: (m) => console.log(`${paint(C.green, '✓')} ${m}`),
  warn: (m) => console.log(`${paint(C.yellow, '!')} ${m}`),
  err: (m) => console.error(`${paint(C.red, '✗')} ${m}`),
  dim: (m) => console.log(paint(C.dim, m)),
  raw: (m) => console.log(m),
};

/** 结构化成功输出（供 MCP / 脚本消费） */
export function printResult(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

/* ---------------- 进程执行 ---------------- */

/**
 * 同步执行命令，返回 { code, stdout, stderr }。
 * 不抛异常 —— 调用方自己判断 code。
 *
 * Windows 上的 .cmd/.bat 交给 cmd.exe 会有命令注入风险
 * （实测 `&` 会被解释），所以优先把它"拆开"：
 * npm 生成的 .cmd 实质是 `node "<...>/bin.js" %*`，
 * 我们解析出 JS 入口后直接用 node 调用，完全绕开 cmd。
 */
export function run(cmd, args = [], opts = {}) {
  const shim = IS_WIN ? unwrapNpmShim(cmd) : null;
  const file = shim ? shim.node : cmd;
  const argv = shim ? [shim.script, ...args] : args;

  const r = spawnSync(file, argv, {
    encoding: 'utf8',
    timeout: opts.timeout ?? 120_000,
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    windowsHide: true,
    input: opts.input,
  });
  return {
    code: r.status ?? (r.error ? -1 : 0),
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
    error: r.error,
  };
}

/**
 * 解析 npm 生成的 .cmd 包装器，取出 { node, script }。
 * 不是 npm 包装器则返回 null。
 */
function unwrapNpmShim(cmdPath) {
  const ext = path.extname(cmdPath).toLowerCase();
  if (ext !== '.cmd' && ext !== '.bat') return null;

  let text;
  try {
    text = fs.readFileSync(cmdPath, 'utf8');
  } catch {
    return null;
  }
  // 形如: "%_prog%"  "%dp0%\node_modules\@scope\pkg\lib\bin.js" %*
  const m = /"%dp0%\\([^"]+\.(?:js|mjs|cjs))"/i.exec(text);
  if (!m) return null;

  const rel = m[1].replace(/\\/g, path.sep);
  const script = path.join(path.dirname(cmdPath), rel);
  if (!fs.existsSync(script)) return null;

  // 头目录里带 node.exe 就用它，否则用当前 node
  const localNode = path.join(path.dirname(cmdPath), 'node.exe');
  const node = fs.existsSync(localNode) ? localNode : process.execPath;
  return { node, script };
}

/**
 * 已知的 Windows 工具安装目录。
 * 这些程序通常不写进 PATH，但确实装好了 ——
 * 例如 OpenSSH Server 的 MSI 会把 sshd.exe 放在
 * C:\Program Files\OpenSSH\ 而不改 PATH，
 * 只靠 where 找不到，会误判成"没装"。
 */
const WELL_KNOWN_DIRS = [
  'C:\\Program Files\\OpenSSH',
  'C:\\Program Files\\Tailscale',
  'C:\\Windows\\System32\\OpenSSH',
];

/**
 * 解析命令的真实路径（Windows 用 where，其它用 which）。
 * 返回绝对路径或 null。
 *
 * Windows 上 where 会同时返回无扩展名的 shell 脚本和 .cmd 包装器，
 * 前者 spawnSync 执行不了，所以按可执行性排序。
 */
export function which(cmd) {
  const r = IS_WIN ? run('where', [cmd], { timeout: 10_000 }) : run('which', [cmd], { timeout: 10_000 });
  const cands = r.code === 0
    ? r.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((p) => p && fs.existsSync(p))
    : [];

  // PATH 里没有时，再找已知安装目录（且只认 .exe，避免误捡脚本）
  if (!cands.length && IS_WIN) {
    const exe = cmd.toLowerCase().endsWith('.exe') ? cmd : `${cmd}.exe`;
    for (const dir of WELL_KNOWN_DIRS) {
      const p = path.join(dir, exe);
      if (fs.existsSync(p)) {
        cands.push(p);
        break;
      }
    }
  }

  if (!cands.length) return null;
  if (!IS_WIN) return cands[0];

  const rank = (p) => {
    const e = path.extname(p).toLowerCase();
    if (e === '.exe') return 0;
    if (e === '.cmd') return 1;
    if (e === '.bat') return 2;
    if (e === '.ps1') return 3;
    if (e === '') return 9; // 无扩展名的 sh 脚本，最次
    return 5;
  };
  return cands.sort((a, b) => rank(a) - rank(b))[0];
}

/**
 * 执行一个可能以 .cmd/.ps1 形式存在的命令。
 * 优先解析真实路径，再交给 run。
 */
export function runCmd(cmd, args = [], opts = {}) {
  const resolved = which(cmd);
  if (!resolved) {
    return { code: -1, stdout: '', stderr: `command not found: ${cmd}`, error: { code: 'ENOENT' } };
  }
  return run(resolved, args, opts);
}
