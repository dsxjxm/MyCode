import { DatabaseSync } from 'node:sqlite';
import { DB_FILE, ensureDirs } from './paths.js';
import { hashPassword } from './password.js';

ensureDirs();

export const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS teachers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  grade TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  folder TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  student_no TEXT NOT NULL,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  folder TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  site_enabled INTEGER NOT NULL DEFAULT 1,
  directory_browsing INTEGER NOT NULL DEFAULT 1,
  default_docs TEXT NOT NULL DEFAULT '["index.html","index.htm"]',
  mime_types TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_students_class_no ON students(class_id, student_no);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id INTEGER NOT NULL,
  class_id INTEGER,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);

function now() {
  return new Date().toISOString();
}

const teacherCount = db.prepare('SELECT COUNT(*) AS c FROM teachers').get().c;
if (teacherCount === 0) {
  db.prepare(
    'INSERT INTO teachers (username, name, password_hash, created_at) VALUES (?, ?, ?, ?)'
  ).run('admin', '系统管理员', hashPassword('admin123'), now());
}

export { now };
