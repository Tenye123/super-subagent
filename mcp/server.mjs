// dsh-fleet MCP server —— 把远程设备暴露成 DSH 的原生工具
//
// 协议：MCP over stdio（JSON-RPC 2.0，换行分隔）
// 零依赖：不引 @modelcontextprotocol/sdk，手写最小实现。
// 只用 initialize / tools/list / tools/call 三个方法，够用且稳定。

import readline from 'node:readline';

import * as cfg from '../lib/config.mjs';
import * as ssh from '../lib/ssh.mjs';
import * as rpcDispatch from '../lib/dispatch-rpc.mjs';
import * as jobs from '../lib/jobs.mjs';
import * as discover from '../lib/discover.mjs';
import * as beacon from '../lib/beacon.mjs';
import * as probe from '../lib/probe.mjs';
import { buildAgentScript } from '../lib/bootstrap-script.mjs';
import { log } from '../lib/util.mjs';

const PROTOCOL_VERSION = '2024-11-05';
// 我们声明"支持这些版本"。initialize 时优先回显客户端请求的版本 ——
// DSH 的 MCP SDK 会协商 2026-07-28 再回退到 legacy revision，
// 硬返回单一版本会让协商多绕一轮甚至失败。
const SUPPORTED = ['2026-07-28', '2025-11-25', '2025-06-18', '2024-11-05'];
const SERVER_INFO = { name: 'dsh-fleet', version: '0.1.0' };

function negotiateVersion(requested) {
  if (requested && SUPPORTED.includes(requested)) return requested;
  // 未知版本：回一个我们确定的，让客户端自己决定是否接受
  return PROTOCOL_VERSION;
}

/* ---------------- 工具定义 ---------------- */

function toolDefs() {
  return [
    {
      name: 'fleet_list_devices',
      description:
        '列出所有可用的远程设备（超级子代理）。返回设备名、IP、有效期。派活前先用它确认目标在线且未被撤销。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'fleet_ping',
      description:
        '测试某台设备是否可达。派重活前先 ping，避免任务卡在连接超时上。',
      inputSchema: {
        type: 'object',
        properties: {
          device: { type: 'string', description: '设备名，例如 laptop-a（等价写法 name 也接受）' },
          name: { type: 'string', description: 'device 的别名；只需提供其中一个' },
        },
        // 不把 device 列为 required：name 是等价别名，模型给哪个都行。
        // 真正缺参的判定放在 callTool 里，这样能给出更清楚的错误信息。
      },
    },
    {
      name: 'fleet_run_task',
      description:
        '在远程设备上执行一个 DSH 任务并等待完成。设备上的 agent 拥有它自己的文件系统、shell 和网络位置——它是"有自己设备的子代理"，不是远程 shell。\n\n' +
        '何时用：需要目标机器的本地环境（代码库、内网、已装工具、浏览器登录态）或需要消耗目标机器的算力时。\n' +
        '何时不用：纯文本推理、你自己的小文件操作。\n\n' +
        '任务描述要带上验收标准，让远程 agent 能自己判断做完没有。',
      inputSchema: {
        type: 'object',
        properties: {
          device: { type: 'string', description: '设备名' },
          task: { type: 'string', description: '完整任务描述，含目标与验收标准' },
          cwd: { type: 'string', description: '远端工作目录（可选）' },
          session: { type: 'string', description: '续接已有会话的 id（可选）' },
          timeoutMs: { type: 'number', description: '超时毫秒数，默认 1800000（30 分钟）' },
        },
        required: ['device', 'task'],
      },
    },
    {
      name: 'fleet_scan',
      description:
        '扫描 tailnet，列出所有可见的电脑并判断哪些能派活。\n\n' +
        '为什么需要它：设备"在 tailnet 里"和"能派活"是两件事。一台机器可能在线（tailscale 看得到），' +
        '但 sshd 没起来、或者 DSH 桌面端没启动，这两种情况派活都会失败。\n\n' +
        '返回的每台设备带 state 字段：\n' +
        '  ready        —— 可以派活\n' +
        '  no-dsh       —— SSH 通但那边没开 DSH 桌面端\n' +
        '  unreachable  —— SSH 端口连不上\n' +
        '  unprobed     —— 在线但未登记，未做完整探测\n' +
        '  offline      —— 不在线',
      inputSchema: {
        type: 'object',
        properties: {
          registeredOnly: {
            type: 'boolean',
            description: '只看已登记的设备（默认 false，即扫描整个 tailnet）',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'fleet_add_device',
      description:
        '为一台新电脑生成接入命令。返回一段可以在目标机器上以管理员身份执行的 PowerShell 命令，' +
        '跑完之后那台机器会自动出现在设备列表里，不需要手工配 IP、密钥或公钥。\n\n' +
        '适用场景：用户说"再加一台机器"、"把 XX 接进来"、"怎么接新设备"。\n\n' +
        '生成的是命令文本，不是执行结果——需要用户自己去目标机器上运行。',
      inputSchema: {
        type: 'object',
        properties: {
          agentName: { type: 'string', description: '设备显示名（留空则用对方主机名）' },
          sshPort: { type: 'number', description: 'SSH 端口，默认 22' },
          tailscaleAuthKey: {
            type: 'string',
            description: '可选。Tailscale 授权密钥，填了就不用在那台机器上做浏览器登录',
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'fleet_jobs',
      description: '列出历史任务及其状态。',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '返回条数，默认 20' },
          device: { type: 'string', description: '只看某台设备' },
          state: {
            type: 'string',
            enum: ['queued', 'running', 'done', 'failed', 'cancelled'],
            description: '只看某个状态',
          },
        },
      },
    },
  ];
}

/* ---------------- 工具实现 ---------------- */

async function callTool(name, args) {
  const config = cfg.loadConfig();

  switch (name) {
    case 'fleet_list_devices': {
      if (config.role !== 'controller') {
        throw new Error('本机不是主控，无法列出设备。先运行：fleet init --role controller');
      }
      const active = cfg.activeDevices(config);
      return {
        content: [
          {
            type: 'text',
            text: active.length
              ? active
                  .map(
                    (d) =>
                      `- ${d.name}  ${d.user}@${d.tailscaleIp}` +
                      (d.expiresAt ? `  到期 ${d.expiresAt.slice(0, 10)}` : '  永久')
                  )
                  .join('\n')
              : '没有可用设备。在目标机器上装好 dsh-fleet，再用 fleet enroll 纳管。',
          },
        ],
      };
    }

    case 'fleet_ping': {
      // `name` is accepted as an alias for `device`: the CLI spells it
      // `fleet ping --name laptop-a`, and a model reading tool descriptions
      // very naturally writes {"name": "laptop-a"}. Rejecting that with a
      // "no such device: undefined" message (which is what happened before)
      // is a confusing failure caused purely by naming, not by anything real.
      const target = args.device ?? args.name;
      if (!target) throw new Error('缺少参数：需要 device（或别名 name），例如 {"device":"laptop-a"}');
      const dev = cfg.findDevice(config, target);
      if (!dev) throw new Error(`没有这台设备：${target}`);
      const t0 = Date.now();
      const r = ssh.ping(dev);
      const ms = Date.now() - t0;
      if (r.ok) {
        dev.lastSeenAt = new Date().toISOString();
        dev.lastError = null;
        cfg.saveConfig(config);
        return { content: [{ type: 'text', text: `${dev.name} 可达，${ms}ms` }] };
      }
      dev.lastError = r.error;
      cfg.saveConfig(config);
      return {
        isError: true,
        content: [{ type: 'text', text: `${dev.name} 不可达：${r.error}` }],
      };
    }

    case 'fleet_run_task': {
      // Same `name` alias as fleet_ping -- see the note there.
      const target = args.device ?? args.name;
      if (!target) throw new Error('缺少参数：需要 device（或别名 name），例如 {"device":"laptop-a"}');
      if (!args.task) throw new Error('缺少参数：需要 task（完整任务描述，含验收标准）');
      const dev = cfg.findDevice(config, target);
      if (!dev) throw new Error(`没有这台设备：${target}`);
      if (dev.revoked) throw new Error(`设备已撤销：${target}`);
      if (dev.expiresAt && Date.parse(dev.expiresAt) < Date.now()) {
        throw new Error(`设备授权已过期：${target}（${dev.expiresAt.slice(0, 10)}）`);
      }

      const job = jobs.createJob({
        device: target,
        task: args.task,
        cwd: args.cwd || null,
        session: args.session || null,
        timeoutMs: args.timeoutMs || 1_800_000,
      });
      jobs.markRunning(job);

      // 走桌面端的 Connection RPC，而不是 headless 打印模式。
      //
      // 差别在于会话的归属：headless 跑完即弃，会话不登记进任何 workspace，
      // 于是那台机器上打开 DSH 界面看不到这次工作；RPC 由应用自己建会话，
      // 所以它会出现在界面上，人可以直接接着聊。
      let r;
      try {
        r = await rpcDispatch.dispatch(dev, args.task, {
          cwd: job.cwd || dev.workspace,
          timeoutMs: job.timeoutMs,
        });
      } catch (e) {
        const reason = e && e.message ? e.message : String(e);
        jobs.markDone(job, { exitCode: 1, error: reason });
        return {
          isError: true,
          content: [{ type: 'text', text: `任务失败（${dev.name}）：${reason}` }],
        };
      }

      if (!r.accepted) {
        const reason = '远端未接受任务（会话可能已关闭或正忙）';
        jobs.markDone(job, { exitCode: 1, sessionId: r.sessionId, error: reason });
        return {
          isError: true,
          content: [{ type: 'text', text: `任务失败（${dev.name}）：${reason}` }],
        };
      }

      if (!r.finished) {
        const reason = `等待 ${Math.round(job.timeoutMs / 1000)} 秒后本轮仍未结束。会话仍在运行，可稍后用同一会话续看。`;
        jobs.markDone(job, {
          exitCode: -1,
          sessionId: r.sessionId,
          summary: r.answer,
          error: reason,
        });
        return {
          isError: true,
          content: [{
            type: 'text',
            text: `任务未完成（${dev.name}）：${reason}\nsession: ${r.sessionId}${r.answer ? '\n\n已产出的内容：\n' + r.answer : ''}`,
          }],
        };
      }

      jobs.markDone(job, {
        exitCode: 0,
        sessionId: r.sessionId,
        summary: r.answer,
        final: r.answer,
        toolCalls: 0,
        error: null,
      });

      const header = `[${dev.name}] job ${job.id} · session ${r.sessionId} · 已登记进工作区`;
      return {
        content: [{ type: 'text', text: `${header}\n\n${r.answer || '(远程未返回文本)'}` }],
      };
    }

    case 'fleet_scan': {
      const { devices, error } = discover.listTailnetDevices();
      if (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: '无法扫描 tailnet：' + error }],
        };
      }

      const registered = cfg.activeDevices(config);
      const byIp = new Map(registered.map((d) => [d.tailscaleIp, d]));

      // 探哪些：默认探所有在线且已登记的。未登记的没密钥，探了也只能
      // 得出"SSH 通但进不去"，那个结论没有行动价值，所以只标 unprobed。
      const targets = devices
        .filter((t) => t.online && byIp.has(t.tailscaleIp))
        .map((t) => ({ ...byIp.get(t.tailscaleIp), tailscaleIp: t.tailscaleIp }));

      const probed = new Map();
      if (targets.length) {
        const results = await discover.probeAll(targets, { concurrency: 3 });
        for (const r of results) probed.set(r.tailscaleIp, r);
      }

      const rows = devices
        .filter((t) => {
          if (!args?.registeredOnly) return true;
          return byIp.has(t.tailscaleIp);
        })
        .map((t) => {
          const p = probed.get(t.tailscaleIp);
          const enrolled = byIp.has(t.tailscaleIp);
          const state = p ? p.state : t.online ? 'unprobed' : 'offline';
          return {
            name: (byIp.get(t.tailscaleIp) || {}).name || t.name,
            ip: t.tailscaleIp,
            os: t.os,
            online: t.online,
            enrolled,
            state,
            label: discover.stateLabel(state),
            detail: p ? p.detail : '',
          };
        });

      const sorted = discover.sortByState(rows);
      const counts = discover.summarizeStates(sorted);
      const lines = sorted.map(
        (r) =>
          `- ${r.name}  ${r.ip}  [${r.label}]` +
          (r.enrolled ? '' : '  未登记') +
          (r.os ? `  ${r.os}` : '') +
          (r.detail ? `\n    ${r.detail}` : ''),
      );

      // 只报非零的项。一堆 "离线 0" 只会让摘要变长而没有信息。
      const parts = [];
      const addIf = (n, label) => {
        if (n) parts.push(`${label} ${n}`);
      };
      addIf(counts.ready, '可派活');
      addIf(counts['no-dsh'], 'DSH 未启动');
      addIf(counts.unreachable, 'SSH 连不上');
      addIf(counts.offline, '离线');
      addIf(counts.unprobed, '未探测');
      addIf(counts['no-credential'], '凭据缺失');
      addIf(counts.error, '出错');

      return {
        content: [
          {
            type: 'text',
            text:
              `tailnet 里可见 ${sorted.length} 台` +
              (parts.length ? '：' + parts.join('，') : '') +
              '\n\n' +
              (lines.length ? lines.join('\n') : '(没有可见设备)'),
          },
        ],
      };
    }

    case 'fleet_add_device': {
      const info = probe.tailscaleInfo();
      if (!info.up) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: '本机 Tailscale 未连接，无法生成接入命令。先确认 tailscale up。',
          }],
        };
      }
      const selfIp = info.ips.find((x) => x.includes('.'));
      if (!selfIp) {
        return {
          isError: true,
          content: [{ type: 'text', text: '本机没有 tailnet IPv4 地址，无法生成接入命令。' }],
        };
      }

      // 控制端公钥：没有就现生成，与插件的规则保持一致。
      let pubKey = '';
      try {
        const kp = cfg.PATHS.keys + '/controller.key.pub';
        const fs = await import('node:fs');
        if (fs.existsSync(kp)) pubKey = fs.readFileSync(kp, 'utf8').trim();
        else {
          const r = cfg.generateKeyPair('controller');
          pubKey = fs.readFileSync(r.publicKey, 'utf8').trim();
        }
      } catch (e) {
        return {
          isError: true,
          content: [{ type: 'text', text: '无法准备控制端密钥：' + String(e.message || e) }],
        };
      }

      const token = beacon.createToken();
      const script = buildAgentScript({
        controllerIp: selfIp,
        beaconPort: 47321,
        token,
        controllerPubKey: pubKey,
        agentName: args?.agentName || '',
        sshPort: Number(args?.sshPort) || 22,
        tailscaleAuthKey: args?.tailscaleAuthKey || '',
      });

      // 注意：这里返回的是完整脚本，不是一行命令。
      // 命令行方式需要插件在跑（脚本由插件的 /setup.ps1 下发），而 MCP
      // 可能在没有插件的场合被调用，所以给完整的、自包含的脚本更可靠。
      return {
        content: [
          {
            type: 'text',
            text:
              `在目标电脑上以**管理员身份**打开 PowerShell，把下面整段保存为 setup-agent.ps1 并执行：\n` +
              `  powershell -ExecutionPolicy Bypass -File .\\setup-agent.ps1\n\n` +
              `它做六件事：装 Node / 装 OpenSSH Server / 装 Tailscale / 写入控制端公钥 / ` +
              `把 sshd 绑到 tailnet 地址 / 最后自动向控制端报名。跑完会自动出现在设备列表里。\n\n` +
              `如果控制端的 DSH 面板正在运行，也可以直接用一行命令（更快）：\n` +
              `  打开「设置 → 超级子代理 → 添加设备」复制那条命令。\n\n` +
              `----- 脚本开始 -----\n${script}`,
          },
        ],
      };
    }

    case 'fleet_jobs': {
      const list = jobs.listJobs({
        limit: args?.limit || 20,
        device: args?.device || null,
        state: args?.state || null,
      });
      return {
        content: [
          {
            type: 'text',
            text: list.length
              ? list
                  .map(
                    (j) =>
                      `${j.id}  ${j.device.padEnd(14)} ${j.state.padEnd(9)} ${(j.summary || j.error || '').slice(0, 60)}`
                  )
                  .join('\n')
              : '还没有任务记录',
          },
        ],
      };
    }

    default:
      throw new Error(`未知工具：${name}`);
  }
}

/* ---------------- JSON-RPC 传输 ---------------- */

let nextId = 0;

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

async function handle(msg) {
  const { id, method, params } = msg;

  // 通知类消息没有 id，不需要回复
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: negotiateVersion(params?.protocolVersion),
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;

    case 'notifications/initialized':
      return; // 通知，不回

    case 'tools/list':
      reply(id, { tools: toolDefs() });
      return;

    case 'tools/call': {
      const { name, arguments: args } = params || {};
      try {
        const result = await callTool(name, args || {});
        reply(id, result);
      } catch (e) {
        // 工具级错误用 isError 返回，让模型能看到并自行纠正
        reply(id, {
          isError: true,
          content: [{ type: 'text', text: e.message || String(e) }],
        });
      }
      return;
    }

    case 'ping':
      reply(id, {});
      return;

    case 'shutdown':
      if (!isNotification) reply(id, {});
      process.exit(0);
      return;

    default:
      if (!isNotification) {
        replyError(id, -32601, `未实现的方法：${method}`);
      }
  }
}

function main() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  // stdin 的 EOF 不代表活干完了。
  //
  // 客户端常常把请求写进 stdin 就关掉管道，此时 'close' 立刻触发，而
  // 派活是异步的、可能还要跑几分钟。若无条件 process.exit(0)，进程会
  // 在任务中途被杀，表现是「客户端只收到 initialize 的回复，tools/call
  // 永远没有下文」——看起来像协议不兼容，其实是被自己杀了。
  //
  // 所以这里记账：只有既收到了 EOF、又没有在飞的调用时，才退出。
  let inFlight = 0;
  let ended = false;

  function maybeExit() {
    if (ended && inFlight === 0) process.exit(0);
  }

  rl.on('line', (line) => {
    const s = line.trim();
    if (!s) return;
    let msg;
    try {
      msg = JSON.parse(s);
    } catch {
      replyError(null, -32700, 'JSON 解析失败');
      return;
    }
    inFlight++;
    handle(msg)
      .catch((e) => {
        const id = msg?.id ?? null;
        if (id !== null && id !== undefined) replyError(id, -32603, e.message || '内部错误');
      })
      .finally(() => {
        inFlight--;
        maybeExit();
      });
  });

  rl.on('close', () => {
    ended = true;
    maybeExit();
  });

  // stdout 只走协议，日志必须去 stderr
  console.error('[dsh-fleet] MCP server ready on stdio');
}

main();
