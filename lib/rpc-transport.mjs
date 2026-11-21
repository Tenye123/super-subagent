// 把 lib/rpc.mjs 的抽象请求接口接到远端 SSH 上。
//
// rpc.mjs 只关心「发一个 HTTP 请求到某个 127.0.0.1:port 并拿回文本」，
// 不关心那条连接是怎么建立的。这里给它两种实现：
//
//   · 远端（真实场景）—— 每次调用经 SSH 在 agent 机器上跑 rpc-remote.mjs
//   · 本机 —— 直接 HTTP，用于在主控上跑自测
//
// 远端脚本每次调用都重新传一遍：它很小（几百字节），传输成本远低于
// 维护一个长连接的状态机；而且 agent 机器上不留任何临时文件。

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const REMOTE_PROGRAM = fs.readFileSync(path.join(HERE, 'rpc-remote.mjs'), 'utf8');

/**
 * 让远端跑一段 node 程序，stdin 送内容，取回 stdout。
 *
 * 这里刻意不把程序内容拼进命令行：`node -` 从 stdin 读程序，
 * 于是命令行上只出现一个 `-`，没有任何需要转义的东西。
 */
export function makeRemoteTransport(sshExec, dev) {
  return async function request(reqPath, bodyText, { timeoutMs = 120_000 } = {}) {
    // 程序和请求体打包成一个 JSON，作为一个整体过 stdin。
    // stdin 不经过任何 shell 解析器，所以不需要转义。
    const envelope = JSON.stringify({ program: REMOTE_PROGRAM, reqPath, body: bodyText });

    const wrapped = 'node -';
    const res = sshExec(dev, wrapped, {
      timeout: timeoutMs,
      stdin: envelope,
    });

    if (res.code !== 0 && !res.stdout) {
      throw new Error('远端调用失败: ' + (res.stderr || res.error?.message || '未知错误').slice(0, 400));
    }
    const line = String(res.stdout).trim().split('\n').filter(Boolean).pop();
    if (!line) {
      throw new Error('远端没有输出（stderr: ' + String(res.stderr).slice(0, 300) + '）');
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error('远端输出不是 JSON: ' + line.slice(0, 300));
    }
    if (parsed.error) throw new Error('远端请求失败: ' + parsed.error);
    if (parsed.status !== 200) {
      throw new Error('HTTP ' + parsed.status + ': ' + String(parsed.body).slice(0, 400));
    }
    return parsed.body;
  };
}

/** 本机直连，用于自测；不需要 SSH。 */
export function makeLocalTransport(port) {
  return function request(reqPath, bodyText, { timeoutMs = 120_000 } = {}) {
    return new Promise((resolve, reject) => {
      const body = bodyText || '';
      const req = http.request({
        host: '127.0.0.1',
        port: Number(port),
        path: reqPath,
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => resolve(d));
      });
      req.on('timeout', () => { req.destroy(new Error('请求超时')); });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  };
}
