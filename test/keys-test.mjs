// 验证：PEM -> OpenSSH 公钥转换是否正确
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pemToSshPublic, parseDuration, toSshExpiry } from '../lib/config.mjs';
import { run } from '../lib/util.mjs';

let pass = 0;
let fail = 0;
function check(label, cond, extra = '') {
  if (cond) { pass++; console.log(`✓ ${label} ${extra}`); }
  else { fail++; console.log(`✗ ${label} ${extra}`); }
}

/* ---- PEM -> OpenSSH 格式 ---- */
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pem = publicKey.export({ type: 'spki', format: 'pem' });
const ssh = pemToSshPublic(pem);

check('以 ssh-ed25519 开头', ssh.startsWith('ssh-ed25519 '), ssh.slice(0, 40) + '...');

// 用 ssh-keygen 验证转换结果是否合法
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-test-'));
const f = path.join(tmp, 'k.pub');
fs.writeFileSync(f, ssh + ' test\n');
const r = run('ssh-keygen', ['-l', '-f', f]);
check('ssh-keygen 可解析', r.code === 0, r.stdout.slice(0, 60) || r.stderr.slice(0, 60));

// 用 ssh-keygen 生成一份，对比两者指纹格式一致
const kp = path.join(tmp, 'ref');
run('ssh-keygen', ['-t', 'ed25519', '-f', kp, '-N', '', '-C', '']);
const r2 = run('ssh-keygen', ['-l', '-f', kp + '.pub']);
check('对照密钥可解析', r2.code === 0, r2.stdout.slice(0, 60));

const bits = /\(ED25519\)/.test(r.stdout);
check('类型识别为 ED25519', bits);

/* ---- 有效期解析 ---- */
const now = Date.now();
check('7d', Math.abs(Date.parse(parseDuration('7d')) - (now + 7 * 86400000)) < 5000);
check('30d', Math.abs(Date.parse(parseDuration('30d')) - (now + 30 * 86400000)) < 5000);
check('12h', Math.abs(Date.parse(parseDuration('12h')) - (now + 12 * 3600000)) < 5000);
check('绝对日期', parseDuration('2027-02-01')?.startsWith('2027-02-01'));
check('无效输入为 null', parseDuration('随便写') === null);

/* ---- OpenSSH expiry 格式 ---- */
const exp = toSshExpiry('2027-02-01T10:30:00+08:00');
check('expiry 格式 202702011030', exp === '202702011030', exp);

/* ---- 清理 ---- */
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
