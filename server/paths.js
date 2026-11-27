import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// 同时兼容 ESM 源码运行与打包后的 CJS 运行
const here = typeof __dirname === 'undefined'
  ? path.dirname(fileURLToPath(import.meta.url))
  : __dirname;

export const ROOT = path.resolve(here, '..');

// 优先使用可写的本地 data/ 目录（便于本地部署持久化）；
// 云端运行目录只读时自动回退到 TMPDIR。
function pickDataDir() {
  if (process.env.DATA_DIR) return path.resolve(process.env.DATA_DIR);
  const localData = path.join(ROOT, 'data');
  try {
    fs.mkdirSync(localData, { recursive: true });
    fs.accessSync(localData, fs.constants.W_OK);
    return localData;
  } catch (_) {
    const tmpdir = process.env.TMPDIR || process.env.TEMP || '/tmp';
    return path.resolve(tmpdir, 'lan-sim-data');
  }
}

export const DATA_DIR = pickDataDir();
export const CLASSES_DIR = path.join(DATA_DIR, 'classes');
export const TRASH_DIR = path.join(DATA_DIR, '_trash');
export const MAIL_ATTACH_DIR = path.join(DATA_DIR, 'mail-attachments');
export const ARCHIVE_DIR = path.join(DATA_DIR, 'archives');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const DB_FILE = path.join(DATA_DIR, 'platform.db');

export function ensureDirs() {
  for (const dir of [DATA_DIR, CLASSES_DIR, TRASH_DIR, MAIL_ATTACH_DIR, ARCHIVE_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
