// dsh-fleet —— 任务队列（SQLite 太重，用目录 + JSON 文件，零依赖）

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureDir, readJson, writeJson } from './util.mjs';
import { PATHS } from './config.mjs';

const STATES = ['queued', 'running', 'done', 'failed', 'cancelled'];

export function newJobId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

function jobDir(jobId) {
  return path.join(PATHS.jobs, jobId);
}

export function createJob({ device, task, cwd, session, timeoutMs }) {
  const id = newJobId();
  const dir = ensureDir(jobDir(id));
  const job = {
    id,
    device,
    task,
    cwd: cwd || null,
    session: session || null,
    timeoutMs: timeoutMs || 1_800_000,
    state: 'queued',
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    sessionId: null,
    summary: null,
    final: null,
    toolCalls: 0,
    error: null,
    eventsFile: path.join(dir, 'events.ndjson'),
    logFile: path.join(dir, 'stderr.log'),
  };
  writeJson(path.join(dir, 'job.json'), job);
  return job;
}

export function saveJob(job) {
  writeJson(path.join(jobDir(job.id), 'job.json'), job);
  return job;
}

export function loadJob(id) {
  return readJson(path.join(jobDir(id), 'job.json'), null);
}

export function listJobs({ limit = 50, state = null, device = null } = {}) {
  // 只读操作不该创建目录 —— 否则 `fleet jobs` 这种纯查询命令
  // 会在用户主目录里留下一个空壳，显得像装了什么。
  if (!fs.existsSync(PATHS.jobs)) return [];
  const dirs = fs
    .readdirSync(PATHS.jobs, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse();

  const out = [];
  for (const name of dirs) {
    if (out.length >= limit) break;
    const j = readJson(path.join(PATHS.jobs, name, 'job.json'), null);
    if (!j) continue;
    if (state && j.state !== state) continue;
    if (device && j.device !== device) continue;
    out.push(j);
  }
  return out;
}

export function markRunning(job) {
  job.state = 'running';
  job.startedAt = new Date().toISOString();
  return saveJob(job);
}

export function markDone(job, { exitCode, sessionId, summary, final, toolCalls, error }) {
  job.state = exitCode === 0 && !error ? 'done' : 'failed';
  job.finishedAt = new Date().toISOString();
  job.exitCode = exitCode;
  job.sessionId = sessionId ?? job.sessionId;
  job.summary = summary ?? null;
  job.final = final ?? null;
  job.toolCalls = toolCalls ?? job.toolCalls;
  job.error = error ?? null;
  return saveJob(job);
}

export function markCancelled(job, reason = '用户取消') {
  job.state = 'cancelled';
  job.finishedAt = new Date().toISOString();
  job.error = reason;
  return saveJob(job);
}

export function isValidState(s) {
  return STATES.includes(s);
}

/** 清理超过 N 天的已完成任务 */
export function prune(days = 14) {
  ensureDir(PATHS.jobs);
  const cutoff = Date.now() - days * 86_400_000;
  let removed = 0;
  for (const d of fs.readdirSync(PATHS.jobs, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = path.join(PATHS.jobs, d.name);
    const j = readJson(path.join(dir, 'job.json'), null);
    if (!j) continue;
    if (j.state === 'running') continue;
    const t = Date.parse(j.finishedAt || j.createdAt);
    if (t < cutoff) {
      fs.rmSync(dir, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}
