#!/usr/bin/env node
// 运行全部测试。
//
// 各测试文件的汇总行格式不统一（历史原因）：
//   · "N 通过, M 失败"            —— 多数脚本
//   · "ℹ pass N / ℹ fail M"       —— 用 node:test 的那几个
//   · "(pass=N fail=M)"           —— 后加的
// 只认一种会漏算，而漏算的表现是"总计数字变小"——看起来像有测试被悄悄
// 跳过，很难查。所以这里三种都认，并且**认不出汇总就判失败**，不静默略过。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const files = fs
  .readdirSync(HERE)
  .filter((f) => f.endsWith('-test.mjs'))
  .sort();

/** 从输出里提取 (pass, fail)；提取不到返回 null。 */
function parseSummary(out) {
  // "12 通过, 3 失败"
  let m = /(\d+)\s*通过,\s*(\d+)\s*失败/.exec(out);
  if (m) return { pass: Number(m[1]), fail: Number(m[2]) };

  // "ℹ pass 12" / "ℹ fail 0"  （node:test 的 TAP 摘要）
  const p = /^.*\bpass (\d+)\s*$/m.exec(out);
  const f = /^.*\bfail (\d+)\s*$/m.exec(out);
  if (p) return { pass: Number(p[1]), fail: f ? Number(f[1]) : 0 };

  // "(pass=6 fail=0)"
  m = /pass=(\d+)\s+fail=(\d+)/.exec(out);
  if (m) return { pass: Number(m[1]), fail: Number(m[2]) };

  return null;
}

let totalPass = 0;
let totalFail = 0;
const failures = [];

for (const file of files) {
  process.stdout.write(`\n${'─'.repeat(60)}\n${file}\n${'─'.repeat(60)}\n`);
  const r = spawnSync(process.execPath, [path.join(HERE, file)], {
    encoding: 'utf8',
    timeout: 600_000,
    env: process.env,
    windowsHide: true,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  process.stdout.write(out.endsWith('\n') ? out : out + '\n');

  const s = parseSummary(out);
  if (s) {
    totalPass += s.pass;
    totalFail += s.fail;
    if (r.status !== 0 && s.fail === 0) {
      // 数字说没问题但退出码非零 —— 两边不一致，按失败处理
      totalFail++;
      failures.push(`${file}（汇总显示 0 失败，但退出码 ${r.status}）`);
    }
  } else {
    totalFail++;
    failures.push(`${file}（没有可识别的汇总输出，退出码 ${r.status}）`);
  }
}

process.stdout.write(`\n${'='.repeat(60)}\n`);
process.stdout.write(`总计：${totalPass} 通过, ${totalFail} 失败\n`);
if (failures.length) {
  process.stdout.write('异常：\n' + failures.map((x) => `  - ${x}`).join('\n') + '\n');
}
process.stdout.write(`${'='.repeat(60)}\n`);

process.exit(totalFail === 0 ? 0 : 1);
