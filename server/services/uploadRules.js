// 上传规则：教师可在后台配置文件类型白名单与各模块单文件大小上限。
import { db } from '../db.js';

const KEY = 'upload_allowed_extensions';
const SIZE_KEY = 'upload_file_size_limit';
const SIZE_MODULES = ['www', 'terminal', 'mail', 'students'];
const DEFAULT_SIZE_CONFIG = {
  enabled: true,
  valuesMiB: { www: 20, terminal: 10, mail: 10, students: 10 }
};

export function parseExtensionList(input) {
  const raw = Array.isArray(input) ? input.join(',') : String(input || '');
  const list = [];
  const seen = Object.create(null);
  for (const part of raw.split(/[\s,;，；]+/)) {
    const ext = part.trim().replace(/^\.+/, '').toLowerCase();
    if (!ext) continue;
    // 只接受常见的纯字母/数字扩展名，过滤掉奇怪字符
    if (!/^[a-z0-9][a-z0-9_-]{0,15}$/.test(ext)) continue;
    if (seen[ext]) continue;
    seen[ext] = true;
    list.push(ext);
  }
  return list;
}

export function getAllowedExtensions() {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(KEY);
  return row ? parseExtensionList(row.value) : [];
}

export function saveAllowedExtensions(input) {
  const list = parseExtensionList(input);
  const value = list.join(',');
  const exists = db.prepare('SELECT 1 AS x FROM app_settings WHERE key = ?').get(KEY);
  if (exists) {
    db.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run(value, KEY);
  } else {
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run(KEY, value);
  }
  return list;
}

function defaultSizeConfig() {
  return { enabled: true, valuesMiB: { ...DEFAULT_SIZE_CONFIG.valuesMiB } };
}

export function validateUploadFileSizeConfig(input) {
  if (!input || typeof input !== 'object' || typeof input.enabled !== 'boolean') {
    throw new Error('上传大小限制开关格式不正确');
  }
  const values = input.valuesMiB;
  if (!values || typeof values !== 'object') throw new Error('请设置各模块上传大小');
  const config = { enabled: input.enabled, valuesMiB: {} };
  for (const module of SIZE_MODULES) {
    const value = values[module];
    if (!Number.isInteger(value) || value < 1 || value > 1024) {
      throw new Error('各模块上传大小须为 1～1024 MiB 的整数');
    }
    config.valuesMiB[module] = value;
  }
  return config;
}

export function getUploadFileSizeConfig() {
  const config = defaultSizeConfig();
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(SIZE_KEY);
  if (!row) return config;
  try {
    const saved = JSON.parse(row.value);
    if (saved && typeof saved.enabled === 'boolean') config.enabled = saved.enabled;
    const values = saved && saved.valuesMiB;
    for (const module of SIZE_MODULES) {
      const value = values && values[module];
      if (Number.isInteger(value) && value >= 1 && value <= 1024) {
        config.valuesMiB[module] = value;
      }
    }
  } catch (_) {
    // 损坏配置安全回退到默认限制，避免意外关闭限制。
  }
  return config;
}

export function saveUploadFileSizeConfig(input) {
  const config = validateUploadFileSizeConfig(input);
  const value = JSON.stringify(config);
  const exists = db.prepare('SELECT 1 AS x FROM app_settings WHERE key = ?').get(SIZE_KEY);
  if (exists) {
    db.prepare('UPDATE app_settings SET value = ? WHERE key = ?').run(value, SIZE_KEY);
  } else {
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run(SIZE_KEY, value);
  }
  return config;
}

export function getUploadFileSizeBytes(module) {
  const config = getUploadFileSizeConfig();
  if (!config.enabled) return Infinity;
  return config.valuesMiB[module] * 1024 * 1024;
}

export function extensionOf(name) {
  const base = String(name || '')
    .split(/[\\/]/)
    .pop();
  const idx = base.lastIndexOf('.');
  if (idx <= 0 || idx === base.length - 1) return '';
  return base.slice(idx + 1).toLowerCase();
}

// 返回 { ok, ext, allowed, error }
export function checkUploadName(name) {
  const allowed = getAllowedExtensions();
  const ext = extensionOf(name);
  if (!allowed.length) return { ok: true, ext, allowed };
  if (!ext) {
    return {
      ok: false,
      ext,
      allowed,
      error: '不允许上传无扩展名的文件（教师已限制上传类型）'
    };
  }
  if (allowed.indexOf(ext) === -1) {
    return {
      ok: false,
      ext,
      allowed,
      error: `不允许上传 .${ext} 类型文件（教师已限制上传类型）`
    };
  }
  return { ok: true, ext, allowed };
}
