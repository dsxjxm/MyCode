import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { db, now } from '../db.js';
import { requireTeacher } from '../auth.js';
import { CLASSES_DIR } from '../paths.js';
import { createClassFolder, moveToTrash } from '../storage.js';

const router = Router();
router.use(requireTeacher);

router.get('/', (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id) AS student_count
       FROM classes c ORDER BY c.id DESC`
    )
    .all();
  res.json({ classes: rows });
});

router.post('/', (req, res) => {
  const name = String(req.body?.name || '').trim();
  const grade = String(req.body?.grade || '').trim();
  const description = String(req.body?.description || '').trim();
  if (!name) return res.status(400).json({ error: '班级名称不能为空' });
  if (db.prepare('SELECT id FROM classes WHERE name = ?').get(name)) {
    return res.status(409).json({ error: '班级名称已存在' });
  }

  const folder = createClassFolder(name);
  try {
    const result = db
      .prepare('INSERT INTO classes (name, grade, description, folder, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(name, grade, description, folder, now());
    const row = db.prepare('SELECT * FROM classes WHERE id = ?').get(Number(result.lastInsertRowid));
    res.status(201).json({ class: row });
  } catch (err) {
    fs.rmSync(path.join(CLASSES_DIR, folder), { recursive: true, force: true });
    res.status(500).json({ error: '创建班级失败：' + err.message });
  }
});

router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM classes WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: '班级不存在' });
  const name = String(req.body?.name ?? row.name).trim();
  if (!name) return res.status(400).json({ error: '班级名称不能为空' });
  const dup = db.prepare('SELECT id FROM classes WHERE name = ? AND id <> ?').get(name, id);
  if (dup) return res.status(409).json({ error: '班级名称已存在' });
  db.prepare('UPDATE classes SET name = ?, grade = ?, description = ? WHERE id = ?').run(
    name,
    String(req.body?.grade ?? row.grade).trim(),
    String(req.body?.description ?? row.description).trim(),
    id
  );
  res.json({ class: db.prepare('SELECT * FROM classes WHERE id = ?').get(id) });
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM classes WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: '班级不存在' });
  const count = db.prepare('SELECT COUNT(*) AS c FROM students WHERE class_id = ?').get(id).c;
  if (count > 0 && req.query.force !== '1') {
    return res.status(409).json({
      error: `该班级下还有 ${count} 名学生，删除后学生账号与空间将移入回收站`,
      studentCount: count,
      needConfirm: true
    });
  }
  if (row.folder) moveToTrash(path.join(CLASSES_DIR, row.folder), row.name);
  db.prepare('DELETE FROM classes WHERE id = ?').run(id);
  res.json({ ok: true });
});

export default router;
