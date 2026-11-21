// 远端信使：在 agent 机器上执行一次 Connection RPC 调用。
//
// 为什么要在远端跑一段程序，而不是从主控直接 HTTP 打过去：
//   桌面端只监听 127.0.0.1（这是有意的安全设计，不该为了派活去放开），
//   所以主控无法直接连它的端口。SSH 是我们已有的、经过加固的唯一入口。
//
// 为什么用 stdin 送请求体而不是命令行参数：
//   任务文本可以是任意内容——引号、换行、中文、反引号、$ 符号都有。
//   塞进命令行要经过 cmd → PowerShell → 程序三层引号解析，每一层都会坏。
//   stdin 是二进制的、不经过任何解析器，这类问题从根本上消失。
//
// ⚠️ 本文件刻意写成 CommonJS（require 而非 import）：它由主控以
//   `node -e "<source>"` 的形式在远端执行，而 `node -e` 按 CommonJS 求值，
//   静态 import 会直接报 "Cannot use import statement outside a module"。
//   写成 CJS 就不必落临时文件、不必动态 import，少一层出错空间。
//
// 协议：stdin 收 JSON，stdout 吐一行 JSON。

const http = require('node:http');

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

function call(req) {
  const { port, cookie, path: reqPath, body } = req;
  const authority = '127.0.0.1:' + port;
  const payload = body == null ? '' : JSON.stringify(body);

  return new Promise((resolve) => {
    const r = http.request({
      host: '127.0.0.1',
      port: Number(port),
      path: reqPath,
      method: 'POST',
      headers: {
        Host: authority,
        Cookie: cookie,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', (e) => resolve({ status: 0, body: '', error: String((e && e.message) || e) }));
    if (payload) r.write(payload);
    r.end();
  });
}

readStdin()
  .then((raw) => call(JSON.parse(raw)))
  .then((r) => process.stdout.write(JSON.stringify(r) + '\n'))
  .catch((e) => {
    process.stdout.write(JSON.stringify({ status: 0, body: '', error: String((e && e.message) || e) }) + '\n');
  });
