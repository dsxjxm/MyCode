// 登录限流：密码校验是 CPU 密集型（scrypt），瞬时大量登录会打满线程池。
// 这里做「准入控制 + 客户端排队」：
//   - 并发未达阈值：立即放行；
//   - 超过阈值：立刻返回 202（queued），前端提示「请稍候」并按 retryAfterMs 自动重试，
//     形成排队效果，避免连接被长时间挂起。
// 阈值可用环境变量覆盖：LOGIN_MAX_CONCURRENT / LOGIN_RETRY_BASE_MS。
import { SYSTEM_PROFILE } from './systemProfile.js';

function positiveInt(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback;
}

const MAX_CONCURRENT = positiveInt(process.env.LOGIN_MAX_CONCURRENT, SYSTEM_PROFILE.loginConcurrency);
const BASE_RETRY_MS = positiveInt(process.env.LOGIN_RETRY_BASE_MS, 400);
const MAX_RETRY_MS = 3000;
const THROTTLE_WINDOW_MS = 2000;

let active = 0;
const counters = { total: 0, passed: 0, throttled: 0 };
// 记录最近 window 内被限流的时间戳，用于估算「排队人数」
let throttleTimes = [];

function pruneThrottle(nowMs) {
  const cutoff = nowMs - THROTTLE_WINDOW_MS;
  if (throttleTimes.length && throttleTimes[0] < cutoff) {
    throttleTimes = throttleTimes.filter((t) => t >= cutoff);
  }
}

export function acquireLoginSlot() {
  counters.total += 1;
  if (active < MAX_CONCURRENT) {
    active += 1;
    counters.passed += 1;
    return { ok: true };
  }
  counters.throttled += 1;
  const nowMs = Date.now();
  throttleTimes.push(nowMs);
  pruneThrottle(nowMs);
  const retryAfterMs = Math.min(
    MAX_RETRY_MS,
    Math.round(BASE_RETRY_MS + active * 60 + Math.random() * 250)
  );
  return { ok: false, retryAfterMs, queuedAhead: throttleTimes.length };
}

export function releaseLoginSlot() {
  if (active > 0) active -= 1;
}

// 包装一个登录处理函数：超阈值直接回 202，处理完自动释放名额
export function throttledLogin(handler) {
  return async function wrapped(req, res, next) {
    const slot = acquireLoginSlot();
    if (!slot.ok) {
      res.set('Retry-After', String(Math.ceil(slot.retryAfterMs / 1000)));
      return res.status(202).json({
        queued: true,
        retryAfterMs: slot.retryAfterMs,
        queuedAhead: slot.queuedAhead,
        message: '当前登录人数较多，请稍候…'
      });
    }
    try {
      return await handler(req, res, next);
    } finally {
      releaseLoginSlot();
    }
  };
}

export function loginQueueStats() {
  pruneThrottle(Date.now());
  return {
    active,
    queued: throttleTimes.length,
    maxConcurrent: MAX_CONCURRENT,
    total: counters.total,
    passed: counters.passed,
    throttled: counters.throttled
  };
}
