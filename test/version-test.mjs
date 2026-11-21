// 验证协议版本协商（DSH 会请求 2026-07-28）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(path.dirname(HERE), 'mcp', 'server.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-ver-'));

let pass = 0, fail = 0;
const check = (l, c, e = '') => { c ? (pass++, console.log(`✓ ${l} ${e}`)) : (fail++, console.log(`✗ ${l} ${e}`)); };

async function negotiate(requested) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, DSH_FLEET_HOME: TMP, windowsHide: true },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('超时')), 10_000);
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const i = buf.indexOf('\n');
      if (i >= 0) {
        clearTimeout(timer);
        try { resolve(JSON.parse(buf.slice(0, i))); } catch (e) { reject(e); }
      }
    });
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: requested, capabilities: {}, clientInfo: { name: 't', version: '1' } },
    }) + '\n');
  });
  child.kill();
  return result.result?.protocolVersion;
}

// DSH 的 MCP SDK 优先 2026-07-28
check('协商 2026-07-28', (await negotiate('2026-07-28')) === '2026-07-28', String(await negotiate('2026-07-28')));
check('协商 2024-11-05', (await negotiate('2024-11-05')) === '2024-11-05');
check('未知版本回退到 2024-11-05', (await negotiate('1999-01-01')) === '2024-11-05');
check('缺省时回退到 2024-11-05', (await negotiate(undefined)) === '2024-11-05');

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
