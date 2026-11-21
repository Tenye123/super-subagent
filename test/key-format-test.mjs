// 守住 "生成的私钥必须能被 ssh(1) 真正使用" 这个 bug。
//
// 背景：generateKeyPair 曾用 node:crypto 导出 PKCS#8 PEM 私钥：
//     -----BEGIN PRIVATE KEY-----
//     MC4CAQAwBQYDK2VwBCIEINoL...
// node 自己读着没问题，但 ssh(1) 只认 OpenSSH 私有容器，实测报
//     Load key "...": invalid format
//     Permission denied (publickey,keyboard-interactive)
//
// 更糟的是：所有单元测试都通过，因为它们只比较**公钥**，
// 而公钥转换（pemToSshPublic）恰好是对的。私钥格式无人验证。
//
// 这个测试做三件事：
//   1. 生成一对密钥
//   2. 用 ssh-keygen -y 实际解析私钥（这一步能真正暴露格式错误）
//   3. 确认解析出的公钥与 .pub 文件一致

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as cfg from '../lib/config.mjs';

let pass = 0, fail = 0;
const check = (l, c, e = '') => { c ? (pass++, console.log(`✓ ${l} ${e}`)) : (fail++, console.log(`✗ ${l} ${e}`)); };

// ssh-keygen 必须可用，否则本测试没有意义
const which = spawnSync('ssh-keygen', ['-?'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
const hasKeygen = !(which.error && which.error.code === 'ENOENT');
check('ssh-keygen 可用', hasKeygen);
if (!hasKeygen) {
  console.log('\n跳过：没有 ssh-keygen，无法验证私钥格式');
  process.exit(1);
}

// 用临时目录，不污染 ~/.dsh-fleet
const tmpHome = path.join(os.tmpdir(), `fleet-key-test-${Date.now()}`);
fs.mkdirSync(tmpHome, { recursive: true });
process.env.FLEET_HOME = tmpHome;

const name = 'test-key';
const kp = cfg.generateKeyPair(name, { force: true });

check('生成了私钥文件', fs.existsSync(kp.privateKey), kp.privateKey);
check('生成了公钥文件', fs.existsSync(kp.publicKey), kp.publicKey);

const privText = fs.readFileSync(kp.privateKey, 'utf8');

// 1. 必须是 OpenSSH 容器，不是 PKCS#8
check('私钥是 OpenSSH 格式（不是 PKCS#8）',
  privText.includes('BEGIN OPENSSH PRIVATE KEY'),
  privText.split('\n')[0]);

check('私钥不是 PKCS#8 格式',
  !privText.includes('BEGIN PRIVATE KEY') || privText.includes('BEGIN OPENSSH PRIVATE KEY'));

// 2. 真正的判据：ssh-keygen 能解析它
const r = spawnSync('ssh-keygen', ['-y', '-f', kp.privateKey], {
  encoding: 'utf8', windowsHide: true, timeout: 30_000,
});
check('ssh-keygen -y 能解析私钥（关键）',
  r.status === 0,
  (r.status !== 0 ? (r.stderr || '').trim().slice(0, 200) : ''));

// 3. 解析出的公钥必须与 .pub 文件一致
const derived = (r.stdout || '').trim();
const pubFile = fs.readFileSync(kp.publicKey, 'utf8').trim();
const body = (s) => (s.split(/\s+/)[1] || '');

check('解析出的公钥与 .pub 一致', body(derived) === body(pubFile),
  `derived=${body(derived).slice(0, 20)}... file=${body(pubFile).slice(0, 20)}...`);

// 4. readSshPublic 应能读出干净的两段式公钥
const read = cfg.readSshPublic(kp.publicKey);
check('readSshPublic 返回 ssh-ed25519 开头', read.startsWith('ssh-ed25519 '), read.slice(0, 40));
check('readSshPublic 去掉了注释', !read.includes('dsh-fleet:'), read);
check('readSshPublic 结果与原公钥 key body 一致', body(read) === body(pubFile));

// 5. 私钥权限：不能被其他人读（非 Windows 才严格检查）
if (process.platform !== 'win32') {
  const mode = fs.statSync(kp.privateKey).mode & 0o777;
  check('私钥权限不宽于 600', (mode & 0o077) === 0, mode.toString(8));
}

// 6. 幂等：不带 force 时不应覆盖
const again = cfg.generateKeyPair(name);
check('不带 force 时不重新生成', again.created === false);

// 7. 旧 PEM 文件仍然可读（兼容早期版本留下的公钥）
const legacyPem = [
  '-----BEGIN PUBLIC KEY-----',
  'MCowBQYDK2VwAyEAJLVZCzq9Ib8AuoLcnH2ue7CQqtIjC5C2PNYNEgZ2r+4=',
  '-----END PUBLIC KEY-----',
].join('\n');
const legacyPath = path.join(tmpHome, 'legacy.pub');
fs.writeFileSync(legacyPath, legacyPem, 'utf8');
let legacyOk = false, legacyVal = '';
try {
  legacyVal = cfg.readSshPublic(legacyPath);
  legacyOk = legacyVal.startsWith('ssh-ed25519 ');
} catch (e) {
  legacyVal = e.message;
}
check('readSshPublic 仍能读旧的 PEM 公钥', legacyOk, legacyVal.slice(0, 60));

fs.rmSync(tmpHome, { recursive: true, force: true });
console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
