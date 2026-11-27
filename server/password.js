import crypto from 'node:crypto';
import { promisify } from 'node:util';

// 同步哈希/校验：仅用于创建账号、改密码、初始化种子等低频路径
const scryptAsync = promisify(crypto.scrypt);

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

// 异步校验：scrypt 走 libuv 线程池，多人同时登录时不再把事件循环卡住
export async function verifyPasswordAsync(password, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const expected = Buffer.from(hash, 'hex');
  if (!expected.length) return false;
  const candidate = await scryptAsync(String(password), salt, expected.length);
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}
