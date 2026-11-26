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

-- ===== Module 3: DNS / DHCP =====
CREATE TABLE IF NOT EXISTS dhcp_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_ip TEXT NOT NULL,
  subnet_mask TEXT NOT NULL,
  gateway TEXT NOT NULL,
  dns_servers TEXT NOT NULL DEFAULT '',
  pool_start TEXT NOT NULL,
  pool_end TEXT NOT NULL,
  lease_seconds INTEGER NOT NULL DEFAULT 86400,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dns_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,          -- A / CNAME / NS / MX
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  ttl INTEGER NOT NULL DEFAULT 300,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dns_name ON dns_records(name);

CREATE TABLE IF NOT EXISTS network_pcs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
  mac_address TEXT NOT NULL,
  dhcp_enabled INTEGER NOT NULL DEFAULT 1,
  static_ip TEXT,              -- 静态 IP（dhcp_enabled=0 时生效）
  current_ip TEXT,             -- 当前 IP（DHCP 分配或静态）
  subnet_mask TEXT,
  gateway TEXT,
  dns_servers TEXT,
  lease_expires_at INTEGER,    -- Unix ms
  pos_x INTEGER DEFAULT 100,   -- SVG 画布坐标
  pos_y INTEGER DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'offline', -- online / offline
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pc_arp_cache (
  pc_id INTEGER NOT NULL REFERENCES network_pcs(id) ON DELETE CASCADE,
  remote_ip TEXT NOT NULL,
  remote_mac TEXT NOT NULL,
  resolved_at INTEGER NOT NULL,
  PRIMARY KEY (pc_id, remote_ip)
);

-- ===== Module 4: Mail Server (SMTP / POP3) =====
CREATE TABLE IF NOT EXISTS mail_server_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL DEFAULT 'example.local',
  smtp_port INTEGER NOT NULL DEFAULT 25,
  pop3_port INTEGER NOT NULL DEFAULT 110,
  max_size_kb INTEGER NOT NULL DEFAULT 10240,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mail_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,           -- 邮箱前缀（如 zhangsan）
  domain TEXT NOT NULL,              -- 域名（如 example.local）
  full_address TEXT NOT NULL UNIQUE, -- zhangsan@example.local
  display_name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mail_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_address TEXT NOT NULL,
  sender_name TEXT NOT NULL DEFAULT '',
  recipient_address TEXT NOT NULL,
  recipient_name TEXT NOT NULL DEFAULT '',
  cc_addresses TEXT NOT NULL DEFAULT '',  -- JSON array string
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  html_body TEXT NOT NULL DEFAULT '',
  attachments TEXT NOT NULL DEFAULT '',   -- JSON array [{name, size, path}]
  size_bytes INTEGER NOT NULL DEFAULT 0,
  smtp_log TEXT NOT NULL DEFAULT '',      -- SMTP 交互日志（JSON array）
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_sender ON mail_messages(sender_address);
CREATE INDEX IF NOT EXISTS idx_mail_recipient ON mail_messages(recipient_address);

CREATE TABLE IF NOT EXISTS mail_mailboxes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  folder TEXT NOT NULL,               -- inbox / sent / draft / junk / trash
  is_read INTEGER NOT NULL DEFAULT 0,
  is_starred INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER,                 -- Unix ms（垃圾桶）
  created_at TEXT NOT NULL,
  UNIQUE(account_id, message_id, folder)
);
CREATE INDEX IF NOT EXISTS idx_mb_account ON mail_mailboxes(account_id, folder);

-- 黑名单：收件人拒收指定发件人
CREATE TABLE IF NOT EXISTS mail_blacklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  blocked_address TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(account_id, blocked_address)
);

-- 定时发送任务
CREATE TABLE IF NOT EXISTS mail_scheduled (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  to_addresses TEXT NOT NULL DEFAULT '',   -- JSON array
  cc_addresses TEXT NOT NULL DEFAULT '',   -- JSON array
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  html_body TEXT NOT NULL DEFAULT '',
  attachments TEXT NOT NULL DEFAULT '',    -- JSON array
  send_at INTEGER NOT NULL,                -- Unix ms
  status TEXT NOT NULL DEFAULT 'pending',  -- pending / sent / cancelled / failed
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sched_pending ON mail_scheduled(status, send_at);

-- 平台全局设置（键值对）
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
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

// 幂等 seed：DHCP + DNS 记录 + 3 台 PC
if (db.prepare('SELECT COUNT(*) AS c FROM dhcp_config').get().c === 0) {
  db.prepare(
    `INSERT INTO dhcp_config (server_ip, subnet_mask, gateway, dns_servers, pool_start, pool_end, lease_seconds, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('192.168.1.1', '255.255.255.0', '192.168.1.1', '192.168.1.1', '192.168.1.100', '192.168.1.200', 86400, now());
  console.log('[seed] DHCP 配置已创建');
}
if (db.prepare('SELECT COUNT(*) AS c FROM dns_records').get().c === 0) {
  const rows = [
    ['A', 'www', '192.168.1.100', 300],
    ['A', 'ftp', '192.168.1.101', 300],
    ['A', 'mail', '192.168.1.102', 300],
    ['A', 'dns', '192.168.1.1', 300],
    ['NS', 'example.local', 'dns.example.local', 3600],
    ['MX', 'example.local', 'mail.example.local', 3600],
  ];
  const stmt = db.prepare('INSERT INTO dns_records (type, name, value, ttl, created_at) VALUES (?, ?, ?, ?, ?)');
  for (const r of rows) stmt.run(...r, now());
  console.log('[seed] DNS 记录已创建');
}
if (db.prepare('SELECT COUNT(*) AS c FROM network_pcs').get().c === 0) {
  const pcs = [
    { name: 'PC-张三', mac: '00:1A:2B:3C:4D:01', sx: 180, sy: 220 },
    { name: 'PC-李四', mac: '00:1A:2B:3C:4D:02', sx: 380, sy: 220 },
    { name: 'PC-王五', mac: '00:1A:2B:3C:4D:03', sx: 580, sy: 220 },
  ];
  // 查学生（关联 student_id，可选）
  const students = db.prepare('SELECT id FROM students ORDER BY id').all();
  const stmt = db.prepare(
    `INSERT INTO network_pcs (name, student_id, mac_address, pos_x, pos_y, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'offline', ?)`
  );
  for (let i = 0; i < pcs.length; i++) {
    const sid = students[i]?.id ?? null;
    stmt.run(pcs[i].name, sid, pcs[i].mac, pcs[i].sx, pcs[i].sy, now());
  }
  console.log('[seed] 3 台 PC 已创建');
}

// 幂等 seed：邮件服务器配置 + 自动为学生生成邮箱账号
if (db.prepare('SELECT COUNT(*) AS c FROM mail_server_config').get().c === 0) {
  db.prepare(
    `INSERT INTO mail_server_config (domain, smtp_port, pop3_port, max_size_kb, enabled, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run('example.local', 25, 110, 10240, 1, now());
  console.log('[seed] 邮件服务器配置已创建');
}
// 为每个没邮箱的学生自动创建账号
(function autoCreateMailAccounts() {
  const cfg = db.prepare('SELECT domain FROM mail_server_config LIMIT 1').get();
  if (!cfg) return;
  const existing = new Set(db.prepare('SELECT username FROM mail_accounts').all().map(a => a.username));
  const students = db.prepare('SELECT id, student_no, name FROM students').all();
  let created = 0;
  for (const s of students) {
    // 用 student_no 做邮箱前缀（数字学号更稳定，避免中文转拼音）
    const prefix = s.student_no;
    if (existing.has(prefix)) continue;
    const full = `${prefix}@${cfg.domain}`;
    db.prepare(
      `INSERT INTO mail_accounts (username, domain, full_address, display_name, password_hash, student_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(prefix, cfg.domain, full, s.name, hashPassword('123456'), s.id, now());
    created++;
  }
  if (created > 0) console.log(`[seed] 自动创建 ${created} 个邮箱账号`);
})();

// 默认设置：允许学生编辑网络模拟配置（教师可在控制台关闭）
(function seedSettings() {
  db.prepare(
    `INSERT OR IGNORE INTO app_settings (key, value) VALUES ('student_can_edit_network', '1')`
  ).run();
})();

export { now };
