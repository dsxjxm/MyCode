import { Router } from 'express';
import { db } from '../db.js';
import { hashPassword, verifyPassword, verifyPasswordAsync } from '../password.js';
import {
  buildPreviewToken,
  clearSessionCookie,
  createSession,
  deleteSession,
  setSessionCookie
} from '../auth.js';
import { throttledLogin } from '../services/loginQueue.js';

const router = Router();

function teacherSummary(row) {
  return { role: 'teacher', id: row.id, name: row.name, username: row.username };
}

function studentSummary(row) {
  return {
    role: 'student',
    id: row.id,
    name: row.name,
    username: row.username,
    studentNo: row.student_no,
    classId: row.class_id,
    className: row.class_name,
    previewToken: buildPreviewToken(row.id)
  };
}

router.post('/login', throttledLogin(async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!username || !password) {
    return res.status(400).json({ error: '请输入账号和密码' });
  }

  const teacher = db.prepare('SELECT * FROM teachers WHERE username = ?').get(username);
  if (teacher && (await verifyPasswordAsync(password, teacher.password_hash))) {
    const token = createSession('teacher', teacher.id);
    setSessionCookie(res, token);
    return res.json({ user: teacherSummary(teacher) });
  }

  const student = db
    .prepare(
      `SELECT s.*, c.name AS class_name FROM students s
       JOIN classes c ON c.id = s.class_id WHERE s.username = ?`
    )
    .get(username);
  if (student && (await verifyPasswordAsync(password, student.password_hash))) {
    if (student.status !== 'active') {
      return res.status(403).json({ error: '该学生账号已停用，请联系教师' });
    }
    const token = createSession('student', student.id);
    setSessionCookie(res, token);
    return res.json({ user: studentSummary(student) });
  }

  return res.status(401).json({ error: '账号或密码错误' });
}));

router.post('/logout', (req, res) => {
  deleteSession(req.sessionToken);
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '未登录' });
  if (req.user.role === 'teacher') {
    const row = db.prepare('SELECT * FROM teachers WHERE id = ?').get(req.user.id);
    return res.json({ user: teacherSummary(row) });
  }
  const row = db
    .prepare(
      `SELECT s.*, c.name AS class_name FROM students s
       JOIN classes c ON c.id = s.class_id WHERE s.id = ?`
    )
    .get(req.user.id);
  if (!row) return res.status(401).json({ error: '账号不存在' });
  return res.json({ user: studentSummary(row) });
});

router.post('/password', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '未登录' });
  const oldPassword = String(req.body?.oldPassword || '');
  const newPassword = String(req.body?.newPassword || '');
  if (newPassword.length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
  const table = req.user.role === 'teacher' ? 'teachers' : 'students';
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.user.id);
  if (!row || !verifyPassword(oldPassword, row.password_hash)) {
    return res.status(400).json({ error: '原密码不正确' });
  }
  db.prepare(`UPDATE ${table} SET password_hash = ? WHERE id = ?`).run(
    hashPassword(newPassword),
    req.user.id
  );
  res.json({ ok: true });
});

export default router;
