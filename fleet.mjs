#!/usr/bin/env node
// super-subagent —— 把多台设备组织成 DSH 超级子代理集群
//
// 设计原则：
//   主控（controller）派活，代理（agent）干活。
//   agent 是 controller 的"有自己设备的子代理"，不是对等节点。

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { log, run, IS_WIN } from './lib/util.mjs';
import * as cfg from './lib/config.mjs';
import * as probe from './lib/probe.mjs';
import * as ssh from './lib/ssh.mjs';
import * as rpcDispatch from './lib/dispatch-rpc.mjs';
import * as jobs from './lib/jobs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 版本只有 package.json 一个来源。
// 原来这里硬编码 '0.2.0'，而 package.json 升到了 0.3.0，`fleet --help`
// 印出来的版本就比实际旧 —— 这种不一致在排查"到底装的是哪一版"时很误导。
const VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/* ---------------- 参数解析（不引第三方库） ---------------- */

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out.flags[key] = true;
      } else {
        out.flags[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

/* ---------------- 命令：doctor ---------------- */

function cmdDoctor(args) {
  const role = args.flags.role || cfg.loadConfig().role || 'agent';
  const items = probe.checks({ role });
  const sum = probe.summarize(items);

  log.info(`\nsuper-subagent doctor  (role: ${role})\n`);
  for (const it of items) {
    const mark =
      it.level === 'ok' ? '\x1b[32m✓\x1b[0m'
        : it.level === 'warn' ? '\x1b[33m!\x1b[0m'
          : '\x1b[31m✗\x1b[0m';
    log.info(`${mark} ${it.label.padEnd(26)} ${it.detail}`);
    if (it.fix && it.level !== 'ok') log.dim(`     修复：${it.fix}`);
  }

  log.info('');
  log.info(`${sum.ok} 项正常, ${sum.warn} 项待处理, ${sum.fail} 项阻塞`);
  if (args.flags.json) console.log(JSON.stringify({ role, items, sum }, null, 2));
  return sum.fail === 0 ? 0 : 1;
}

/* ---------------- 命令：init / status ---------------- */

function cmdInit(args) {
  const role = args.flags.role;
  if (!['controller', 'agent'].includes(role)) {
    log.err('需要 --role controller 或 --role agent');
    return 2;
  }

  const snap = probe.snapshot();
  const name = args.flags.name || snap.host.toLowerCase().replace(/[^a-z0-9-]/g, '-') || `node-${Date.now()}`;
  const ts = snap.tailscale.ips[0] || null;

  const existing = cfg.loadConfig();
  const config = {
    ...existing,
    role,
    self: { name, machineId: snap.machineId, tailscaleIp: ts, host: snap.host },
  };

  if (role === 'controller' && !existing.ssh.user) {
    config.ssh.user = process.env.USERNAME || os.userInfo().username;
  }

  cfg.saveConfig(config);
  log.ok(`已初始化：role=${role}, name=${name}`);
  if (ts) log.dim(`   Tailscale IP: ${ts}`);
  else log.warn('未检测到 Tailscale IP，跨网络访问将不可用（同局域网/热点仍可）');
  log.dim(`   配置：${cfg.PATHS.config}`);
  return 0;
}

function cmdStatus(args) {
  const config = cfg.loadConfig();
  if (!config.role) {
    log.err('尚未初始化，先运行：fleet init --role controller|agent');
    return 2;
  }

  if (config.role === 'controller') {
    const active = cfg.activeDevices(config);
    log.info(`\n主控：${config.self.name}  (${config.self.tailscaleIp || '无 Tailscale IP'})`);
    log.info(`设备：${active.length} 台可用 / 共 ${config.devices.length} 台\n`);

    if (!config.devices.length) {
      log.dim('  还没有纳管设备。在 agent 机器上跑完安装，再执行：fleet enroll ...');
      return 0;
    }

    for (const d of config.devices) {
      const state = d.revoked ? '已撤销' : (cfg.activeDevices(config).includes(d) ? '有效' : '已过期');
      const exp = d.expiresAt ? d.expiresAt.slice(0, 10) : '永久';
      log.info(`  ${d.name.padEnd(16)} ${String(d.tailscaleIp || '-').padEnd(16)} ${state.padEnd(6)} 到期 ${exp}`);
    }
  } else {
    const c = config.controller;
    log.info(`\n代理：${config.self.name}  (${config.self.tailscaleIp || '无 Tailscale IP'})`);
    if (c) {
      log.info(`主控：${c.name}  ${c.tailscaleIp || ''}`);
      log.info(`授权：${c.expiresAt ? `到 ${c.expiresAt.slice(0, 10)}` : '永久'}`);
    } else {
      log.dim('  还没有接纳主控。等主控下发授权后，执行：fleet accept --file <授权文件>');
    }
  }
  return 0;
}

/* ---------------- 命令：forward（任务登记表转发） ---------------- */

/**
 * 管理"主控通过 SSH 隧道看任务登记表"这件事。
 *
 * 这个功能的安全边界（也是用户批准时要求验证的部分）：
 *   1) sshd 全局 AllowTcpForwarding 必须是 local，不能是 yes
 *      —— yes 会额外允许远程转发，等于让主控把本机当跳板去连公司内网。
 *   2) PermitOpen 全局钉死到具体回环端口
 *   3) 每条 ui 密钥再单独 permitopen 一次
 *   4) GatewayPorts no —— 转发出来的端口绝不绑到 0.0.0.0
 *
 * 为什么需要 --status 子命令：这些限制分散在 sshd_config 和
 * authorized_keys 两处，任何一处被改松都会静默失效。status 把两处
 * 一起读出来，并用"真实流量"测试给出结论，而不是只念配置文本。
 */
function cmdForward(args) {
  const config = cfg.loadConfig();
  const target = args.flags['permit-open'] || args.flags.target || '127.0.0.1:8787';

  // ---------- --status ----------
  if (args.flags.status) {
    const sshdCfgPath = IS_WIN ? 'C:\\ProgramData\\ssh\\sshd_config' : '/etc/ssh/sshd_config';
    if (!fs.existsSync(sshdCfgPath)) {
      log.err(`找不到 sshd 配置：${sshdCfgPath}`);
      return 1;
    }

    // 只取第一个 Match 块之前的内容：Match 块内的指令不适用于全局，
    // 而且 Windows 默认配置末尾那个 Match 会覆盖前面的值。
    let raw = fs.readFileSync(sshdCfgPath, 'utf8');
    const mIdx = raw.search(/^[ \t]*Match[ \t]/m);
    const head = mIdx >= 0 ? raw.slice(0, mIdx) : raw;

    const get = (key) => {
      const re = new RegExp(`^[ \\t]*${key}[ \\t]+(.+)$`, 'm');
      const m = re.exec(head);
      return m ? m[1].trim() : null;
    };

    const fwd = get('AllowTcpForwarding');
    const permit = get('PermitOpen');
    const gw = get('GatewayPorts');
    const agentFwd = get('AllowAgentForwarding');
    const tunnel = get('PermitTunnel');

    log.info('\n任务登记表转发状态\n');

    const row = (label, value, ok, hint = '') => {
      const mark = ok === null ? '·' : (ok ? '✓' : '✗');
      log.info(`  ${mark} ${label.padEnd(22)} ${String(value ?? '(未设置)').padEnd(22)} ${hint}`);
    };

    // AllowTcpForwarding：必须是 local
    row('AllowTcpForwarding', fwd,
      fwd === 'local' ? true : (fwd === null || fwd === 'no' ? false : false),
      fwd === 'local' ? '（只允许 ssh -L）'
        : fwd === 'yes' ? '（危险：还允许远程转发，本机会变成跳板）'
          : '（转发被关闭，ui 密钥也用不了）');

    row('PermitOpen', permit, permit !== null, permit ? '' : '（未设置：任意目标都可申请）');
    row('GatewayPorts', gw, gw !== null && /^no$/i.test(gw), /^no$/i.test(gw || '') ? '' : '（转发可能绑到 0.0.0.0）');
    row('AllowAgentForwarding', agentFwd, agentFwd === null || /^no$/i.test(agentFwd || ''), '');
    row('PermitTunnel', tunnel, tunnel === null || /^no$/i.test(tunnel || ''), '');

    // 本机登记的 ui 密钥
    const c = config.controller;
    log.info('');
    if (c && c.kind === 'ui') {
      log.info(`  已签发 ui 密钥：${c.name}`);
      log.info(`    permitopen = ${(c.permitOpen || []).join(', ') || '(空)'}`);
      log.info(`    有效期     = ${c.expiresAt ? c.expiresAt.slice(0, 10) : '永久'}`);
    } else {
      log.dim('  还没有签发 ui 密钥（在 agent 上执行 fleet accept --kind ui --permit-open ...）');
    }

    // 结论
    const ready = fwd === 'local';
    log.info('');
    if (ready) {
      log.ok('配置就绪：主控可以转发到被允许的端口。');
    } else {
      log.warn('配置未就绪：需要把 AllowTcpForwarding 设为 local。');
      log.dim('  以管理员身份运行 install/enable-forwarding.ps1 即可（会先做 sshd -t 校验，失败自动回滚）。');
    }

    // 主控侧要执行的命令
    const selfIp = config.self.tailscaleIp || '<A的Tailscale IP>';
    const port = target.split(':')[1];
    log.info('\n主控侧命令（把任务登记表映射到本机 8787）：');
    log.info(`  ssh -N -L 8787:127.0.0.1:${port} -i <ui私钥> -o ExitOnForwardFailure=yes <用户>@${selfIp}`);
    log.dim('   然后浏览器打开 http://127.0.0.1:8787/');
    log.dim('   注意：这条 key 不能开 shell，也不能转发到别的端口。');

    return 0;
  }

  // ---------- 默认：说明用法 ----------
  log.info('\n任务登记表转发\n');
  log.info('  查看状态：fleet forward --status');
  log.info('  签发权限：fleet accept --controller <主控名> --pubkey "<公钥>" --kind ui --permit-open 127.0.0.1:8787');
  log.info('');
  log.dim('  安全约束：只允许回环上的具体端口；禁止 22/3306/3389 等敏感端口；');
  log.dim('  全局 AllowTcpForwarding 必须是 local（不是 yes），GatewayPorts 必须是 no。');
  return 0;
}

/* ---------------- 命令：keygen ---------------- */

function cmdKeygen(args) {
  const name = args.flags.name;
  if (!name) {
    log.err('需要 --name <设备名>');
    return 2;
  }
  const kp = cfg.generateKeyPair(name, { force: Boolean(args.flags.force) });
  const priv = fs.readFileSync(kp.privateKey, 'utf8');
  const sshPub = cfg.readSshPublic(kp.publicKey);

  log.ok(`${kp.created ? '已生成' : '已存在'}密钥：${name}`);
  log.dim(`   私钥：${kp.privateKey}`);
  log.info(`\n公钥（交给主控）：\n${sshPub}\n`);
  return 0;
}

/* ---------------- 命令：enroll（controller 侧） ---------------- */

function cmdEnroll(args) {
  const config = cfg.loadConfig();
  if (config.role !== 'controller') {
    log.err('只有主控可以纳管设备');
    return 2;
  }

  const name = args.flags.name;
  const ip = args.flags.ip;
  const user = args.flags.user || config.ssh.user;

  if (!name || !ip || !user) {
    log.err('用法：fleet enroll --name <设备名> --ip <tailscale-ip> --user <用户名> [--pubkey <公钥> | --pubkey-file <文件>] [--expires 30d]');
    return 2;
  }

  // 公钥来源
  let sshPub = args.flags.pubkey || null;
  if (!sshPub && args.flags['pubkey-file']) {
    sshPub = fs.readFileSync(args.flags['pubkey-file'], 'utf8').trim();
  }

  // 生成本机保存的私钥（controller 侧持有，用来连 agent）
  const kp = cfg.generateKeyPair(name);

  const expiresAt = cfg.parseDuration(args.flags.expires || null);
  if (args.flags.expires && !expiresAt) {
    log.err(`无法解析有效期：${args.flags.expires}（试试 7d / 30d / 2027-02-01）`);
    return 2;
  }

  const existing = cfg.findDevice(config, name);
  const dev = cfg.newDevice({
    name,
    machineId: args.flags.machineId || existing?.machineId || null,
    tailscaleIp: ip,
    user,
    port: Number(args.flags.port || 22),
    keyPath: kp.privateKey,
    expiresAt,
  });
  // 保留原来的添加时间
  if (existing) dev.addedAt = existing.addedAt;
  cfg.upsertDevice(config, dev);
  cfg.saveConfig(config);

  log.ok(`已纳管设备：${name} (${user}@${ip})`);
  if (expiresAt) log.dim(`   有效期至：${expiresAt.slice(0, 10)}`);

  // 输出 agent 侧要执行的命令
  const sshPubLocal = cfg.readSshPublic(kp.publicKey);
  const sshExpiry = cfg.toSshExpiry(expiresAt);

  log.info('\n在 agent 机器上执行以下命令完成授权：\n');
  const opts = ['restrict', 'command="..."'];
  if (sshExpiry) opts.push(`expiry-time="${sshExpiry}"`);
  log.info(`  fleet accept --controller ${config.self.name} --pubkey '${sshPubLocal}'${expiresAt ? ` --expires ${expiresAt}` : ''}`);
  log.info('');
  if (sshPub) {
    log.dim('（你提供的 agent 公钥已记录，本机私钥用于连接）');
  } else {
    log.warn('未提供 agent 的公钥：agent 侧还需要把本机公钥加进 authorized_keys，否则连接会被拒');
  }
  return 0;
}

/* ---------------- 命令：accept（agent 侧） ---------------- */

function cmdAccept(args) {
  const config = cfg.loadConfig();
  const pubkey = args.flags.pubkey;
  const controllerName = args.flags.controller || 'controller';

  if (!pubkey) {
    log.err('用法：fleet accept --controller <主控名> --pubkey "<ssh-ed25519 ...>" [--expires 30d]');
    log.err('      fleet accept --controller <主控名> --pubkey "..." --kind ui --permit-open 127.0.0.1:8787');
    return 2;
  }

  const expiresAt = cfg.parseDuration(args.flags.expires || null);
  const sshExpiry = cfg.toSshExpiry(expiresAt);

  // 密钥用途：agent（默认，命令行派活）/ ui（只做端口转发）
  //
  // 注意 "kind" in flags 的写法：如果用户显式写了 `--kind ""`（或 --kind 后面
  // 跟了个空值），我们必须报错，而不能因为空串是 falsy 就悄悄退回默认的 agent。
  //   —— 用户想写 admin 却打成了空值，退化成 agent 会给他一个他并没要求的、
  //      带 shell 能力的 key。静默降级在权限系统里是不可接受的。
  const kindGiven = Object.prototype.hasOwnProperty.call(args.flags, 'kind');
  const kindRaw = kindGiven ? args.flags.kind : 'agent';
  const kind = kindRaw === undefined || kindRaw === true ? '' : String(kindRaw);
  if (!cfg.KEY_KINDS[kind]) {
    log.err(kindGiven
      ? `未知的 --kind：${JSON.stringify(kindRaw)}（可用：${Object.keys(cfg.KEY_KINDS).join(' / ')}）`
      : `未知的 --kind（可用：${Object.keys(cfg.KEY_KINDS).join(' / ')}）`);
    return 2;
  }

  // ---- ui 用途：转发目标必须在写入前校验 ----
  let permitOpen = null;
  if (kind === 'ui') {
    // 必须显式给出目标。
    // 早先这里是 `args.flags['permit-open'] || config.forward?.allowed?.[0]`，
    // 于是漏写 --permit-open 时会**沿用上一次的旧目标**，命令返回 0 且看起来
    // 一切正常 —— 用户以为自己在授权端口 X，实际授权的是历史上第一个端口。
    // 授权类操作不能有这种隐式继承，宁可报错。
    const target = args.flags['permit-open'];
    if (!target) {
      log.err('--kind ui 必须显式指定 --permit-open <127.0.0.1:端口>');
      log.dim('   例：--permit-open 127.0.0.1:8787');
      log.dim('   不会沿用历史配置，避免"以为授权了 A 实际授权了 B"。');
      return 2;
    }
    // 这里是安全闸门：只允许回环上的具体端口，且排除 SSH 等敏感端口。
    // 校验失败时**拒绝写入**，绝不"先写进去再说"。
    if (!cfg.isLoopbackTarget(target)) {
      log.err(`拒绝的转发目标：${target}`);
      log.info('   只允许回环地址上的具体端口，例如 127.0.0.1:8787。');
      log.info('   不允许 0.0.0.0/内网 IP/域名/端口范围，也不允许 22、3306、3389 等敏感端口。');
      return 2;
    }
    permitOpen = [target];
  }

  // 组装 authorized_keys 行。走统一构造函数，避免 CLI 和测试两套逻辑漂移。
  let line;
  try {
    line = cfg.buildAuthorizedKeyLine({
      publicKey: pubkey.trim(),
      kind,
      expiresAt,
      from: kind === 'agent' ? ['100.64.0.0/10', '192.168.137.0/24'] : ['100.64.0.0/10', '192.168.137.0/24'],
      permitOpen,
      comment: `${controllerName}${kind === 'ui' ? '-ui' : ''}`,
    });
  } catch (e) {
    log.err(e.message);
    return 2;
  }

  let written;
  try {
    written = appendAuthorizedKey(line, `${controllerName}${kind === 'ui' ? '-ui' : ''}`);
  } catch (e) {
    log.err(e.message);
    if (e.code === 'AUTHORIZED_KEYS_UNWRITABLE') {
      log.info('\n以管理员身份重新执行（推荐）：');
      log.dim('  右键「Windows PowerShell」→ 以管理员身份运行，再执行同一命令');
      log.info('\n或者手动追加这一行到 C:\\ProgramData\\ssh\\administrators_authorized_keys：');
      log.info(`  ${e.line}`);
      log.info('\n然后收紧权限：');
      log.dim('  icacls "C:\\ProgramData\\ssh\\administrators_authorized_keys" /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"');
      // 仍然记录主控信息，方便重试
      config.controller = {
        name: controllerName,
        pubkey: pubkey.trim(),
        kind,
        permitOpen,
        expiresAt,
        acceptedAt: null,
        pending: true,
      };
      cfg.saveConfig(config);
    }
    return 1;
  }

  config.controller = {
    name: controllerName,
    pubkey: pubkey.trim(),
    kind,
    permitOpen,
    expiresAt,
    acceptedAt: new Date().toISOString(),
    pending: false,
  };
  if (kind === 'ui') {
    config.forward = { enabled: true, allowed: permitOpen };
  }
  cfg.saveConfig(config);

  log.ok(`已接纳主控：${controllerName}（用途：${kind} — ${cfg.KEY_KINDS[kind].description}）`);
  log.dim(`   写入：${written.path}`);
  if (written.fellBack) {
    log.warn('管理员账户通常需要写 administrators_authorized_keys，这里退回了用户路径');
    log.dim('   若 ssh 报 Permission denied，改用管理员权限重跑本命令');
  }
  if (expiresAt) log.dim(`   有效期至：${expiresAt.slice(0, 10)}`);
  if (written.needsAclFix) {
    log.warn('该文件需要收紧 ACL 才会被 sshd 读取，执行：');
    log.dim(`   icacls "${written.path}" /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"`);
  }

  if (kind === 'ui') {
    log.info(`\n主控现在只能通过这条 key 转发到 ${permitOpen[0]}，拿不到 shell。`);
    log.dim('   转发要求 sshd_config 里 AllowTcpForwarding 不是 no：');
    log.dim('   本机当前状态可用 fleet forward --status 查看');
  } else {
    log.info('\n主控现在可以连接本机了。');
  }
  return 0;
}

/** 从 authorized_keys 行里提取"公钥体"（去选项、去注释），用于去重 */
function sshKeyBody(line) {
  const m = /((?:ssh|ecdsa)-\S+\s+[A-Za-z0-9+/=]+)/.exec(line);
  return m ? m[1] : null;
}

/**
 * 把公钥行写进正确的 authorized_keys，返回 { path, needsAclFix } 或抛出带修复建议的错误。
 *
 * Windows 的分裂点：管理员组账户必须写
 * C:\ProgramData\ssh\administrators_authorized_keys，
 * 而该目录需要提权才能写。所以这里先探测可写性，给出明确的下一步，
 * 而不是让 EPERM 直接崩掉。
 */
function appendAuthorizedKey(line, tag) {
  const adminKeys = 'C:\\ProgramData\\ssh\\administrators_authorized_keys';
  const userKeys = path.join(os.homedir(), '.ssh', 'authorized_keys');

  const isAdmin = probe.isAdminMember();
  const preferAdmin = isAdmin && IS_WIN;

  // 决策：优先管理员路径；不可写则退回用户路径并告知
  const candidates = preferAdmin ? [adminKeys, userKeys] : [userKeys];

  for (const target of candidates) {
    const dir = path.dirname(target);
    try {
      fs.mkdirSync(dir, { recursive: true });
      // 探测可写性（不破坏原文件）
      const probeFile = `${target}.fleet-probe`;
      fs.writeFileSync(probeFile, '');
      fs.unlinkSync(probeFile);

      let existing = '';
      if (fs.existsSync(target)) existing = fs.readFileSync(target, 'utf8');

      // 去重：按"公钥体"匹配，而不是 tag。
      // 按 tag 去重会漏掉"同一把钥匙换了 tag"和"重复执行"两种情况
      // （实测跑两次会写出两行只差 tag 的重复授权）。
      const keyBody = sshKeyBody(line);
      const kept = existing
        .split(/\r?\n/)
        .filter((l) => l.trim() && sshKeyBody(l) !== keyBody);
      kept.push(line);

      fs.writeFileSync(target, kept.join('\r\n') + '\r\n', 'utf8');

      let needsAclFix = false;
      if (target === adminKeys && IS_WIN) {
        const r = run('icacls', [target, '/inheritance:r', '/grant', 'Administrators:F', '/grant', 'SYSTEM:F']);
        needsAclFix = r.code !== 0;
      }
      return { path: target, needsAclFix, fellBack: target !== candidates[0] };
    } catch (e) {
      // 试下一个候选
      continue;
    }
  }

  // 全都失败
  const err = new Error(
    '无法写入 authorized_keys。管理员组账户必须写到 ' +
    adminKeys +
    '，该路径需要管理员权限。\n' +
    '请以管理员身份重新运行这一条命令，或手动把下面这行追加进去：\n' +
    line
  );
  err.code = 'AUTHORIZED_KEYS_UNWRITABLE';
  err.line = line;
  throw err;
}

/* ---------------- 命令：revoke / list ---------------- */

function cmdRevoke(args) {
  const config = cfg.loadConfig();
  const id = args.flags.name || args._[0];
  if (!id) {
    log.err('用法：fleet revoke --name <设备名>');
    return 2;
  }
  const dev = cfg.findDevice(config, id);
  if (!dev) {
    log.err(`没有这台设备：${id}`);
    return 2;
  }
  dev.revoked = true;
  dev.revokedAt = new Date().toISOString();
  cfg.saveConfig(config);
  log.ok(`已撤销：${id}`);
  log.warn('注意：撤销只影响本机派活。要让对方彻底失效，还需在 agent 上删除 authorized_keys 里对应那行');
  log.dim(`   在 agent 上执行：fleet unaccept --controller ${config.self.name}`);
  return 0;
}

function cmdList(args) {
  const config = cfg.loadConfig();
  const rows = config.devices.map((d) => ({
    name: d.name,
    ip: d.tailscaleIp,
    user: d.user,
    state: d.revoked ? 'revoked' : (d.expiresAt && Date.parse(d.expiresAt) < Date.now() ? 'expired' : 'active'),
    expiresAt: d.expiresAt,
    lastSeenAt: d.lastSeenAt,
  }));
  if (args.flags.json) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.table(rows);
  }
  return 0;
}

/* ---------------- 命令：ping ---------------- */

function cmdPing(args) {
  const config = cfg.loadConfig();
  const target = args.flags.name || args._[0];
  const devs = target ? [cfg.findDevice(config, target)].filter(Boolean) : cfg.activeDevices(config);

  if (!devs.length) {
    log.err('没有可测设备');
    return 2;
  }

  let bad = 0;
  for (const d of devs) {
    const t0 = Date.now();
    const r = ssh.ping(d);
    const ms = Date.now() - t0;
    if (r.ok) {
      log.ok(`${d.name.padEnd(16)} ${ms}ms`);
      d.lastSeenAt = new Date().toISOString();
      d.lastError = null;
    } else {
      bad++;
      log.err(`${d.name.padEnd(16)} ${r.error}`);
      d.lastError = r.error;
    }
  }
  cfg.saveConfig(config);
  return bad === 0 ? 0 : 1;
}

/* ---------------- 命令：run（核心，派活） ---------------- */

// 必须是 async：派活现在是异步的（RPC 需要轮询到本轮结束）。
async function cmdRun(args) {
  const config = cfg.loadConfig();
  if (config.role !== 'controller') {
    log.err('只有主控可以派活');
    return 2;
  }

  const deviceId = args.flags.device || args._[0];
  const task = args.flags.task || (args._.length > 1 ? args._.slice(1).join(' ') : null);

  if (!deviceId || !task) {
    log.err('用法：fleet run --device <设备名> --task "<任务文本>" [--cwd <远端目录>] [--session <id>]');
    return 2;
  }

  const dev = cfg.findDevice(config, deviceId);
  if (!dev) {
    log.err(`没有这台设备：${deviceId}`);
    return 2;
  }
  if (dev.revoked) {
    log.err(`设备已撤销：${deviceId}`);
    return 2;
  }
  if (dev.expiresAt && Date.parse(dev.expiresAt) < Date.now()) {
    log.err(`设备授权已过期：${deviceId}（${dev.expiresAt.slice(0, 10)}）`);
    return 2;
  }

  const job = jobs.createJob({
    device: deviceId,
    task,
    cwd: args.flags.cwd || null,
    session: args.flags.session || null,
    timeoutMs: Number(args.flags.timeout || 1_800_000),
  });

  log.dim(`任务 ${job.id} → ${deviceId}`);
  jobs.markRunning(job);

  // 走桌面端的 Connection RPC。会话由应用自己创建，因而登记进 workspace，
  // 在那台机器的界面上可见可续——这是 headless 打印模式做不到的。
  let r;
  try {
    r = await rpcDispatch.dispatch(dev, task, {
      cwd: job.cwd || dev.workspace,
      timeoutMs: job.timeoutMs,
      onProgress: args.flags.json ? null : (m) => log.dim('  ' + m),
    });
  } catch (e) {
    const reason = e && e.message ? e.message : String(e);
    jobs.markDone(job, { exitCode: 1, error: reason });
    log.err(`失败：${reason}`);
    return 1;
  }

  if (!r.accepted) {
    const reason = '远端未接受任务（会话可能已关闭或正忙）';
    jobs.markDone(job, { exitCode: 1, sessionId: r.sessionId, error: reason });
    log.err(reason);
    return 1;
  }

  if (!r.finished) {
    const reason = `等待 ${Math.round(job.timeoutMs / 1000)} 秒后本轮仍未结束；会话仍在运行，可稍后续看`;
    jobs.markDone(job, {
      exitCode: -1,
      sessionId: r.sessionId,
      summary: r.answer,
      error: reason,
    });
    log.err(reason);
    log.dim(`session ${r.sessionId}`);
    if (r.answer) log.info(r.answer);
    return 1;
  }

  jobs.markDone(job, {
    exitCode: 0,
    sessionId: r.sessionId,
    summary: r.answer,
    final: r.answer,
    toolCalls: 0,
    error: null,
  });

  if (args.flags.json) {
    console.log(JSON.stringify(jobs.loadJob(job.id), null, 2));
  } else {
    log.info('');
    log.info(r.answer || '(无输出)');
    log.info('');
    log.dim(`job ${job.id} · session ${r.sessionId} · 已登记进远端工作区`);
  }
  return 0;
}

/* ---------------- 命令：jobs ---------------- */

function cmdJobs(args) {
  const list = jobs.listJobs({
    limit: Number(args.flags.limit || 20),
    state: args.flags.state || null,
    device: args.flags.device || null,
  });

  if (args.flags.json) {
    console.log(JSON.stringify(list, null, 2));
    return 0;
  }
  if (!list.length) {
    log.dim('还没有任务');
    return 0;
  }
  console.table(
    list.map((j) => ({
      id: j.id,
      device: j.device,
      state: j.state,
      tools: j.toolCalls,
      summary: (j.summary || j.error || '').slice(0, 40),
    }))
  );
  return 0;
}

/* ---------------- 命令：bootstrap ---------------- */

async function cmdBootstrap(args) {
  const { bootstrap } = await import('./lib/bootstrap.mjs');
  bootstrap({
    port: Number(args.flags.port || 8931),
    ttlMinutes: Number(args.flags.ttl || 30),
  });
  // 服务常驻，靠 Ctrl+C 结束
  return new Promise(() => {});
}

/* ---------------- 命令：mcp ---------------- */

async function cmdMcp(args) {
  // 直接把 MCP server 挂在当前进程上，省一次 spawn
  await import('./mcp/server.mjs');
  return new Promise(() => {});
}

/* ---------------- 命令：install（调用 install.ps1） ---------------- */

function cmdInstall(args) {
  const role = args.flags.role;
  if (!['controller', 'agent'].includes(role)) {
    log.err('用法：fleet install --role controller|agent [--name <设备名>] [--yes]');
    return 2;
  }

  const script = path.join(HERE, 'install', 'install.ps1');
  if (!fs.existsSync(script)) {
    log.err(`安装脚本缺失：${script}`);
    return 2;
  }

  const psArgs = [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', script,
    '-Role', role,
  ];
  if (args.flags.name) psArgs.push('-DeviceName', args.flags.name);
  if (args.flags.yes) psArgs.push('-Yes');
  if (args.flags['software-only']) psArgs.push('-SoftwareOnly');

  // 用 powershell.exe（5.1）而不是 pwsh —— 目标机器不一定装了 pwsh 7
  const r = run('powershell.exe', psArgs, { timeout: 1_800_000 });
  if (r.stdout) console.log(r.stdout);
  if (r.stderr) console.error(r.stderr);
  return r.code;
}

/* ---------------- 命令：help ---------------- */

function printHelp() {
  console.log(`
super-subagent v${VERSION} —— 把多台设备组织成 DSH 超级子代理集群

主控（controller）：你日常操作的那台，负责派活
代理（agent）    ：有自己设备、自己文件系统的执行端

安装
  fleet install --role agent            在代理机上一次性装好（推荐）
  fleet install --role controller       在主控机上初始化
  fleet doctor [--role agent]           体检：node / dsh / sshd / tailscale / 权限

身份与授权
  fleet init --role controller|agent    初始化本机角色
  fleet keygen --name laptop-a          生成密钥对
  fleet enroll --name laptop-a --ip 100.x.x.x --user hp [--expires 30d]
                                        主控纳管一台代理
  fleet accept --controller pc --pubkey "ssh-ed25519 ..." [--expires 30d]
                                        代理接纳主控（写入 authorized_keys）
  fleet accept --controller pc --pubkey "..." --kind ui --permit-open 127.0.0.1:8787
                                        签一条"只能转发到该端口"的只读 key
  fleet forward --status                检查转发配置是否安全就绪
  fleet revoke --name laptop-a          撤销某台代理（主控侧）
  fleet list                            列出所有代理
  fleet status                          当前角色与状态

派活
  fleet ping [--name laptop-a]          连通性检查
  fleet run --device laptop-a --task "编译 ztb-dataex"
  fleet run --device laptop-a --task "整理 D 盘" --session s-clean --cwd "E:\\work"
  fleet jobs [--limit 20] [--state done] [--json]

维护
  fleet prune --days 14                 清理旧任务记录
  fleet mcp                             以 MCP server 模式运行（供 DSH 直接接入）

常用参数
  --json      机器可读输出
  --expires   有效期：7d / 30d / 2027-02-01
`);
}

/* ---------------- 入口 ---------------- */

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = args._[0] || 'help';

  // 让 accept 里的 icacls 能用
  const commands = {
    doctor: cmdDoctor,
    init: cmdInit,
    install: cmdInstall,
    bootstrap: cmdBootstrap,
    mcp: cmdMcp,
    status: cmdStatus,
    keygen: cmdKeygen,
    enroll: cmdEnroll,
    accept: cmdAccept,
    forward: cmdForward,
    revoke: cmdRevoke,
    list: cmdList,
    ping: cmdPing,
    run: cmdRun,
    jobs: cmdJobs,
    prune: () => {
      const n = jobs.prune(Number(args.flags.days || 14));
      log.ok(`已清理 ${n} 个旧任务`);
      return 0;
    },
    version: () => {
      console.log(VERSION);
      return 0;
    },
    help: () => {
      printHelp();
      return 0;
    },
  };

  const fn = commands[cmd];
  if (!fn) {
    log.err(`未知命令：${cmd}`);
    printHelp();
    return 2;
  }
  return await fn(args);
}

main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((e) => {
    log.err(e?.message || String(e));
    if (process.env.DEBUG) console.error(e);
    process.exitCode = 1;
  });
