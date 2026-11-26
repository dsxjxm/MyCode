// sql.js 适配层：把 sql.js (WASM) 包装成 better-sqlite3 风格的 API
// 零原生依赖，任何 Node 版本 + 任何 glibc 都能跑
import initSqlJs from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_FILE, ensureDirs, DATA_DIR } from './paths.js';
import { hashPassword } from './password.js';
import { createClassFolder, createStudentFolder } from './storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
ensureDirs();

const SQL = await initSqlJs();

// 从文件加载已有数据库，不存在则新建
let innerDb;
if (fs.existsSync(DB_FILE)) {
  const buf = fs.readFileSync(DB_FILE);
  innerDb = new SQL.Database(new Uint8Array(buf));
} else {
  innerDb = new SQL.Database();
}

// 写操作后持久化到文件（sql.js 是内存 DB）
function persist() {
  try {
    const data = innerDb.export();
    fs.writeFileSync(DB_FILE, Buffer.from(data));
  } catch (e) {
    console.warn('[db] persist failed:', e.message);
  }
}

function getLastInsertRowid() {
  const rows = innerDb.exec('SELECT last_insert_rowid() AS id');
  if (rows[0]?.values[0]) return rows[0].values[0][0];
  return 0;
}

function getRowsModified() {
  return innerDb.getRowsModified();
}

class PreparedStmt {
  constructor(sql) {
    this.sql = sql;
  }
  run(...args) {
    innerDb.run(this.sql, args);
    persist();
    return {
      changes: getRowsModified(),
      lastInsertRowid: getLastInsertRowid()
    };
  }
  get(...args) {
    const stmt = innerDb.prepare(this.sql);
    try {
      stmt.bind(args);
      if (stmt.step()) {
        return stmt.getAsObject();
      }
      return null;
    } finally {
      stmt.free();
    }
  }
  all(...args) {
    const stmt = innerDb.prepare(this.sql);
    try {
      stmt.bind(args);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }
}

class DbWrapper {
  prepare(sql) {
    return new PreparedStmt(sql);
  }
  exec(sql) {
    innerDb.run(sql);
    persist();
  }
  close() {
    persist();
    innerDb.close();
  }
}

export const db = new DbWrapper();

// ===== Schema Init =====
db.exec('PRAGMA foreign_keys = ON;');
// sql.js 不支持 WAL（纯内存数据库），跳过 journal_mode

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

// 幂等 seed：演示班级 + 3 名学生
if (db.prepare('SELECT COUNT(*) AS c FROM students').get().c === 0) {
  const className = '计算机应用25-1班';
  const grade = '2025级';
  const defaultPassword = '123456';
  const students = [
    { no: '20250101', name: '张三' },
    { no: '20250102', name: '李四' },
    { no: '20250103', name: '王五' },
  ];
  const folder = createClassFolder(className);
  const r = db
    .prepare(
      'INSERT INTO classes (name, grade, description, folder, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(className, grade, '演示班级，可随时删除', folder, now());
  const classId = Number(r.lastInsertRowid);
  for (const s of students) {
    const sr = db
      .prepare(
        `INSERT INTO students (class_id, student_no, name, username, password_hash, folder, status, created_at)
         VALUES (?, ?, ?, ?, ?, '', 'active', ?)`
      )
      .run(classId, s.no, s.name, s.no, hashPassword(defaultPassword), now());
    const id = Number(sr.lastInsertRowid);
    const sFolder = createStudentFolder(folder, s.no, s.name);
    db.prepare('UPDATE students SET folder = ? WHERE id = ?').run(sFolder, id);
  }
  console.log('[seed] 演示班级 + 3 名学生已创建');
}

export { now };
