// 运行环境自检：检测 CPU / 内存，并用与真实登录一致的 scrypt 参数做一次微基准，
// 据此自动选择性能档位，给出登录并发、线程池、写盘防抖等推荐配置。
// 所有配置均可被环境变量显式覆盖（见各消费方）。
import os from 'node:os';
import crypto from 'node:crypto';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// 用与 password.js 相同的 scrypt 参数（默认 N=16384, r=8, p=1, 64 字节）
function benchScrypt(samples) {
  const salt = crypto.randomBytes(16).toString('hex');
  const times = [];
  for (let i = 0; i < samples; i++) {
    const t0 = process.hrtime();
    try {
      crypto.scryptSync('benchmark-password', salt, 64);
    } catch (_) {
      return 120;
    }
    const diff = process.hrtime(t0);
    times.push(diff[0] * 1000 + diff[1] / 1e6);
  }
  times.sort((a, b) => a - b);
  return Math.round(times[Math.floor(times.length / 2)]);
}

function positiveInt(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback;
}

function detect() {
  const cpus = os.cpus() || [];
  const cores = cpus.length || 1;
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const cpuModel = String((cpus[0] && cpus[0].model) || 'Unknown').trim();
  const memGB = Math.round((totalMem / 1024 / 1024 / 1024) * 10) / 10;
  const freeMemGB = Math.round((freeMem / 1024 / 1024 / 1024) * 10) / 10;
  const scryptMs = benchScrypt(2);

  // 档位判定：核心数、内存、以及实测 scrypt 耗时共同决定
  let tier;
  let label;
  if (cores <= 2 || memGB < 4 || scryptMs > 160) {
    tier = 'low';
    label = '低配';
  } else if (cores <= 4 || memGB < 8 || scryptMs > 100) {
    tier = 'standard';
    label = '标准';
  } else {
    tier = 'high';
    label = '高性能';
  }

  let loginConcurrency;
  let uvThreadPoolSize;
  let persistDebounceMs;
  let slowThresholdMs;
  let suggestedVus;
  if (tier === 'low') {
    loginConcurrency = 2;
    uvThreadPoolSize = 4;
    persistDebounceMs = 400;
    slowThresholdMs = 800;
    suggestedVus = Math.max(10, cores * 10);
  } else if (tier === 'standard') {
    loginConcurrency = 6;
    uvThreadPoolSize = 6;
    persistDebounceMs = 300;
    slowThresholdMs = 500;
    suggestedVus = Math.max(20, cores * 15);
  } else {
    loginConcurrency = 8;
    uvThreadPoolSize = 8;
    persistDebounceMs = 200;
    slowThresholdMs = 300;
    suggestedVus = Math.max(40, cores * 20);
  }

  // 登录并发不超过核心数 2 倍，线程池不少于登录并发
  loginConcurrency = clamp(loginConcurrency, 2, Math.max(2, cores * 2));
  uvThreadPoolSize = clamp(Math.max(uvThreadPoolSize, loginConcurrency), 4, 16);

  return {
    tier,
    label,
    cpuModel,
    cpuCores: cores,
    totalMemGB: memGB,
    freeMemGB,
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    scryptMs,
    loginConcurrency: positiveInt(process.env.LOGIN_MAX_CONCURRENT, loginConcurrency),
    uvThreadPoolSize: positiveInt(process.env.UV_THREADPOOL_SIZE, uvThreadPoolSize),
    persistDebounceMs: positiveInt(process.env.DB_PERSIST_DEBOUNCE_MS, persistDebounceMs),
    slowThresholdMs: positiveInt(process.env.METRICS_SLOW_MS, slowThresholdMs),
    suggestedVus,
    detectedAt: new Date().toISOString()
  };
}

// 模块加载时执行一次（Node 会缓存模块，保证只检测一次）
export const SYSTEM_PROFILE = detect();
