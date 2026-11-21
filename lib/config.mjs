// dsh-fleet —— 配置与设备清单

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fleetHome, ensureDir, readJson, writeJson, run } from './util.mjs';

export const PATHS = {
  get home() { return fleetHome(); },
  get config() { return path.join(fleetHome(), 'fleet.json'); },
  get keys() { return path.join(fleetHome(), 'keys'); },
  get registry() { return path.join(fleetHome(), 'registry'); },
  get staging() { return path.join(fleetHome(), 'staging'); },
  get jobs() { return path.join(fleetHome(), 'jobs'); },
  get logs() { return path.join(fleetHome(), 'logs'); },
};

const DEFAULT_CONFIG = {
  version: 1,
  // 本机在这套集群里的角色：controller（主控，派活的）/ agent（子代理，干活的）
  role: null,
  self: { name: null, machineId: null, tailscaleIp: null },
  // agent 端：允许哪些主控的密钥来连（由 controller 下发时写入，这里只是缓存）
  controller: null,
  // controller 端：纳管的所有设备
  devices: [],
  ssh: { user: null, port: 22, keyType: 'ed25519' },
  // 任务登记表转发：批准后主控可以把这个端口映射到自己本机
  forward: {
    enabled: false,
    // 允许转发到哪些 host:port（只允许回环上的具体端口）
    allowed: [],
  },
  createdAt: null,
  updatedAt: null,
};

/* ---------------- 密钥用途 ---------------- */

/**
 * 两种密钥用途，权限差别很大：
 *
 *   agent —— 给命令行派活用。restrict 关掉一切转发，
 *            再叠加 command= 和 from=，只能跑我们指定的入口。
 *
 *   ui    —— 给浏览器看任务登记表用。restrict 关掉一切，
 *            然后**只**打开 port-forwarding，并用 permitopen
 *            钉死到具体端口。这样即使私钥泄露，攻击者也只能
 *            在那一个端口上做转发，拿不到 shell。
 */
export const KEY_KINDS = {
  agent: {
    name: 'agent',
    description: '命令行派活（无转发、无 PTY）',
    // restrict 已含 no-port-forwarding/no-agent-forwarding/no-pty 等
    baseOptions: ['restrict'],
  },
  ui: {
    name: 'ui',
    description: '浏览器看任务登记表（仅允许指定端口转发）',
    baseOptions: ['restrict', 'port-forwarding'],
  },
};

/**
 * 构造一行 authorized_keys。
 *
 * @param {object} p
 * @param {string} p.publicKey   形如 "ssh-ed25519 AAAA..."
 * @param {'agent'|'ui'} p.kind
 * @param {string} [p.expiresAt] ISO 时间
 * @param {string[]} [p.from]    来源地址（CIDR 或 IP）
 * @param {string} [p.command]   强制命令
 * @param {string[]} [p.permitOpen] 允许转发的目标 host:port（仅 ui）
 * @param {string} [p.comment]
 */
export function buildAuthorizedKeyLine({
  publicKey, kind = 'agent', expiresAt = null,
  from = null, command = null, permitOpen = null, comment = 'dsh-fleet',
}) {
  const spec = KEY_KINDS[kind];
  if (!spec) throw new Error(`未知的密钥用途: ${kind}（可用: ${Object.keys(KEY_KINDS).join(', ')}）`);

  const opts = [...spec.baseOptions];

  if (expiresAt) {
    const e = toSshExpiry(expiresAt);
    if (!e) throw new Error(`有效期格式无法转换: ${expiresAt}`);
    opts.push(`expiry-time="${e}"`);
  }

  if (from && from.length) {
    opts.push(`from="${from.join(',')}"`);
  }

  if (command) {
    // 双引号内的双引号要转义，否则整行都会被解析错
    opts.push(`command="${String(command).replace(/"/g, '\\"')}"`);
  }

  if (permitOpen && permitOpen.length) {
    // permitopen 同一条 authorized_keys 行只能写一个目标：
    // permitopen="a:1,b:2" 实测会被当作**一个**目标字符串，
    // 结果两个端口都不通。所以这里直接拒绝多目标，强制拆成多条 key。
    if (permitOpen.length > 1) {
      throw new Error('permitopen 同一条 key 只能有一个目标（多个目标请用不同密钥）');
    }
    const target = String(permitOpen[0]);
    if (!isLoopbackTarget(target)) {
      throw new Error(`permitopen 目标必须是回环地址上的具体端口，拒绝: ${target}`);
    }
    opts.push(`permitopen="${target}"`);
  }

  return `${opts.join(',')} ${publicKey}${comment ? ` ${comment}` : ''}`;
}

/**
 * 端口转发目标的安全校验。
 *
 * 为什么必须限制：
 *   允许转发之后，被转发的服务就等于**绕过了 A 的防火墙和 SSH 认证**，
 *   直接从主控机器可达。如果不加限制，拿到 key 的人可以把 A 上任意服务
 *   （MySQL 3306、nginx 8066、ollama 11434……）拉到他自己机器上。
 *
 * 规则：
 *   - 只能是 127.0.0.1 / localhost / ::1 —— 不允许转发到别的机器，
 *     否则 A 会变成跳板，能摸到公司内网其他主机
 *   - 必须显式写端口，1-65535
 *   - 不接受通配符、端口范围、空值
 *   - 不能是我们自己的 SSH 端口（见下面 FORBIDDEN_FORWARD_PORTS）
 */
export function isLoopbackTarget(target) {
  const s = String(target || '').trim();
  const m = /^(127\.0\.0\.1|localhost|\[::1\]|::1):(\d{1,5})$/.exec(s);
  if (!m) return false;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  if (FORBIDDEN_FORWARD_PORTS.has(port)) return false;
  return true;
}

/**
 * 不允许被转发的端口。
 *
 * 22（sshd）为什么必须禁：
 *   authorized_keys 里的 from= 限制的是"连接从哪个 IP 来"。
 *   如果把 22 端口转发出去，主控上的人就相当于从 127.0.0.1 连 A 的 sshd
 *   —— 那是回环地址，from= 的校验形同虚设，而且能绕开防火墙的网卡限制。
 *   一句话：转发到自己的 SSH 端口 = 自己给自己开后门。
 *
 * 其余是本机已知在跑的管理/数据库服务，转发出去等于直接把凭据入口
 * 送到主控机器上，没有必要，所以一并禁掉。
 */
const FORBIDDEN_FORWARD_PORTS = new Set([
  22,     // sshd —— 见上
  135,    // RPC
  139, 445, // SMB
  3306,   // MySQL
  3389,   // RDP
  5985, 5986, // WinRM
]);

export function loadConfig() {
  return { ...DEFAULT_CONFIG, ...(readJson(PATHS.config, {}) || {}) };
}

export function saveConfig(cfg) {
  cfg.updatedAt = new Date().toISOString();
  if (!cfg.createdAt) cfg.createdAt = cfg.updatedAt;
  return writeJson(PATHS.config, cfg);
}

export function configExists() {
  return fs.existsSync(PATHS.config);
}

/* ---------------- SSH 密钥 ---------------- */

/** 生成一对 ed25519 密钥，返回 { privateKey, publicKey } 路径 */
export function generateKeyPair(name, opts = {}) {
  ensureDir(PATHS.keys);
  const base = path.join(PATHS.keys, name);
  const priv = `${base}.key`;
  const pub = `${base}.key.pub`;

  if (fs.existsSync(priv) && !opts.force) {
    return { privateKey: priv, publicKey: pub, created: false };
  }

  // MUST use ssh-keygen, not node:crypto.
  //
  // BUG THAT LIVED HERE: this used
  //     crypto.generateKeyPairSync('ed25519')
  //     privateKey.export({ type: 'pkcs8', format: 'pem' })
  // which produces a 119-byte PKCS#8 PEM:
  //     -----BEGIN PRIVATE KEY-----
  //     MC4CAQAwBQYDK2VwBCIEINoLXWsWyMBoxDIR...
  //     -----END PRIVATE KEY-----
  // That is a perfectly valid key for node:crypto and completely useless to
  // ssh(1), which only reads OpenSSH's own private key container:
  //     -----BEGIN OPENSSH PRIVATE KEY-----
  // The failure showed up as, on the very first real connection attempt:
  //     Load key "...laptop-a.key": invalid format
  //     Permission denied (publickey,keyboard-interactive).
  // Every unit test still passed because they only ever compared the PUBLIC
  // half, which pemToSshPublic() converts correctly.
  //
  // node:crypto cannot emit the OpenSSH private container, so shell out to
  // ssh-keygen. It ships with Windows 10+ and with every OpenSSH install, so
  // this adds no new dependency. `-N ""` makes the key passphrase-less, which
  // is what an unattended agent needs; the key is restricted by
  // authorized_keys options and expiry instead (see buildAuthorizedKeyLine).
  const r = run('ssh-keygen', ['-t', 'ed25519', '-f', priv, '-N', '', '-C', `dsh-fleet:${name}`, '-q']);
  if (r.code !== 0) {
    // Do not silently fall back to the broken path -- that is how the bug
    // survived this long. Fail loudly with the actual reason.
    throw new Error(
      `ssh-keygen 生成密钥失败（退出码 ${r.code}）：${(r.stderr || r.stdout || '').trim()}\n` +
      '请确认 ssh-keygen 可用（Windows 10+ 自带，或安装 OpenSSH 客户端）。'
    );
  }
  if (!fs.existsSync(priv) || !fs.existsSync(pub)) {
    throw new Error('ssh-keygen 声称成功但没有生成文件');
  }
  return { privateKey: priv, publicKey: pub, created: true };
}

/**
 * 把 PEM(SPKI) 公钥转成 OpenSSH authorized_keys 行的 key 部分。
 *
 * ed25519 的 SPKI DER 固定为 44 字节：
 *   30 2a 30 05 06 03 2b 65 70 03 21 00 | <32 字节裸公钥>
 * 前面 12 字节是 ASN.1 头，必须剥掉，只取末尾 32 字节。
 * （直接把整个 DER 塞进去 ssh-keygen 会拒绝解析）
 */
export function pemToSshPublic(pem) {
  const b64 = pem
    .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '')
    .replace(/\s+/g, '');
  const der = Buffer.from(b64, 'base64');
  if (der.length < 32) throw new Error('公钥长度异常');

  const raw = der.subarray(der.length - 32);
  const type = Buffer.from('ssh-ed25519');
  const blob = Buffer.concat([
    bufLen(type.length), type,
    bufLen(raw.length), raw,
  ]);
  return `ssh-ed25519 ${blob.toString('base64')}`;
}

/**
 * 读出公钥文件里的 OpenSSH 单行公钥（`ssh-ed25519 AAAA... comment` 形式），
 * 只保留 `ssh-ed25519 <base64>` 两段，去掉注释。
 *
 * 现在密钥由 ssh-keygen 生成，`.pub` 本来就是 OpenSSH 格式，直接取前两段即可。
 * 但仍兼容旧的 PEM(SPKI) 文件：早期版本用 node:crypto 导出 PEM 公钥，
 * 那些机器上留下的文件还在，直接报错会让它们无法继续使用。
 */
export function readSshPublic(keyFilePath) {
  const text = fs.readFileSync(keyFilePath, 'utf8');
  const trimmed = text.trim();

  if (trimmed.includes('BEGIN PUBLIC KEY')) {
    // 旧格式（PEM/SPKI），转换一次
    return pemToSshPublic(trimmed);
  }

  // OpenSSH 格式：ssh-ed25519 <b64> [comment]
  const m = /^(ssh-[a-z0-9-]+)\s+([A-Za-z0-9+/=]+)/.exec(trimmed);
  if (!m) throw new Error(`无法识别的公钥格式：${keyFilePath}`);
  return `${m[1]} ${m[2]}`;
}

function bufLen(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

/* ---------------- 设备条目 ---------------- */

export function newDevice({ name, machineId, tailscaleIp, user, port = 22, keyPath, expiresAt = null }) {
  const now = new Date().toISOString();
  return {
    id: name,
    name,
    machineId: machineId || null,
    tailscaleIp: tailscaleIp || null,
    user: user || null,
    port,
    keyPath: keyPath || null,
    // 授权有效期，到期后 controller 主动拒绝派活（双保险）
    expiresAt,
    revoked: false,
    addedAt: now,
    lastSeenAt: null,
    lastError: null,
  };
}

export function upsertDevice(cfg, dev) {
  const i = cfg.devices.findIndex((d) => d.id === dev.id);
  if (i >= 0) cfg.devices[i] = { ...cfg.devices[i], ...dev };
  else cfg.devices.push(dev);
  return cfg;
}

export function findDevice(cfg, id) {
  return cfg.devices.find((d) => d.id === id) || null;
}

/** 可用设备（未撤销、未过期） */
export function activeDevices(cfg) {
  const now = Date.now();
  return cfg.devices.filter((d) => {
    if (d.revoked) return false;
    if (d.expiresAt && Date.parse(d.expiresAt) < now) return false;
    return true;
  });
}

/** 解析有效期的常见写法：7d / 30d / 2027-02-01 / 12h */
export function parseDuration(input) {
  if (!input) return null;
  const s = String(input).trim();

  const rel = /^(\d+)\s*(m|h|d|w|mo|y)$/i.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const ms = {
      m: 60_000, h: 3_600_000, d: 86_400_000,
      w: 604_800_000, mo: 2_592_000_000, y: 31_536_000_000,
    }[unit];
    return new Date(Date.now() + n * ms).toISOString();
  }

  const abs = Date.parse(s);
  if (!Number.isNaN(abs)) return new Date(abs).toISOString();

  return null;
}

/** OpenSSH 的 expiry-time 格式：YYYYMMDD 或 YYYYMMDDHHMM */
export function toSshExpiry(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}
