// Decode a DSH session transcript and report what is inside it.
//
// TWO TRAPS, both of which made intact data look corrupt:
//
//  1. zlib.zstdDecompressSync decompresses only the FIRST frame. A 9 MB
//     transcript decoded to 209 bytes and one record.
//  2. createZstdDecompress has the same behaviour -- it stops after the first
//     frame rather than walking the concatenation.
//
// DSH appends one independent zstd frame per record, so a transcript is a
// concatenation of thousands of frames (5206 in the largest one here). The
// decoder therefore has to find each frame boundary by its magic number
// (28 B5 2F FD) and decompress frame by frame.
//
// The decompressed payload is JSONL: one JSON object per line.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

// 默认指向当前用户的 DSH 会话目录；也可以在命令行给第一个参数覆盖。
const root = process.argv[2] || path.join(os.homedir(), '.dsh', 'sessions');
const MAGIC = [0x28, 0xB5, 0x2F, 0xFD];

function walk(dir, acc = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.jsonl.zstd')) acc.push(p);
  }
  return acc;
}

function frameOffsets(buf) {
  const out = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] &&
        buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) out.push(i);
  }
  return out;
}

// Concatenate the decompressed payload of every frame.
function decode(buf) {
  const off = frameOffsets(buf);
  if (off.length === 0) throw new Error('no zstd frames');
  const parts = [];
  let bad = 0;
  for (let i = 0; i < off.length; i++) {
    const end = i + 1 < off.length ? off[i + 1] : buf.length;
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(off[i], end)));
    } catch { bad++; }
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: off.length, bad };
}

const files = walk(root).map((f) => ({ f, size: fs.statSync(f).size }));
console.log('transcripts found: ' + files.length);

const sample = files.sort((a, b) => b.size - a.size).slice(0, 3)
  .concat(files.slice(0, 2).map((x) => ({ f: x.f, size: x.size })));

const seen = new Set();
let checked = 0, failed = 0, totalRecords = 0, totalText = 0;

for (const item of sample) {
  if (seen.has(item.f)) continue;
  seen.add(item.f);
  checked++;
  const rel = item.f.replace(root, '');

  let res;
  try {
    res = decode(fs.readFileSync(item.f));
  } catch (e) {
    failed++;
    console.log('  FAIL ' + rel + ' -> ' + e.message);
    continue;
  }

  const lines = res.text.split(/\r?\n/).filter((l) => l.trim());
  totalRecords += lines.length;
  totalText += res.text.length;

  // Show that real conversation text is present, not just bookkeeping records.
  const samples = [];
  let roles = 0;
  for (const l of lines) {
    try {
      const o = JSON.parse(l);
      if (o.role || (o.message && o.message.role)) roles++;
      const s = JSON.stringify(o);
      const m = s.match(/"(?:text|content)":"((?:[^"\\]|\\.){40,400})"/);
      if (m && samples.length < 2) {
        samples.push(m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"').slice(0, 110));
      }
    } catch { /* counts already reflect a bad line */ }
  }

  console.log('  OK   ' + rel);
  console.log('        ' + (item.size / 1048576).toFixed(2) + ' MB / ' + res.frames + ' frames'
    + ' (bad=' + res.bad + ') -> ' + (res.text.length / 1048576).toFixed(2) + ' MB, '
    + lines.length + ' records, ' + roles + ' with role');
  for (const s of samples) console.log('        > ' + s);
}

console.log('');
console.log('checked=' + checked + ' failed=' + failed
  + ' totalRecords=' + totalRecords + ' totalTextMB=' + (totalText / 1048576).toFixed(2));
console.log(failed === 0 && totalRecords > 100
  ? 'VERDICT: transcripts decode and contain real conversation'
  : 'VERDICT: PROBLEM');
