// Module 4: Mail Server (SMTP / POP3) 路由
import { Router } from 'express';
import multer from 'multer';
import { randomBytes } from 'node:crypto';
import { db } from '../db.js';
import { requireTeacher } from '../auth.js';
import {
  getMailConfig, smtpSend, pop3Session, findAccountByAddress, listAllAccounts,
  listMails, getMailDetail, moveMail, deleteMail, toggleStar, markAllRead,
  getFolderCounts, saveDraft, createAccount, deleteAccount, updateAccountPassword,
  resetAllAccountPasswords, updateConfig, parseEmailAddress,
  saveAttachment, resolveAttachment, canAccessAttachment, attachmentLimits,
  listBlacklist, addBlacklist, removeBlacklist,
  createScheduled, listScheduled, cancelScheduled, runDueScheduled
} from '../services/mailSim.js';
import { verifyPassword, hashPassword } from '../password.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// 确保已登录（loadUser 已在 index.js 全局挂载，这里只需检查）
function requireLogin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '请先登录' });
  next();
}

// ==================== 邮箱注册 / 登录（模拟短信） ====================
const MAIL_SESSION_MS = 8 * 60 * 60 * 1000;
const SMS_TTL_MS = 5 * 60 * 1000;
const SMS_COOLDOWN_MS = 30 * 1000;

function mailDomain() { return getMailConfig().domain; }

function normAddress(input) {
  let s = String(input || '').trim().toLowerCase();
  if (!s) return '';
  if (!s.includes('@')) s = `${s}@${mailDomain()}`;
  return s;
}

function validAlias(a) { return /^[a-z0-9][a-z0-9._-]{2,17}$/.test(a); }

function publicAccount(acct) {
  return { id: acct.id, full_address: acct.full_address, display_name: acct.display_name };
}

function issueSmsCode({ target, purpose, phone }) {
  const nowMs = Date.now();
  const last = db.prepare(
    'SELECT created_ms FROM mail_login_codes WHERE target=? AND purpose=? ORDER BY id DESC LIMIT 1'
  ).get(target, purpose);
  if (last && nowMs - last.created_ms < SMS_COOLDOWN_MS) {
    return { error: `请 ${Math.ceil((SMS_COOLDOWN_MS - (nowMs - last.created_ms)) / 1000)} 秒后再获取验证码` };
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  db.prepare(
    `INSERT INTO mail_login_codes (target, purpose, code, phone, expires_ms, created_ms)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(target, purpose, code, phone || '', nowMs + SMS_TTL_MS, nowMs);
  return { code };
}

function checkSmsCode({ target, purpose, code }) {
  const nowMs = Date.now();
  const row = db.prepare(
    `SELECT * FROM mail_login_codes WHERE target=? AND purpose=? AND used=0 ORDER BY id DESC LIMIT 1`
  ).get(target, purpose);
  if (!row) return '请先获取短信验证码';
  if (row.expires_ms < nowMs) return '验证码已过期，请重新获取';
  if (row.attempts >= 5) return '验证码尝试次数过多，请重新获取';
  if (String(row.code) !== String(code || '').trim()) {
    db.prepare('UPDATE mail_login_codes SET attempts=attempts+1 WHERE id=?').run(row.id);
    return '验证码错误';
  }
  db.prepare('UPDATE mail_login_codes SET used=1 WHERE id=?').run(row.id);
  return null;
}

function createMailSession(account, userId) {
  const token = randomBytes(24).toString('hex');
  db.prepare('DELETE FROM mail_sessions WHERE expires_ms < ?').run(Date.now());
  db.prepare(
    'INSERT INTO mail_sessions (token, account_id, user_id, expires_ms, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(token, account.id, userId, Date.now() + MAIL_SESSION_MS, new Date().toISOString());
  return token;
}

function sessionToken(req) {
  return req.get('x-mail-token') || req.query.mail_token || (req.body && req.body.mail_token) || '';
}

function resolveMailSession(req) {
  const token = sessionToken(req);
  if (!token) return null;
  const s = db.prepare('SELECT * FROM mail_sessions WHERE token=?').get(token);
  if (!s || s.expires_ms < Date.now()) return null;
  return db.prepare('SELECT * FROM mail_accounts WHERE id=?').get(s.account_id) || null;
}

// 为 mail 相关请求绑定 mailAccount 到 req.mailAccount
function bindMailAccount(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '请先登录' });
  if (req.user.role === 'student') {
    const acct = resolveMailSession(req);
    if (!acct) {
      return res.status(401).json({ error: '请先登录邮箱', code: 'MAIL_LOGIN_REQUIRED' });
    }
    req.mailAccount = acct;
  } else {
    // 教师可以通过 query.account_id 指定查看哪个账号
    const aid = req.query.account_id || req.body?.account_id;
    if (aid) {
      req.mailAccount = db.prepare('SELECT * FROM mail_accounts WHERE id = ?').get(aid);
    } else {
      req.mailAccount = null;
    }
  }
  next();
}

function needMailAccount(req, res, next) {
  if (!req.mailAccount) {
    return res.status(400).json({ error: '没有可用的邮箱账号，请联系管理员创建' });
  }
  next();
}

// 当前邮箱会话状态 / 是否已注册
router.get('/session', requireLogin, (req, res) => {
  if (req.user.role !== 'student') return res.json({ teacher: true, domain: mailDomain() });
  const acct = resolveMailSession(req);
  const bound = db.prepare(
    'SELECT id, full_address, display_name, claimed, phone FROM mail_accounts WHERE student_id=?'
  ).get(req.user.id) || null;
  res.json({
    teacher: false,
    domain: mailDomain(),
    account: acct ? publicAccount(acct) : null,
    hasAccount: !!bound,
    claimed: bound ? !!bound.claimed : false,
    address: bound ? bound.full_address : null,
    phoneMasked: bound && bound.phone
      ? bound.phone.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2')
      : ''
  });
});

// 获取模拟短信验证码（不发送真实短信，直接返回给前端演示）
router.post('/sms-code', requireLogin, (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ error: '仅学生可注册/登录邮箱' });
  const { purpose = 'register', phone, address } = req.body || {};
  const phoneStr = String(phone || '').trim();
  if (!/^1\d{10}$/.test(phoneStr)) {
    return res.status(400).json({ error: '请输入 11 位模拟手机号（如 13800000000）' });
  }
  if (purpose === 'register') {
    const bound = db.prepare('SELECT * FROM mail_accounts WHERE student_id=?').get(req.user.id);
    if (bound && bound.claimed) {
      return res.status(409).json({ error: '你已注册邮箱，请直接登录' });
    }
    const r = issueSmsCode({ target: phoneStr, purpose: 'register', phone: phoneStr });
    if (r.error) return res.status(429).json({ error: r.error });
    return res.json({ ok: true, code: r.code, expires_in: 300, simulated: true });
  }
  if (purpose === 'login') {
    const addr = normAddress(address);
    const acct = db.prepare('SELECT * FROM mail_accounts WHERE lower(full_address)=?').get(addr);
    if (!acct || acct.student_id !== req.user.id) {
      return res.status(404).json({ error: '邮箱账号不存在或不属于你' });
    }
    if (acct.phone && acct.phone !== phoneStr) {
      return res.status(400).json({ error: '手机号与注册时不一致' });
    }
    const r = issueSmsCode({ target: addr, purpose: 'login', phone: phoneStr });
    if (r.error) return res.status(429).json({ error: r.error });
    return res.json({ ok: true, code: r.code, expires_in: 300, simulated: true });
  }
  res.status(400).json({ error: '未知的验证码用途' });
});

// 学生自行注册邮箱（绑定当前学生账号，可自选别名）
router.post('/register', requireLogin, (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ error: '仅学生可注册邮箱' });
  const { alias, password, display_name, phone, code } = req.body || {};
  const a = String(alias || '').trim().toLowerCase();
  const phoneStr = String(phone || '').trim();
  if (!validAlias(a)) {
    return res.status(400).json({ error: '账号需 3-18 位，字母/数字/._-，且以字母或数字开头' });
  }
  if (!password || String(password).length < 6) {
    return res.status(400).json({ error: '密码至少 6 位' });
  }
  if (!/^1\d{10}$/.test(phoneStr)) {
    return res.status(400).json({ error: '请填写 11 位模拟手机号' });
  }
  const domain = mailDomain();
  const full = `${a}@${domain}`;
  const bound = db.prepare('SELECT * FROM mail_accounts WHERE student_id=?').get(req.user.id);
  if (bound && bound.claimed) {
    return res.status(409).json({ error: `你已注册邮箱 ${bound.full_address}，请直接登录` });
  }
  if (db.prepare('SELECT id FROM mail_accounts WHERE lower(full_address)=?').get(full)) {
    return res.status(409).json({ error: '该邮箱账号已被占用，请换一个别名' });
  }
  if (db.prepare('SELECT id FROM mail_accounts WHERE lower(username)=? AND (student_id IS NULL OR student_id<>?)').get(a, req.user.id)) {
    return res.status(409).json({ error: '该邮箱账号已被占用，请换一个别名' });
  }
  const smsErr = checkSmsCode({ target: phoneStr, purpose: 'register', code });
  if (smsErr) return res.status(400).json({ error: smsErr });
  const name = String(display_name || '').trim().slice(0, 12) || req.user.name || a;
  let accountId;
  if (bound) {
    db.prepare(
      `UPDATE mail_accounts SET username=?, domain=?, full_address=?, display_name=?,
              password_hash=?, phone=?, claimed=1 WHERE id=?`
    ).run(a, domain, full, name, hashPassword(String(password)), phoneStr, bound.id);
    accountId = bound.id;
  } else {
    const r = db.prepare(
      `INSERT INTO mail_accounts (username, domain, full_address, display_name, password_hash, student_id, phone, claimed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
    ).run(a, domain, full, name, hashPassword(String(password)), req.user.id, phoneStr, new Date().toISOString());
    accountId = Number(r.lastInsertRowid);
  }
  const account = db.prepare('SELECT * FROM mail_accounts WHERE id=?').get(accountId);
  const token = createMailSession(account, req.user.id);
  res.json({ ok: true, token, account: publicAccount(account) });
});

// 学生登录自己的邮箱（密码或短信验证码）
router.post('/login', requireLogin, (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ error: '教师无需邮箱登录' });
  const { address, password, code, method = 'password' } = req.body || {};
  const addr = normAddress(address);
  if (!addr) return res.status(400).json({ error: '请输入邮箱账号' });
  const acct = db.prepare('SELECT * FROM mail_accounts WHERE lower(full_address)=?').get(addr);
  if (!acct || acct.student_id !== req.user.id) {
    return res.status(401).json({ error: '邮箱账号不存在或不属于你' });
  }
  if (method === 'sms') {
    const err = checkSmsCode({ target: addr, purpose: 'login', code });
    if (err) return res.status(400).json({ error: err });
  } else if (!verifyPassword(String(password || ''), acct.password_hash)) {
    return res.status(401).json({ error: '密码错误' });
  }
  const token = createMailSession(acct, req.user.id);
  res.json({ ok: true, token, account: publicAccount(acct) });
});

router.post('/logout', requireLogin, (req, res) => {
  const token = sessionToken(req);
  if (token) db.prepare('DELETE FROM mail_sessions WHERE token=?').run(token);
  res.json({ ok: true });
});

// 教师邮箱别名注册 / 更换
router.put('/teacher-alias', requireTeacher, (req, res) => {
  const { alias, display_name, password } = req.body || {};
  const a = String(alias || '').trim().toLowerCase();
  if (!validAlias(a)) {
    return res.status(400).json({ error: '别名需 3-18 位，字母/数字/._-，且以字母或数字开头' });
  }
  if (password && String(password).length < 6) {
    return res.status(400).json({ error: '密码至少 6 位' });
  }
  const teacher = db.prepare(
    "SELECT * FROM mail_accounts WHERE is_teacher=1 OR lower(username)='teacher' LIMIT 1"
  ).get();
  if (!teacher) return res.status(404).json({ error: '教师邮箱不存在，请重启服务重新初始化' });
  const domain = mailDomain();
  const full = `${a}@${domain}`;
  const clash = db.prepare(
    'SELECT id FROM mail_accounts WHERE lower(full_address)=? AND id<>?'
  ).get(full, teacher.id);
  if (clash) return res.status(409).json({ error: '该邮箱别名已被占用，请换一个' });
  const name = String(display_name || '').trim().slice(0, 12) || teacher.display_name;
  if (password) {
    db.prepare(
      `UPDATE mail_accounts SET username=?, domain=?, full_address=?, display_name=?,
              password_hash=?, is_teacher=1, claimed=1 WHERE id=?`
    ).run(a, domain, full, name, hashPassword(String(password)), teacher.id);
  } else {
    db.prepare(
      `UPDATE mail_accounts SET username=?, domain=?, full_address=?, display_name=?,
              is_teacher=1, claimed=1 WHERE id=?`
    ).run(a, domain, full, name, teacher.id);
  }
  const fresh = db.prepare('SELECT * FROM mail_accounts WHERE id=?').get(teacher.id);
  res.json({ ok: true, account: publicAccount(fresh) });
});

// ==================== 配置 ====================

router.get('/config', requireLogin, (req, res) => {
  res.json(getMailConfig());
});

router.put('/config', requireTeacher, (req, res) => {
  const { domain, smtp_port, pop3_port, max_size_kb, enabled } = req.body || {};
  const patch = {};
  if (domain !== undefined) patch.domain = String(domain).trim();
  if (smtp_port !== undefined) patch.smtp_port = Number(smtp_port);
  if (pop3_port !== undefined) patch.pop3_port = Number(pop3_port);
  if (max_size_kb !== undefined) patch.max_size_kb = Number(max_size_kb);
  if (enabled !== undefined) patch.enabled = enabled ? 1 : 0;
  const cfg = updateConfig(patch);
  res.json({ ok: true, config: cfg });
});

// ==================== 账号 ====================

router.get('/accounts', requireLogin, (req, res) => {
  res.json(listAllAccounts());
});

router.post('/accounts', requireTeacher, (req, res) => {
  const { username, domain, display_name, password, student_id } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '用户名和密码必填' });
  const id = createAccount({
    username: String(username).trim(),
    domain: domain?.trim() || undefined,
    displayName: display_name?.trim() || undefined,
    password: String(password),
    studentId: student_id ? Number(student_id) : undefined
  });
  if (!id) return res.status(409).json({ error: '该邮箱已存在' });
  res.json({ ok: true, id });
});

router.put('/accounts/:id/password', requireTeacher, (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: '密码必填' });
  const r = updateAccountPassword(Number(req.params.id), String(password));
  res.json({ ok: true, changes: r.changes });
});

router.put('/accounts/:id/self-password', requireLogin, (req, res) => {
  // 学生修改自己的邮箱密码
  if (req.user.role !== 'student') return res.status(403).json({ error: '仅学生可修改' });
  const acct = db.prepare('SELECT * FROM mail_accounts WHERE student_id = ?').get(req.user.id);
  if (!acct) return res.status(404).json({ error: '没有邮箱账号' });
  const { old_password, new_password } = req.body || {};
  if (!verifyPassword(String(old_password || ''), acct.password_hash)) {
    return res.status(400).json({ error: '原密码错误' });
  }
  if (!new_password || new_password.length < 4) {
    return res.status(400).json({ error: '新密码至少 4 位' });
  }
  updateAccountPassword(acct.id, String(new_password));
  res.json({ ok: true });
});

router.delete('/accounts/:id', requireTeacher, (req, res) => {
  const r = deleteAccount(Number(req.params.id));
  res.json({ ok: true, changes: r.changes });
});

router.post('/accounts/reset-all-passwords', requireTeacher, (req, res) => {
  resetAllAccountPasswords();
  res.json({ ok: true, message: '所有账号密码已重置为 123456' });
});

router.get('/accounts/validate-address', requireLogin, (req, res) => {
  const { address } = req.query;
  const info = parseEmailAddress(address);
  if (!info) return res.json({ valid: false, reason: '格式错误' });
  const exists = !!findAccountByAddress(info.full);
  res.json({ valid: !exists, exists, info });
});

// 通讯簿：学生只看本班同学，教师看全部
router.get('/address-book', requireLogin, (req, res) => {
  const baseSql = `SELECT a.id, a.full_address, a.display_name,
                          s.student_no, s.name AS real_name, c.name AS class_name
                   FROM mail_accounts a
                   LEFT JOIN students s ON a.student_id = s.id
                   LEFT JOIN classes c ON c.id = s.class_id`;
  if (req.user.role === 'student') {
    const me = db.prepare('SELECT class_id FROM students WHERE id = ?').get(req.user.id);
    if (!me || !me.class_id) return res.json([]);
    const rows = db.prepare(`${baseSql} WHERE s.class_id = ? ORDER BY s.student_no`).all(me.class_id);
    // 通讯簿首位固定为教师邮箱，便于师生互动
    const teacher = db.prepare(
      `SELECT a.id, a.full_address, a.display_name,
              '' AS student_no, '教师' AS real_name, '教师' AS class_name
       FROM mail_accounts a
       WHERE a.is_teacher = 1 OR lower(a.username) = 'teacher'
       LIMIT 1`
    ).get();
    return res.json(teacher ? [teacher, ...rows] : rows);
  }
  const rows = db.prepare(`${baseSql} ORDER BY c.name, s.student_no`).all();
  res.json(rows);
});

// ==================== 发送邮件 ====================

router.post('/send', bindMailAccount, needMailAccount, (req, res) => {
  const { to, cc, subject, body, html_body, attachments } = req.body || {};
  const toArr = Array.isArray(to) ? to : (to ? [to] : []);
  const ccArr = Array.isArray(cc) ? cc : (cc ? [cc] : []);
  if (toArr.length === 0) return res.status(400).json({ error: '收件人不能为空' });

  const result = smtpSend({
    fromAddress: req.mailAccount.full_address,
    fromAccountId: req.mailAccount.id,
    toAddresses: toArr,
    ccAddresses: ccArr,
    subject: subject || '',
    body: body || '',
    htmlBody: html_body || '',
    attachments: Array.isArray(attachments) ? attachments : []
  });

  if (!result.ok) {
    return res.status(400).json({
      ok: false,
      error: result.error,
      smtp_log: result.smtp_log,
      rejected: result.rejected
    });
  }
  res.json({
    ok: true,
    smtp_log: result.smtp_log,
    delivered_to: result.delivered_to,
    rejected: result.rejected,
    sent_message_id: result.sent_message_id
  });
});

// ==================== POP3 收信模拟展示 ====================

router.get('/pop3-session', bindMailAccount, needMailAccount, (req, res) => {
  res.json({ log: pop3Session(req.mailAccount) });
});

// ==================== 邮件列表/详情/操作 ====================

router.get('/mails', bindMailAccount, needMailAccount, (req, res) => {
  const { folder = 'inbox', limit = 50, offset = 0, star_only, keyword } = req.query;
  const allowed = ['inbox', 'sent', 'draft', 'junk', 'trash'];
  if (!allowed.includes(folder)) return res.status(400).json({ error: '非法文件夹' });
  const mails = listMails(req.mailAccount.id, folder, {
    limit: Number(limit),
    offset: Number(offset),
    starOnly: star_only === '1',
    keyword: String(keyword || '')
  });
  res.json(mails);
});

router.get('/mails/counts', bindMailAccount, needMailAccount, (req, res) => {
  res.json(getFolderCounts(req.mailAccount.id));
});

router.get('/mails/:mailboxId', bindMailAccount, needMailAccount, (req, res) => {
  const mail = getMailDetail(req.mailAccount.id, Number(req.params.mailboxId));
  if (!mail) return res.status(404).json({ error: '邮件不存在' });
  res.json(mail);
});

router.put('/mails/:mailboxId/move', bindMailAccount, needMailAccount, (req, res) => {
  const { folder } = req.body || {};
  const allowed = ['inbox', 'sent', 'draft', 'junk', 'trash'];
  if (!allowed.includes(folder)) return res.status(400).json({ error: '目标文件夹不合法' });
  const r = moveMail(req.mailAccount.id, Number(req.params.mailboxId), folder);
  res.json({ ok: true, changes: r.changes });
});

router.delete('/mails/:mailboxId', bindMailAccount, needMailAccount, (req, res) => {
  const r = deleteMail(req.mailAccount.id, Number(req.params.mailboxId));
  res.json({ ok: true, changes: r.changes });
});

router.put('/mails/:mailboxId/star', bindMailAccount, needMailAccount, (req, res) => {
  const r = toggleStar(req.mailAccount.id, Number(req.params.mailboxId));
  res.json({ ok: true, changes: r.changes });
});

router.put('/mails/mark-all-read', bindMailAccount, needMailAccount, (req, res) => {
  const { folder } = req.body || {};
  if (!folder) return res.status(400).json({ error: 'folder 必填' });
  const r = markAllRead(req.mailAccount.id, folder);
  res.json({ ok: true, changes: r.changes });
});

router.put('/mails/empty-trash', bindMailAccount, needMailAccount, (req, res) => {
  const r = db.prepare(
    `DELETE FROM mail_mailboxes WHERE account_id = ? AND folder = 'trash'`
  ).run(req.mailAccount.id);
  res.json({ ok: true, changes: r.changes });
});

// ==================== 草稿 ====================

router.post('/drafts', bindMailAccount, needMailAccount, (req, res) => {
  const { to, cc, subject, body, html_body, attachments } = req.body || {};
  const id = saveDraft(req.mailAccount.id, {
    to, cc, subject, body, htmlBody: html_body, attachments
  });
  res.json({ ok: true, id });
});

// ==================== 附件上传/下载 ====================

router.post('/attachments', requireLogin, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择文件' });
  const lim = attachmentLimits();
  const info = saveAttachment(req.file.buffer, req.file.originalname);
  res.json({ ok: true, attachment: info, limits: lim });
});

router.get('/attachments/:stored', requireLogin, (req, res) => {
  const stored = req.params.stored;
  const abs = resolveAttachment(stored);
  if (!abs) return res.status(404).json({ error: '附件不存在' });
  if (req.user.role === 'student') {
    const acct = db.prepare('SELECT * FROM mail_accounts WHERE student_id = ?').get(req.user.id);
    if (!acct) return res.status(403).json({ error: '无权访问' });
    const id = stored.split('__')[0];
    if (!canAccessAttachment(acct.id, id)) {
      return res.status(403).json({ error: '无权访问该附件' });
    }
  }
  res.download(abs);
});

// ==================== 黑名单 ====================

router.get('/blacklist', bindMailAccount, needMailAccount, (req, res) => {
  res.json(listBlacklist(req.mailAccount.id));
});

router.post('/blacklist', bindMailAccount, needMailAccount, (req, res) => {
  const { address } = req.body || {};
  const r = addBlacklist(req.mailAccount.id, address);
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ok: true, changes: r.changes });
});

router.delete('/blacklist/:id', bindMailAccount, needMailAccount, (req, res) => {
  const r = removeBlacklist(req.mailAccount.id, req.params.id);
  res.json({ ok: true, changes: r.changes });
});

// ==================== 定时发送 ====================

router.get('/scheduled', bindMailAccount, needMailAccount, (req, res) => {
  res.json(listScheduled(req.mailAccount.id));
});

router.post('/scheduled', bindMailAccount, needMailAccount, (req, res) => {
  const { to, cc, subject, body, html_body, attachments, send_at } = req.body || {};
  const toArr = Array.isArray(to) ? to : (to ? [to] : []);
  const ccArr = Array.isArray(cc) ? cc : (cc ? [cc] : []);
  if (toArr.length === 0) return res.status(400).json({ error: '收件人不能为空' });
  const sendAt = Number(send_at);
  if (!sendAt || sendAt <= Date.now()) {
    return res.status(400).json({ error: '发送时间必须晚于当前时间' });
  }
  const id = createScheduled(req.mailAccount.id, {
    to: toArr, cc: ccArr, subject, body, htmlBody: html_body,
    attachments: Array.isArray(attachments) ? attachments : [], sendAt
  });
  res.json({ ok: true, id });
});

router.delete('/scheduled/:id', bindMailAccount, needMailAccount, (req, res) => {
  const r = cancelScheduled(req.mailAccount.id, req.params.id);
  res.json({ ok: true, changes: r.changes });
});

// 手动触发一次到期检查（调试用）
router.post('/scheduled/run-now', requireLogin, (req, res) => {
  res.json({ ok: true, results: runDueScheduled() });
});

// ==================== 收件人搜索自动补全 ====================

router.get('/recipients/search', bindMailAccount, needMailAccount, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q || q.length < 1) return res.json([]);
  const rows = db.prepare(
    `SELECT full_address, display_name FROM mail_accounts
     WHERE full_address LIKE ? OR display_name LIKE ? OR username LIKE ?
     LIMIT 10`
  ).all(`%${q}%`, `%${q}%`, `%${q}%`);
  res.json(rows);
});

export default router;
