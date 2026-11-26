// Module 4: Mail Server (SMTP / POP3) 路由
import { Router } from 'express';
import multer from 'multer';
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
import { verifyPassword } from '../password.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// 确保已登录（loadUser 已在 index.js 全局挂载，这里只需检查）
function requireLogin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '请先登录' });
  next();
}

// 为 mail 相关请求绑定 mailAccount 到 req.mailAccount
function bindMailAccount(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '请先登录' });
  if (req.user.role === 'student') {
    req.mailAccount = db.prepare(
      `SELECT ma.* FROM mail_accounts ma WHERE ma.student_id = ?`
    ).get(req.user.id) || null;
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
    return res.json(rows);
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
