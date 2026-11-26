import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..');

// 部署运行时文件系统只读，DATA_DIR 需指向可写的 TMPDIR
const tmpdir = process.env.TMPDIR || process.env.TEMP || '/tmp';
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(tmpdir, 'lan-sim-data');
export const CLASSES_DIR = path.join(DATA_DIR, 'classes');
export const TRASH_DIR = path.join(DATA_DIR, '_trash');
export const MAIL_ATTACH_DIR = path.join(DATA_DIR, 'mail-attachments');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const DB_FILE = path.join(DATA_DIR, 'platform.db');

export function ensureDirs() {
  for (const dir of [DATA_DIR, CLASSES_DIR, TRASH_DIR, MAIL_ATTACH_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
