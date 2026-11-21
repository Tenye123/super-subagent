// 验证 authorized_keys 去重逻辑（幂等性）
// 用一个临时的 HOME 模拟，避免碰真实 ~/.ssh

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FLEET = path.join(path.dirname(HERE), 'fleet.mjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-dedup-'));
let pass = 0, fail = 0;
const check = (l, c, e = '') => { c ? (pass++, console.log(`✓ ${l} ${e}`)) : (fail++, console.log(`✗ ${l} ${e}`)); };

function fleet(home, args) {
  const r = spawnSync(process.execPath, [FLEET, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DSH_FLEET_HOME: home, USERPROFILE: TMP, HOME: TMP, windowsHide: true },
    timeout: 60_000,
  });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

const PK1 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPFaWp1En8VpG+XUQbG4OyAUqbN/sexlImP0FD+9AI5C';
const PK2 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIESkgsPfwqyNi5dJpZj66/scbTQD3SG8ZSNgOZYGL75g';

const home = path.join(TMP, 'agent');
fs.mkdirSync(home, { recursive: true });
fleet(home, ['init', '--role', 'agent', '--name', 'a']);

// 注意：accept 会写 C:\ProgramData（需管理员）或 $HOME\.ssh。
// 这里把 HOME 指到临时目录，所以落在临时目录里，安全。
const keyFile = path.join(TMP, '.ssh', 'authorized_keys');

// 1. 写一次
fleet(home, ['accept', '--controller', 'pc1', '--pubkey', PK1, '--expires', '30d']);

// 2. 同一把钥匙换个 tag 再写（模拟重跑/改名）
fleet(home, ['accept', '--controller', 'pc1-renamed', '--pubkey', PK1, '--expires', '30d']);

// 3. 换一把钥匙
fleet(home, ['accept', '--controller', 'pc2', '--pubkey', PK2, '--expires', '30d']);

if (!fs.existsSync(keyFile)) {
  console.log('✗ authorized_keys 未生成，后续断言跳过');
  console.log(`  期望路径：${keyFile}`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
}

const content = fs.readFileSync(keyFile, 'utf8');
const lines = content.split(/\r?\n/).filter((l) => l.trim());

check('共 2 行（两把不同的钥匙）', lines.length === 2, `实际 ${lines.length} 行`);
check('第一把钥匙只出现一次', lines.filter((l) => l.includes('IPFaWp1En8VpG')).length === 1);
check('第二把钥匙只出现一次', lines.filter((l) => l.includes('IESkgsPfwqyNi5dJ')).length === 1);

// 4. 真正重跑同一条命令（完全幂等）
fleet(home, ['accept', '--controller', 'pc1-renamed', '--pubkey', PK1, '--expires', '30d']);
const lines2 = fs.readFileSync(keyFile, 'utf8').split(/\r?\n/).filter((l) => l.trim());
check('重复执行不增加行数', lines2.length === 2, `实际 ${lines2.length} 行`);

// 5. 校验授权行结构
const first = lines[0];
check('含 restrict', /^restrict,/.test(first), first.slice(0, 40) + '...');
check('含 expiry-time', /expiry-time="\d{12}"/.test(first));
check('含 from 限定', /from="[^"]+"/.test(first));

console.log('\n实际内容：');
console.log(content.trim());

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
