import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..');
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT, 'data');
export const CLASSES_DIR = path.join(DATA_DIR, 'classes');
export const TRASH_DIR = path.join(DATA_DIR, '_trash');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const DB_FILE = path.join(DATA_DIR, 'platform.db');

export function ensureDirs() {
  for (const dir of [DATA_DIR, CLASSES_DIR, TRASH_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
