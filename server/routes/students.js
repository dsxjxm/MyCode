import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import * as archiverModule from 'archiver';

const archiver = archiverModule.default || archiverModule;

// 兼容 archiver 5（默认导出函数）与 archiver 8（导出 ZipArchive 类）
function createZip(opts = {}) {
  return archiver.ZipArchive ? new archiver.ZipArchive(opts) : archiver('zip', opts);
}
import { db, now } from '../db.js';
import { buildPreviewToken, requireTeacher } from '../auth.js';
import { hashPassword } from '../password.js';
import {
  buildExport,
  buildTemplate,
  contentDisposition,
  readRows,
  rowsToStudents
} from '../importExport.js';
import {
  createStudentFolder,
  listTree,
  moveToTrash,
  readTextFile,
  resolveInside,
  studentSpaceAbs
} from '../storage.js';

const router = Router();
router.use(requireTeacher);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function getStudent(id) {
  return db
    .prepare(
      `SELECT s.*, c.name AS class_name, c.folder AS class_folder
       FROM students s JOIN classes c ON c.id = s.class_id WHERE s.id = ?`
    )
    .get(id);
}

function publicStudent(row) {
  if (!row) return row;
  const { password_hash, ...rest } = row;
  return rest;
}

function createStudent({ classId, studentNo, name, username, password, status = 'active' }) {
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
  if (!cls) {
    const err = new Error('班级不存在');
    err.status = 404;
    throw err;
  }
  if (db.prepare('SELECT id FROM students WHERE username = ?').get(username)) {
    const err = new Error(`账号 ${username} 已存在`);
    err.status = 409;
    throw err;
  }
  if (db.prepare('SELECT id FROM students WHERE class_id = ? AND student_no = ?').get(classId, studentNo)) {
    const err = new Error(`学号 ${studentNo} 在该班级已存在`);
    err.status = 409;
    throw err;
  }

  const result = db
    .prepare(
      `INSERT INTO students (class_id, student_no, name, username, password_hash, folder, status, created_at)
       VALUES (?, ?, ?, ?, ?, '', ?, ?)`
    )
    .run(classId, studentNo, name, username, hashPassword(password), status, now());
  const id = Number(result.lastInsertRowid);
  try {
    const folder = createStudentFolder(cls.folder, studentNo, name);
    db.prepare('UPDATE students SET folder = ? WHERE id = ?').run(folder, id);
  } catch (err) {
    db.prepare('DELETE FROM students WHERE id = ?').run(id);
    throw err;
  }
  return getStudent(id);
}

router.get('/', (req, res) => {
  const classId = Number(req.query.classId) || 0;
  const rows = classId
    ? db
        .prepare(
          `SELECT s.id, s.class_id, s.student_no, s.name, s.username, s.folder, s.status,
                  s.site_enabled, s.created_at, c.name AS class_name
           FROM students s JOIN classes c ON c.id = s.class_id
           WHERE s.class_id = ? ORDER BY s.student_no`
        )
        .all(classId)
    : db
        .prepare(
          `SELECT s.id, s.class_id, s.student_no, s.name, s.username, s.folder, s.status,
                  s.site_enabled, s.created_at, c.name AS class_name
           FROM students s JOIN classes c ON c.id = s.class_id
           ORDER BY c.id DESC, s.student_no`
        )
        .all();
  res.json({ students: rows });
});

router.get('/template', (req, res) => {
  const format = req.query.format === 'csv' ? 'csv' : 'xlsx';
  const file = buildTemplate(format);
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Content-Disposition', contentDisposition(`学生导入模板.${file.ext}`));
  res.send(file.buffer);
});

router.get('/export', (req, res) => {
  const format = req.query.format === 'csv' ? 'csv' : 'xlsx';
  const classId = Number(req.query.classId) || 0;
  let rows;
  let label = '全部班级';
  if (classId) {
    const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(classId);
    if (!cls) return res.status(404).json({ error: '班级不存在' });
    label = cls.name;
    rows = db
      .prepare('SELECT * FROM students WHERE class_id = ? ORDER BY student_no')
      .all(classId)
      .map((s) => ({ ...s, class_name: cls.name }));
  } else {
    rows = db
      .prepare(
        `SELECT s.*, c.name AS class_name FROM students s
         JOIN classes c ON c.id = s.class_id ORDER BY c.id, s.student_no`
      )
      .all();
  }
  const file = buildExport(format, rows, { classLabel: label });
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Content-Disposition', contentDisposition(`${label}_学生名单_${stamp}.${file.ext}`));
  res.send(file.buffer);
});

router.post('/import', upload.single('file'), (req, res, next) => {
  try {
    const classId = Number(req.body?.classId);
    if (!classId) return res.status(400).json({ error: '请先选择班级' });
    if (!req.file) return res.status(400).json({ error: '请上传名单文件（.xlsx 或 .csv）' });
    const defaultPassword = String(req.body?.defaultPassword || '123456');

    const rows = readRows(req.file.originalname, req.file.buffer);
    const { records, warnings } = rowsToStudents(rows);
    if (records.length === 0) {
      return res.status(400).json({ error: '未读取到有效的学生数据，请检查表头（学号、姓名）', warnings });
    }

    const created = [];
    const skipped = [...warnings];
    for (const record of records) {
      try {
        const student = createStudent({
          classId,
          studentNo: record.studentNo,
          name: record.name,
          username: record.username,
          password: record.password || defaultPassword,
          status: record.status
        });
        created.push({ id: student.id, studentNo: student.student_no, name: student.name, username: student.username });
      } catch (err) {
        skipped.push({ studentNo: record.studentNo, name: record.name, reason: err.message });
      }
    }
    res.json({ created: created.length, students: created, skipped, defaultPassword });
  } catch (err) {
    next(err);
  }
});

router.post('/', (req, res) => {
  try {
    const classId = Number(req.body?.classId);
    const studentNo = String(req.body?.studentNo || '').trim();
    const name = String(req.body?.name || '').trim();
    const username = String(req.body?.username || studentNo).trim();
    const password = String(req.body?.password || '123456');
    const status = req.body?.status === 'disabled' ? 'disabled' : 'active';
    if (!classId) return res.status(400).json({ error: '请选择班级' });
    if (!studentNo || !name) return res.status(400).json({ error: '学号和姓名不能为空' });
    if (!username) return res.status(400).json({ error: '账号不能为空' });
    if (password.length < 4) return res.status(400).json({ error: '密码至少 4 位' });

    const student = createStudent({ classId, studentNo, name, username, password, status });
    res.status(201).json({ student: publicStudent(student) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = getStudent(id);
  if (!row) return res.status(404).json({ error: '学生不存在' });
  const studentNo = String(req.body?.studentNo ?? row.student_no).trim();
  const name = String(req.body?.name ?? row.name).trim();
  const username = String(req.body?.username ?? row.username).trim();
  const status = req.body?.status === 'disabled' ? 'disabled' : req.body?.status === 'active' ? 'active' : row.status;
  if (!studentNo || !name || !username) return res.status(400).json({ error: '学号、姓名、账号不能为空' });

  if (db.prepare('SELECT id FROM students WHERE username = ? AND id <> ?').get(username, id)) {
    return res.status(409).json({ error: '账号已存在' });
  }
  if (
    db
      .prepare('SELECT id FROM students WHERE class_id = ? AND student_no = ? AND id <> ?')
      .get(row.class_id, studentNo, id)
  ) {
    return res.status(409).json({ error: '该班级下学号已存在' });
  }
  db.prepare('UPDATE students SET student_no = ?, name = ?, username = ?, status = ? WHERE id = ?').run(
    studentNo,
    name,
    username,
    status,
    id
  );
  res.json({ student: publicStudent(getStudent(id)) });
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = getStudent(id);
  if (!row) return res.status(404).json({ error: '学生不存在' });
  moveToTrash(studentSpaceAbs(row.class_folder, row.folder), `${row.name}_${row.student_no}`);
  db.prepare('DELETE FROM students WHERE id = ?').run(id);
  res.json({ ok: true });
});

router.post('/:id/reset-password', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT id FROM students WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: '学生不存在' });
  const password = String(req.body?.password || '123456');
  if (password.length < 4) return res.status(400).json({ error: '密码至少 4 位' });
  db.prepare('UPDATE students SET password_hash = ? WHERE id = ?').run(hashPassword(password), id);
  res.json({ ok: true, password });
});

router.get('/:id/files', (req, res) => {
  const row = getStudent(Number(req.params.id));
  if (!row) return res.status(404).json({ error: '学生不存在' });
  const base = path.join(studentSpaceAbs(row.class_folder, row.folder), 'www');
  res.json({ files: listTree(base), spacePath: row.folder });
});

router.get('/:id/file', (req, res) => {
  const row = getStudent(Number(req.params.id));
  if (!row) return res.status(404).json({ error: '学生不存在' });
  const base = path.join(studentSpaceAbs(row.class_folder, row.folder), 'www');
  const abs = resolveInside(base, req.query.path || '');
  if (!abs || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    return res.status(404).json({ error: '文件不存在' });
  }
  if (req.query.download === '1') {
    res.setHeader('Content-Disposition', contentDisposition(path.basename(abs)));
    return res.sendFile(abs);
  }
  try {
    res.json({ path: req.query.path, content: readTextFile(abs) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/:id/download-zip', (req, res) => {
  const row = getStudent(Number(req.params.id));
  if (!row) return res.status(404).json({ error: '学生不存在' });
  const base = path.join(studentSpaceAbs(row.class_folder, row.folder), 'www');
  if (!fs.existsSync(base)) return res.status(404).json({ error: '空间目录不存在' });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', contentDisposition(`${row.student_no}_${row.name}_www.zip`));
  const archive = createZip({ zlib: { level: 9 } });
  archive.on('error', () => res.destroy());
  archive.pipe(res);
  archive.directory(base, false);
  archive.finalize();
});

router.get('/:id/preview-token', (req, res) => {
  const row = getStudent(Number(req.params.id));
  if (!row) return res.status(404).json({ error: '学生不存在' });
  const token = buildPreviewToken(row.id);
  res.json({ url: `/preview/${token}/` });
});

// 教师查看学生 FTP 空间（只读：列表 / 预览 / 下载 / 打包），路径穿越防护复用 resolveInside
function ftpBaseOf(row) {
  return path.join(studentSpaceAbs(row.class_folder, row.folder), 'ftp');
}

router.get('/:id/ftp/files', (req, res) => {
  const row = getStudent(Number(req.params.id));
  if (!row) return res.status(404).json({ error: '学生不存在' });
  res.json({ files: listTree(ftpBaseOf(row)), spacePath: row.folder });
});

router.get('/:id/ftp/file', (req, res) => {
  const row = getStudent(Number(req.params.id));
  if (!row) return res.status(404).json({ error: '学生不存在' });
  const base = ftpBaseOf(row);
  const abs = resolveInside(base, req.query.path || '');
  if (!abs || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    return res.status(404).json({ error: '文件不存在' });
  }
  if (req.query.download === '1') {
    res.setHeader('Content-Disposition', contentDisposition(path.basename(abs)));
    return res.sendFile(abs);
  }
  try {
    res.json({ path: req.query.path, content: readTextFile(abs) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/:id/ftp/download-zip', (req, res) => {
  const row = getStudent(Number(req.params.id));
  if (!row) return res.status(404).json({ error: '学生不存在' });
  const base = ftpBaseOf(row);
  if (!fs.existsSync(base)) return res.status(404).json({ error: '空间目录不存在' });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', contentDisposition(`${row.student_no}_${row.name}_ftp.zip`));
  const archive = createZip({ zlib: { level: 9 } });
  archive.on('error', () => res.destroy());
  archive.pipe(res);
  archive.directory(base, false);
  archive.finalize();
});

export default router;
