// 上传文件类型限制：教师可在后台配置允许上传的扩展名（白名单）。
// 留空表示不限制；非空时，WWW / FTP / 邮件附件三个上传入口都会校验文件名后缀。
import { db } from '../db.js';

const KEY = 'upload_allowed_extensions';

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
