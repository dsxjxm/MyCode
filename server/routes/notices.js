import { Router } from 'express';
import { db, now } from '../db.js';
import { requireTeacher } from '../auth.js';

const router = Router();

function noticeRows(where = '', params = []) {
  return db
    .prepare(
      `SELECT n.*, c.name AS class_name, t.name AS teacher_name
       FROM notices n
       LEFT JOIN classes c ON c.id = n.class_id
       LEFT JOIN teachers t ON t.id = n.teacher_id
       ${where}
       ORDER BY n.id DESC LIMIT 30`
    )
    .all(...params);
}

router.get('/', (req, res) => {
  if (!req.user) return res.status(401).json({ error: '未登录' });
  if (req.user.role === 'student') {
    const rows = db
      .prepare(
        `SELECT n.*, c.name AS class_name, t.name AS teacher_name
         FROM notices n
         LEFT JOIN classes c ON c.id = n.class_id
         LEFT JOIN teachers t ON t.id = n.teacher_id
         WHERE n.class_id IS NULL OR n.class_id = ?
         ORDER BY n.id DESC LIMIT 20`
      )
      .all(req.user.class_id);
    return res.json({ notices: rows });
  }
  res.json({ notices: noticeRows() });
});

router.post('/', requireTeacher, (req, res) => {
  const title = String(req.body?.title || '').trim();
  const content = String(req.body?.content || '').trim();
  const classId = req.body?.classId ? Number(req.body.classId) : null;
  if (!title) return res.status(400).json({ error: '请输入通知标题' });
  if (!content) return res.status(400).json({ error: '请输入通知内容' });
  if (classId && !db.prepare('SELECT id FROM classes WHERE id = ?').get(classId)) {
    return res.status(404).json({ error: '班级不存在' });
  }
  const result = db
    .prepare('INSERT INTO notices (teacher_id, class_id, title, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(req.user.id, classId, title, content, now());
  res.status(201).json({ id: Number(result.lastInsertRowid) });
});

router.delete('/:id', requireTeacher, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT id FROM notices WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: '通知不存在' });
  db.prepare('DELETE FROM notices WHERE id = ?').run(id);
  res.json({ ok: true });
});

router.get('/stats', requireTeacher, (req, res) => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const today = start.toISOString();
  const row = db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM classes) AS classes,
        (SELECT COUNT(*) FROM students) AS students,
        (SELECT COUNT(*) FROM students WHERE site_enabled = 1) AS sites,
        (SELECT COUNT(*) FROM students WHERE created_at >= ?) AS today_new,
        (SELECT COUNT(*) FROM students WHERE status = 'disabled') AS disabled,
        (SELECT COUNT(*) FROM notices) AS notices`
    )
    .get(today);
  res.json({ stats: row });
});

export default router;
