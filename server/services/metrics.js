// 运行监控：请求耗时统计、在线用户、慢请求、系统负载与数据库大小。
// 全部为进程内轻量统计，不依赖外部监控组件。
import os from 'node:os';
import fs from 'node:fs';
import { DB_FILE } from '../paths.js';
import { loginQueueStats } from './loginQueue.js';

const MAX_LATENCY_SAMPLES = 600;
const MAX_SLOW = 60;
const SLOW_THRESHOLD_MS = (() => {
  const n = Number(process.env.METRICS_SLOW_MS);
  return Number.isFinite(n) && n > 0 ? n : 500;
})();
const ONLINE_WINDOW_MS = 3 * 60 * 1000;
const RPS_WINDOW_MS = 60 * 1000;

const startedAt = Date.now();
let latencies = []; // 最近请求耗时（ms）
let slowRequests = []; // 最新在前
const onlineMap = new Map(); // key -> { role, id, name, username, lastSeen, ip }
let requestTimes = []; // RPS 窗口内的时间戳
let totalRequests = 0;
let errorRequests = 0;

let lastCpu = sampleCpuTimes();

function sampleCpuTimes() {
  const cpus = os.cpus() || [];
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const times = cpu.times || {};
    for (const key in times) total += times[key];
    idle += times.idle || 0;
  }
  return { idle, total };
}

function isTrackable(url) {
  if (!url) return false;
  if (url.startsWith('/assets') || url.startsWith('/vendor')) return false;
  if (url.startsWith('/favicon')) return false;
  return true;
}

function normalizePath(url) {
  const raw = String(url || '');
  const q = raw.indexOf('?');
  return q >= 0 ? raw.slice(0, q) : raw;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || '';
}

function userKey(user) {
  return `${user.role}:${user.id}`;
}

export function metricsMiddleware(req, res, next) {
  if (!isTrackable(req.originalUrl || req.url)) return next();
  const start = process.hrtime();

  // 在线用户：只要带着有效登录态发请求就记为在线
  if (req.user) {
    const key = userKey(req.user);
    onlineMap.set(key, {
      role: req.user.role,
      id: req.user.id,
      name: req.user.name || '',
      username: req.user.username || '',
      lastSeen: Date.now(),
      ip: clientIp(req)
    });
  }

  res.on('finish', () => {
    const diff = process.hrtime(start);
    const ms = diff[0] * 1000 + diff[1] / 1e6;
    totalRequests += 1;
    if (res.statusCode >= 500) errorRequests += 1;

    latencies.push(ms);
    if (latencies.length > MAX_LATENCY_SAMPLES) latencies.shift();

    const nowMs = Date.now();
    requestTimes.push(nowMs);
    // 只在窗口边界做一次裁剪，避免每个请求都过滤
    if (requestTimes.length > 1 && nowMs - requestTimes[0] > RPS_WINDOW_MS) {
      pruneRequestTimes(nowMs);
    }

    if (ms >= SLOW_THRESHOLD_MS && res.statusCode !== 202) {
      slowRequests.unshift({
        method: req.method,
        path: normalizePath(req.originalUrl || req.url),
        status: res.statusCode,
        ms: Math.round(ms),
        at: new Date(nowMs).toISOString(),
        user: req.user ? `${req.user.name || ''}(${req.user.role === 'teacher' ? '教师' : '学生'})` : '未登录',
        ip: clientIp(req)
      });
      if (slowRequests.length > MAX_SLOW) slowRequests.pop();
    }
  });

  next();
}

function pruneRequestTimes(nowMs) {
  const cutoff = nowMs - RPS_WINDOW_MS;
  if (requestTimes.length && requestTimes[0] < cutoff) {
    requestTimes = requestTimes.filter((t) => t >= cutoff);
  }
}

function pruneOnline(nowMs) {
  const cutoff = nowMs - ONLINE_WINDOW_MS;
  for (const [key, value] of onlineMap) {
    if (value.lastSeen < cutoff) onlineMap.delete(key);
  }
}

function summarizeLatency() {
  if (!latencies.length) {
    return { count: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  }
  const sorted = latencies.slice().sort((a, b) => a - b);
  const sum = sorted.reduce((acc, n) => acc + n, 0);
  const pick = (pct) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * pct))];
  return {
    count: sorted.length,
    avg: Math.round(sum / sorted.length),
    p50: Math.round(pick(0.5)),
    p95: Math.round(pick(0.95)),
    p99: Math.round(pick(0.99)),
    max: Math.round(sorted[sorted.length - 1])
  };
}

function cpuPercent() {
  const current = sampleCpuTimes();
  const idleDiff = current.idle - lastCpu.idle;
  const totalDiff = current.total - lastCpu.total;
  lastCpu = current;
  if (totalDiff <= 0) return 0;
  const usage = (1 - idleDiff / totalDiff) * 100;
  return Math.max(0, Math.min(100, Math.round(usage)));
}

function dbSize() {
  try {
    return fs.statSync(DB_FILE).size;
  } catch (_) {
    return 0;
  }
}

export function metricsSnapshot() {
  const nowMs = Date.now();
  pruneOnline(nowMs);
  pruneRequestTimes(nowMs);

  const online = Array.from(onlineMap.values()).sort((a, b) => b.lastSeen - a.lastSeen);
  const mem = process.memoryUsage();
  const load = os.loadavg();
  const cpus = os.cpus() || [];
  const latency = summarizeLatency();
  const rps = requestTimes.length / (RPS_WINDOW_MS / 1000);

  return {
    serverTime: new Date(nowMs).toISOString(),
    uptimeSec: Math.round((nowMs - startedAt) / 1000),
    online: {
      total: online.length,
      teachers: online.filter((u) => u.role === 'teacher').length,
      students: online.filter((u) => u.role === 'student').length,
      windowSec: ONLINE_WINDOW_MS / 1000,
      list: online.slice(0, 50).map((u) => ({
        role: u.role,
        name: u.name,
        username: u.username,
        lastSeen: u.lastSeen,
        ip: u.ip
      }))
    },
    traffic: {
      totalRequests,
      errorRequests,
      rps: Math.round(rps * 100) / 100,
      ...latency
    },
    slow: {
      thresholdMs: SLOW_THRESHOLD_MS,
      items: slowRequests.slice(0, 30)
    },
    system: {
      cpuPercent: cpuPercent(),
      cpuCount: cpus.length,
      load1: Math.round(load[0] * 100) / 100,
      load5: Math.round(load[1] * 100) / 100,
      load15: Math.round(load[2] * 100) / 100,
      memRss: mem.rss,
      memHeapUsed: mem.heapUsed,
      memTotal: os.totalmem(),
      memFree: os.freemem()
    },
    db: {
      sizeBytes: dbSize()
    },
    login: loginQueueStats()
  };
}
