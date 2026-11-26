// SMTP / POP3 协议模拟器 — 生成协议交互日志 + 执行业务逻辑
// 所有发信操作都记录完整 SMTP 命令序列，让前端可以实时展示"协议调试面板"
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db } from '../db.js';
import { hashPassword, verifyPassword } from '../password.js';
import { MAIL_ATTACH_DIR } from '../paths.js';

// ==================== 工具函数 ====================

export function parseEmailAddress(addr) {
  if (!addr || typeof addr !== 'string') return null;
  const trimmed = addr.trim().replace(/^<|>$/g, '');
  const m = trimmed.match(/^([^@\s]+)@([^@\s]+)$/);
  if (!m) return null;
  return { username: m[1], domain: m[2], full: trimmed };
}

export function getMailConfig() {
  return db.prepare('SELECT * FROM mail_server_config LIMIT 1').get() || {
    domain: 'example.local', smtp_port: 25, pop3_port: 110, max_size_kb: 10240, enabled: 1
  };
}

export function findAccountByAddress(address) {
  const info = parseEmailAddress(address);
  if (!info) return null;
  return db.prepare('SELECT * FROM mail_accounts WHERE full_address = ?').get(info.full);
}

export function listAllAccounts() {
  return db.prepare(
    `SELECT a.*, s.name AS student_name, s.student_no
     FROM mail_accounts a LEFT JOIN students s ON a.student_id = s.id
     ORDER BY a.id`
  ).all();
}

// ==================== SMTP 发信模拟 ====================
// 返回 { ok, smtp_log[], message_id?, error }

export function smtpSend({ fromAddress, fromAccountId, toAddresses, subject, body, htmlBody, attachments = [], ccAddresses = [] }) {
  const cfg = getMailConfig();
  const log = [];
  const now = new Date().toISOString();

  function add(clientCmd, serverResp) {
    log.push({ ts: Date.now(), dir: 'C', text: clientCmd });
    log.push({ ts: Date.now() + 1, dir: 'S', text: serverResp });
  }

  // 1. 连接握手
  add(null, `220 mail.${cfg.domain} ESMTP Service Ready (SimSmtp v1.0)`);
  add(`EHLO localhost`, `250-mail.${cfg.domain} Hello localhost\r\n250-8BITMIME\r\n250-SIZE ${cfg.max_size_kb * 1024}\r\n250 AUTH LOGIN`);

  // 2. 服务器检查
  if (!cfg.enabled) {
    add(null, `450 Mail service temporarily unavailable`);
    return { ok: false, smtp_log: log, error: '邮件服务已禁用' };
  }

  // 3. MAIL FROM
  const fromInfo = parseEmailAddress(fromAddress);
  if (!fromInfo) {
    add(`MAIL FROM:<${fromAddress}>`, `501 Syntax error in parameters`);
    return { ok: false, smtp_log: log, error: '发件人地址格式错误' };
  }
  add(`MAIL FROM:<${fromInfo.full}>`, `250 2.1.0 Ok`);

  // 4. RCPT TO — 校验每个收件人
  const allRecipients = [...toAddresses, ...ccAddresses];
  const validRecipients = [];
  const rejected = [];
  for (const rawAddr of allRecipients) {
    const info = parseEmailAddress(rawAddr);
    if (!info) {
      add(`RCPT TO:<${rawAddr}>`, `501 Syntax error`);
      rejected.push({ addr: rawAddr, reason: '格式错误' });
      continue;
    }
    // 只处理本地域名（局域网仿真）
    if (info.domain !== cfg.domain) {
      add(`RCPT TO:<${info.full}>`, `554 5.7.1 Relay denied (non-local domain)`);
      rejected.push({ addr: info.full, reason: '非本地域名，拒绝转发' });
      continue;
    }
    const acct = findAccountByAddress(info.full);
    if (!acct) {
      add(`RCPT TO:<${info.full}>`, `550 5.1.1 <${info.full}> User unknown`);
      rejected.push({ addr: info.full, reason: '用户不存在' });
      continue;
    }
    // 黑名单拒收：收件人把发件人拉黑了
    if (isBlacklisted(acct.id, fromInfo.full)) {
      add(`RCPT TO:<${info.full}>`, `550 5.7.1 Sender <${fromInfo.full}> blocked by recipient`);
      rejected.push({ addr: info.full, reason: '收件人已将你加入黑名单' });
      continue;
    }
    add(`RCPT TO:<${info.full}>`, `250 2.1.5 Ok`);
    validRecipients.push({ addr: info.full, accountId: acct.id, isCc: ccAddresses.includes(rawAddr) });
  }

  if (validRecipients.length === 0) {
    add(`DATA`, `450 No valid recipients`);
    add(`QUIT`, `221 2.0.0 Bye`);
    return { ok: false, smtp_log: log, error: `没有有效收件人（${rejected.length} 个被拒绝）`, rejected };
  }

  // 5. DATA
  add(`DATA`, `354 End data with <CR><LF>.<CR><LF>`);
  // 计算大小
  const sizeKB = Math.round((body?.length || 0) + (htmlBody?.length || 0) + JSON.stringify(attachments).length) / 1024;
  if (sizeKB > cfg.max_size_kb) {
    add(null, `552 5.3.4 Message size exceeds fixed maximum (${cfg.max_size_kb}KB)`);
    add(`QUIT`, `221 2.0.0 Bye`);
    return { ok: false, smtp_log: log, error: `邮件大小 ${Math.round(sizeKB)}KB 超过限制 ${cfg.max_size_kb}KB` };
  }
  add(null, `(DATA transmission complete)`);
  add(null, `250 2.0.0 Ok: queued as MSG-${Date.now()}`);
  add(`QUIT`, `221 2.0.0 Bye`);

  // 6. 落库 — 每个收件人一条 mail_messages + 收件人 inbox + 发件人 sent
  const ccJson = JSON.stringify(ccAddresses);
  const attJson = JSON.stringify(attachments || []);
  const totalBytes = (body?.length || 0) + (htmlBody?.length || 0) + JSON.stringify(attachments).length;

  // 收件箱（每个收件人一条独立 message，这样各自有独立的已读/星标/删除状态）
  let firstMessageId = 0;
  for (const r of validRecipients) {
    const mr = db.prepare(
      `INSERT INTO mail_messages (sender_address, sender_name, recipient_address, recipient_name, cc_addresses, subject, body, html_body, attachments, size_bytes, smtp_log, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      fromInfo.full,
      fromInfo.username,
      r.addr,
      r.addr,
      ccJson,
      subject || '(无主题)',
      body || '',
      htmlBody || '',
      attJson,
      totalBytes,
      JSON.stringify(log),
      now
    );
    const msgId = Number(mr.lastInsertRowid);
    if (!firstMessageId) firstMessageId = msgId;

    db.prepare(
      `INSERT OR IGNORE INTO mail_mailboxes (account_id, message_id, folder, created_at)
       VALUES (?, ?, 'inbox', ?)`
    ).run(r.accountId, msgId, now);
  }

  // 发件箱（合并为一条）
  const sentMsg = db.prepare(
    `INSERT INTO mail_messages (sender_address, sender_name, recipient_address, recipient_name, cc_addresses, subject, body, html_body, attachments, size_bytes, smtp_log, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    fromInfo.full,
    fromInfo.username,
    toAddresses.join(', '),
    toAddresses.join(', '),
    ccJson,
    subject || '(无主题)',
    body || '',
    htmlBody || '',
    attJson,
    totalBytes,
    JSON.stringify(log),
    now
  );
  const sentMsgId = Number(sentMsg.lastInsertRowid);
  if (fromAccountId) {
    db.prepare(
      `INSERT OR IGNORE INTO mail_mailboxes (account_id, message_id, folder, is_read, created_at)
       VALUES (?, ?, 'sent', 1, ?)`
    ).run(fromAccountId, sentMsgId, now);
  }

  return {
    ok: true,
    smtp_log: log,
    message_id: firstMessageId,
    sent_message_id: sentMsgId,
    delivered_to: validRecipients.length,
    rejected
  };
}

// ==================== POP3 收信模拟（展示用） ====================

export function pop3Session(account) {
  const cfg = getMailConfig();
  const log = [];
  log.push({ ts: Date.now(), dir: 'C', text: `POP3 client connecting to pop.${cfg.domain}:${cfg.pop3_port}` });
  log.push({ ts: Date.now() + 1, dir: 'S', text: `+OK POP3 server ready <${Date.now()}@${cfg.domain}>` });

  log.push({ ts: Date.now() + 2, dir: 'C', text: `USER ${account.username}` });
  log.push({ ts: Date.now() + 3, dir: 'S', text: `+OK User name accepted, password please` });

  log.push({ ts: Date.now() + 4, dir: 'C', text: `PASS ****` });
  log.push({ ts: Date.now() + 5, dir: 'S', text: `+OK Logged in. Maildrop ready.` });

  const inboxCount = db.prepare(
    `SELECT COUNT(*) AS c FROM mail_mailboxes mb
     JOIN mail_messages m ON mb.message_id = m.id
     WHERE mb.account_id = ? AND mb.folder = 'inbox'`
  ).get(account.id).c;

  log.push({ ts: Date.now() + 6, dir: 'C', text: `STAT` });
  log.push({ ts: Date.now() + 7, dir: 'S', text: `+OK ${inboxCount} messages ${inboxCount * 5} octets` });

  log.push({ ts: Date.now() + 8, dir: 'C', text: `LIST` });
  if (inboxCount === 0) {
    log.push({ ts: Date.now() + 9, dir: 'S', text: `+OK Mailbox scan listing follows\r\n.\r\n` });
  } else {
    log.push({ ts: Date.now() + 9, dir: 'S', text: `+OK Mailbox scan listing follows` });
    log.push({ ts: Date.now() + 10, dir: 'S', text: `${inboxCount} messages total (simulated)` });
    log.push({ ts: Date.now() + 11, dir: 'S', text: `.` });
  }

  log.push({ ts: Date.now() + 12, dir: 'C', text: `QUIT` });
  log.push({ ts: Date.now() + 13, dir: 'S', text: `+OK Logging out. Bye.` });

  return log;
}

// ==================== 邮件 CRUD ====================

export function listMails(accountId, folder, { limit = 50, offset = 0, starOnly = false, keyword = '' } = {}) {
  let sql = `
    SELECT mb.id AS mailbox_id, mb.folder, mb.is_read, mb.is_starred, mb.deleted_at,
           m.id, m.sender_address, m.sender_name, m.recipient_address, m.subject,
           m.body, m.size_bytes, m.created_at, m.smtp_log
    FROM mail_mailboxes mb
    JOIN mail_messages m ON mb.message_id = m.id
    WHERE mb.account_id = ? AND mb.folder = ?
  `;
  const args = [accountId, folder];

  if (folder === 'inbox' || folder === 'sent') {
    sql += ` AND (mb.deleted_at IS NULL)`;
  }
  if (starOnly) {
    sql += ` AND mb.is_starred = 1`;
  }
  if (keyword) {
    sql += ` AND (m.subject LIKE ? OR m.sender_address LIKE ? OR m.body LIKE ?)`;
    const kw = `%${keyword}%`;
    args.push(kw, kw, kw);
  }
  sql += ` ORDER BY m.created_at DESC LIMIT ? OFFSET ?`;
  args.push(limit, offset);

  return db.prepare(sql).all(...args);
}

export function getMailDetail(accountId, mailboxId) {
  const row = db.prepare(`
    SELECT mb.*, m.*
    FROM mail_mailboxes mb
    JOIN mail_messages m ON mb.message_id = m.id
    WHERE mb.id = ? AND mb.account_id = ?
  `).get(mailboxId, accountId);
  if (!row) return null;

  // 标记已读（仅 inbox）
  if (row.folder === 'inbox' && !row.is_read) {
    db.prepare('UPDATE mail_mailboxes SET is_read = 1 WHERE id = ?').run(mailboxId);
    row.is_read = 1;
  }

  // 解析 attachments / smtp_log
  try { row.attachments = JSON.parse(row.attachments || '[]'); } catch { row.attachments = []; }
  try { row.smtp_log = JSON.parse(row.smtp_log || '[]'); } catch { row.smtp_log = []; }

  return row;
}

export function moveMail(accountId, mailboxId, targetFolder) {
  return db.prepare(
    `UPDATE mail_mailboxes SET folder = ?, deleted_at = ? WHERE id = ? AND account_id = ?`
  ).run(
    targetFolder,
    targetFolder === 'trash' ? Date.now() : null,
    mailboxId, accountId
  );
}

export function deleteMail(accountId, mailboxId) {
  // 两步：先移到 trash，再硬删
  const row = db.prepare('SELECT folder FROM mail_mailboxes WHERE id = ? AND account_id = ?').get(mailboxId, accountId);
  if (!row) return { changes: 0 };
  if (row.folder === 'trash') {
    return db.prepare('DELETE FROM mail_mailboxes WHERE id = ? AND account_id = ?').run(mailboxId, accountId);
  }
  return moveMail(accountId, mailboxId, 'trash');
}

export function toggleStar(accountId, mailboxId) {
  return db.prepare(
    `UPDATE mail_mailboxes SET is_starred = 1 - is_starred WHERE id = ? AND account_id = ?`
  ).run(mailboxId, accountId);
}

export function markAllRead(accountId, folder) {
  return db.prepare(
    `UPDATE mail_mailboxes SET is_read = 1 WHERE account_id = ? AND folder = ? AND is_read = 0`
  ).run(accountId, folder);
}

export function getFolderCounts(accountId) {
  const rows = db.prepare(
    `SELECT folder, COUNT(*) AS total,
            SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread
     FROM mail_mailboxes
     WHERE account_id = ? AND (deleted_at IS NULL OR folder = 'trash')
     GROUP BY folder`
  ).all(accountId);
  const map = {};
  for (const r of rows) {
    map[r.folder] = { total: r.total, unread: r.unread || 0 };
  }
  return {
    inbox: map.inbox || { total: 0, unread: 0 },
    sent: map.sent || { total: 0, unread: 0 },
    draft: map.draft || { total: 0, unread: 0 },
    junk: map.junk || { total: 0, unread: 0 },
    trash: map.trash || { total: 0, unread: 0 },
  };
}

// ==================== 草稿 ====================

export function saveDraft(accountId, { to, cc, subject, body, htmlBody, attachments }) {
  const cfg = getMailConfig();
  const account = db.prepare('SELECT * FROM mail_accounts WHERE id = ?').get(accountId);
  if (!account) return null;

  const msg = db.prepare(
    `INSERT INTO mail_messages (sender_address, sender_name, recipient_address, recipient_name, cc_addresses, subject, body, html_body, attachments, size_bytes, smtp_log, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)`
  ).run(
    account.full_address,
    account.display_name || account.username,
    to || '', to || '',
    JSON.stringify(cc || []),
    subject || '',
    body || '',
    htmlBody || '',
    JSON.stringify(attachments || []),
    (body?.length || 0) + (htmlBody?.length || 0),
    new Date().toISOString()
  );
  const msgId = Number(msg.lastInsertRowid);
  db.prepare(
    `INSERT INTO mail_mailboxes (account_id, message_id, folder, created_at) VALUES (?, ?, 'draft', ?)`
  ).run(accountId, msgId, new Date().toISOString());
  return msgId;
}

// ==================== 账号管理（教师） ====================

export function createAccount({ username, domain, displayName, password, studentId }) {
  const cfg = getMailConfig();
  const d = domain || cfg.domain;
  const full = `${username}@${d}`;
  if (findAccountByAddress(full)) return null;
  const r = db.prepare(
    `INSERT INTO mail_accounts (username, domain, full_address, display_name, password_hash, student_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(username, d, full, displayName || username, hashPassword(password), studentId || null, new Date().toISOString());
  return Number(r.lastInsertRowid);
}

export function deleteAccount(accountId) {
  return db.prepare('DELETE FROM mail_accounts WHERE id = ?').run(accountId);
}

export function updateAccountPassword(accountId, password) {
  return db.prepare('UPDATE mail_accounts SET password_hash = ? WHERE id = ?').run(hashPassword(password), accountId);
}

export function resetAllAccountPasswords() {
  return db.prepare('UPDATE mail_accounts SET password_hash = ?').run(hashPassword('123456'));
}

export function updateConfig(patch) {
  const cfg = getMailConfig();
  const merged = { ...cfg, ...patch, updated_at: new Date().toISOString() };
  db.prepare(
    `UPDATE mail_server_config SET domain = ?, smtp_port = ?, pop3_port = ?, max_size_kb = ?, enabled = ?, updated_at = ? WHERE id = ?`
  ).run(merged.domain, merged.smtp_port, merged.pop3_port, merged.max_size_kb, merged.enabled, merged.updated_at, merged.id);
  return merged;
}

// ==================== 附件 ====================

const MAX_ATTACH_COUNT = 5;
const MAX_ATTACH_EACH = 10 * 1024 * 1024; // 10MB / 个

export function saveAttachment(buffer, originalName) {
  const safeName = path.basename(originalName || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
  const id = crypto.randomUUID();
  const stored = `${id}__${safeName}`;
  fs.writeFileSync(path.join(MAIL_ATTACH_DIR, stored), buffer);
  return {
    id,
    name: safeName,
    size: buffer.length,
    stored
  };
}

export function attachmentLimits() {
  return { maxCount: MAX_ATTACH_COUNT, maxEach: MAX_ATTACH_EACH };
}

// 通过 stored 名取绝对路径（只允许 mailAttach 目录内）
export function resolveAttachment(stored) {
  if (!stored || !/^[a-f0-9-]+__/.test(stored)) return null;
  const abs = path.join(MAIL_ATTACH_DIR, path.basename(stored));
  if (!abs.startsWith(MAIL_ATTACH_DIR)) return null;
  if (!fs.existsSync(abs)) return null;
  return abs;
}

// 判断某账号的某个邮件是否引用了该附件（用于下载鉴权）
export function canAccessAttachment(accountId, attachmentId) {
  const row = db.prepare(
    `SELECT m.attachments FROM mail_mailboxes mb
     JOIN mail_messages m ON mb.message_id = m.id
     WHERE mb.account_id = ?`
  ).all(accountId);
  for (const r of row) {
    try {
      const arr = JSON.parse(r.attachments || '[]');
      if (arr.some(a => a.id === attachmentId)) return true;
    } catch { /* ignore */ }
  }
  return false;
}

// ==================== 黑名单 ====================

export function isBlacklisted(accountId, senderAddress) {
  if (!accountId || !senderAddress) return false;
  const row = db.prepare(
    'SELECT 1 AS x FROM mail_blacklist WHERE account_id = ? AND blocked_address = ?'
  ).get(accountId, String(senderAddress).toLowerCase());
  return !!row;
}

export function listBlacklist(accountId) {
  return db.prepare(
    'SELECT * FROM mail_blacklist WHERE account_id = ? ORDER BY created_at DESC'
  ).all(accountId);
}

export function addBlacklist(accountId, address) {
  const addr = String(address || '').trim().toLowerCase();
  if (!parseEmailAddress(addr)) return { ok: false, error: '邮箱地址格式错误' };
  const r = db.prepare(
    `INSERT OR IGNORE INTO mail_blacklist (account_id, blocked_address, created_at) VALUES (?, ?, ?)`
  ).run(accountId, addr, new Date().toISOString());
  return { ok: true, changes: r.changes };
}

export function removeBlacklist(accountId, id) {
  return db.prepare('DELETE FROM mail_blacklist WHERE id = ? AND account_id = ?').run(Number(id), accountId);
}

// ==================== 定时发送 ====================

export function createScheduled(accountId, { to, cc, subject, body, htmlBody, attachments, sendAt }) {
  const r = db.prepare(
    `INSERT INTO mail_scheduled (account_id, to_addresses, cc_addresses, subject, body, html_body, attachments, send_at, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).run(
    accountId,
    JSON.stringify(to || []),
    JSON.stringify(cc || []),
    subject || '',
    body || '',
    htmlBody || '',
    JSON.stringify(attachments || []),
    Number(sendAt),
    new Date().toISOString()
  );
  return Number(r.lastInsertRowid);
}

export function listScheduled(accountId) {
  const rows = db.prepare(
    `SELECT * FROM mail_scheduled WHERE account_id = ? ORDER BY send_at ASC`
  ).all(accountId);
  return rows.map(r => {
    try { r.to_addresses = JSON.parse(r.to_addresses || '[]'); } catch { r.to_addresses = []; }
    try { r.cc_addresses = JSON.parse(r.cc_addresses || '[]'); } catch { r.cc_addresses = []; }
    try { r.attachments = JSON.parse(r.attachments || '[]'); } catch { r.attachments = []; }
    return r;
  });
}

export function cancelScheduled(accountId, id) {
  return db.prepare(
    `UPDATE mail_scheduled SET status = 'cancelled' WHERE id = ? AND account_id = ? AND status = 'pending'`
  ).run(Number(id), accountId);
}

// 执行到期任务；由 index.js 的定时器周期性调用
export function runDueScheduled() {
  const nowMs = Date.now();
  const due = db.prepare(
    `SELECT * FROM mail_scheduled WHERE status = 'pending' AND send_at <= ? ORDER BY send_at ASC LIMIT 20`
  ).all(nowMs);
  const results = [];
  for (const job of due) {
    const account = db.prepare('SELECT * FROM mail_accounts WHERE id = ?').get(job.account_id);
    if (!account) {
      db.prepare(`UPDATE mail_scheduled SET status = 'failed', error = ? WHERE id = ?`)
        .run('账号不存在', job.id);
      continue;
    }
    let to = [], cc = [], atts = [];
    try { to = JSON.parse(job.to_addresses || '[]'); } catch {}
    try { cc = JSON.parse(job.cc_addresses || '[]'); } catch {}
    try { atts = JSON.parse(job.attachments || '[]'); } catch {}
    const r = smtpSend({
      fromAddress: account.full_address,
      fromAccountId: account.id,
      toAddresses: to,
      ccAddresses: cc,
      subject: job.subject,
      body: job.body,
      htmlBody: job.html_body,
      attachments: atts
    });
    if (r.ok) {
      db.prepare(`UPDATE mail_scheduled SET status = 'sent', error = '' WHERE id = ?`).run(job.id);
    } else {
      db.prepare(`UPDATE mail_scheduled SET status = 'failed', error = ? WHERE id = ?`)
        .run(r.error || '发送失败', job.id);
    }
    results.push({ id: job.id, ok: r.ok });
  }
  return results;
}

export function startMailScheduler(intervalMs = 15000) {
  const timer = setInterval(() => {
    try {
      const rs = runDueScheduled();
      if (rs.length) console.log(`[mail] 定时发送执行 ${rs.length} 封`);
    } catch (e) {
      console.warn('[mail] 定时发送调度异常:', e.message);
    }
  }, intervalMs);
  if (timer.unref) timer.unref();
  return timer;
}
