import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { db } from '../db.js';
import { buildPreviewToken, requireStudent } from '../auth.js';
import {
  decodeUploadName,
  listTree,
  readTextFile,
  removePath,
  resolveInside,
  sanitizeName,
  studentSpaceAbs,
  writeTextFile
} from '../storage.js';
import { getAccessLogs } from '../services/accessLog.js';
import { checkUploadName } from '../services/uploadRules.js';

const router = Router();
router.use(requireStudent);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

function context(req) {
  const row = db
    .prepare(
      `SELECT s.*, c.name AS class_name, c.folder AS class_folder
       FROM students s JOIN classes c ON c.id = s.class_id WHERE s.id = ?`
    )
    .get(req.user.id);
  if (!row) return null;
  return {
    row,
    wwwBase: path.join(studentSpaceAbs(row.class_folder, row.folder), 'www')
  };
}

function parseSettings(row) {
  let defaultDocs = ['index.html', 'index.htm'];
  let mimeTypes = {};
  try {
    defaultDocs = JSON.parse(row.default_docs) || defaultDocs;
  } catch {}
  try {
    mimeTypes = JSON.parse(row.mime_types) || {};
  } catch {}
  return {
    siteEnabled: row.site_enabled === 1,
    directoryBrowsing: row.directory_browsing === 1,
    defaultDocs,
    mimeTypes
  };
}

router.get('/files', (req, res) => {
  const ctx = context(req);
  if (!ctx) return res.status(401).json({ error: '学生不存在' });
  res.json({
    files: listTree(ctx.wwwBase),
    spacePath: ctx.row.folder,
    settings: parseSettings(ctx.row),
    previewToken: buildPreviewToken(ctx.row.id)
  });
});

router.get('/file', (req, res) => {
  const ctx = context(req);
  if (!ctx) return res.status(401).json({ error: '学生不存在' });
  const abs = resolveInside(ctx.wwwBase, req.query.path || '');
  if (!abs || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    return res.status(404).json({ error: '文件不存在' });
  }
  try {
    res.json({ path: req.query.path, content: readTextFile(abs) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/file', (req, res) => {
  const ctx = context(req);
  if (!ctx) return res.status(401).json({ error: '学生不存在' });
  const relPath = String(req.body?.path || '').trim();
  if (!relPath) return res.status(400).json({ error: '缺少文件路径' });
  const abs = resolveInside(ctx.wwwBase, relPath);
  if (!abs) return res.status(400).json({ error: '非法路径' });
  writeTextFile(abs, req.body?.content ?? '');
  res.json({ ok: true, path: relPath, mtime: Date.now() });
});

router.post('/new', (req, res) => {
  const ctx = context(req);
  if (!ctx) return res.status(401).json({ error: '学生不存在' });
  const relPath = String(req.body?.path || '').trim();
  const type = req.body?.type === 'dir' ? 'dir' : 'file';
  if (!relPath) return res.status(400).json({ error: '请输入名称' });
  const abs = resolveInside(ctx.wwwBase, relPath);
  if (!abs || abs === path.resolve(ctx.wwwBase)) return res.status(400).json({ error: '非法路径' });
  if (fs.existsSync(abs)) return res.status(409).json({ error: '同名文件或文件夹已存在' });
  if (type === 'dir') {
    fs.mkdirSync(abs, { recursive: true });
  } else {
    writeTextFile(abs, '');
  }
  res.status(201).json({ ok: true, path: relPath, type });
});

router.post('/delete', (req, res) => {
  const ctx = context(req);
  if (!ctx) return res.status(401).json({ error: '学生不存在' });
  const relPath = String(req.body?.path || '').trim();
  if (!relPath) return res.status(400).json({ error: '缺少路径' });
  const abs = resolveInside(ctx.wwwBase, relPath);
  if (!abs || abs === path.resolve(ctx.wwwBase)) return res.status(400).json({ error: '非法路径' });
  if (!fs.existsSync(abs)) return res.status(404).json({ error: '文件不存在' });
  removePath(abs);
  res.json({ ok: true });
});

router.post('/upload', upload.single('file'), (req, res) => {
  const ctx = context(req);
  if (!ctx) return res.status(401).json({ error: '学生不存在' });
  if (!req.file) return res.status(400).json({ error: '请选择要上传的文件' });
  const rule = checkUploadName(decodeUploadName(path.basename(req.file.originalname)));
  if (!rule.ok) return res.status(400).json({ error: rule.error });
  const dirRel = String(req.body?.path || '');
  const dirAbs = resolveInside(ctx.wwwBase, dirRel);
  if (!dirAbs) return res.status(400).json({ error: '非法路径' });
  if (fs.existsSync(dirAbs) && !fs.statSync(dirAbs).isDirectory()) {
    return res.status(400).json({ error: '上传目标不是文件夹' });
  }
  fs.mkdirSync(dirAbs, { recursive: true });
  const filename = sanitizeName(decodeUploadName(path.basename(req.file.originalname)), 'upload.bin');
  const abs = resolveInside(dirAbs, filename);
  if (!abs) return res.status(400).json({ error: '非法文件名' });
  fs.writeFileSync(abs, req.file.buffer);
  res.status(201).json({ ok: true, path: path.relative(ctx.wwwBase, abs).split(path.sep).join('/') });
});

router.post('/rename', (req, res) => {
  const ctx = context(req);
  if (!ctx) return res.status(401).json({ error: '学生不存在' });
  const relPath = String(req.body?.path || '').trim();
  const newName = String(req.body?.newName || '').trim();
  if (!relPath) return res.status(400).json({ error: '缺少原路径' });
  if (!newName || /[\\/]/.test(newName) || newName === '.' || newName === '..') {
    return res.status(400).json({ error: '名称不合法（不能包含斜杠）' });
  }
  const abs = resolveInside(ctx.wwwBase, relPath);
  if (!abs || abs === path.resolve(ctx.wwwBase)) return res.status(400).json({ error: '非法路径' });
  if (!fs.existsSync(abs)) return res.status(404).json({ error: '文件或文件夹不存在' });
  const parentRel = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
  const newRel = parentRel ? `${parentRel}/${newName}` : newName;
  const newAbs = resolveInside(ctx.wwwBase, newRel);
  if (!newAbs) return res.status(400).json({ error: '非法路径' });
  if (fs.existsSync(newAbs)) return res.status(409).json({ error: '同名文件或文件夹已存在' });
  fs.renameSync(abs, newAbs);
  res.json({ ok: true, path: newRel });
});

router.get('/download', (req, res) => {
  const ctx = context(req);
  if (!ctx) return res.status(401).json({ error: '学生不存在' });
  const abs = resolveInside(ctx.wwwBase, req.query.path || '');
  if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return res.status(404).json({ error: '文件不存在' });
  }
  res.download(abs, path.basename(abs));
});

router.get('/logs', (req, res) => {
  const ctx = context(req);
  if (!ctx) return res.status(401).json({ error: '学生不存在' });
  res.json({ logs: getAccessLogs(ctx.row.id, 60) });
});

router.get('/settings', (req, res) => {
  const ctx = context(req);
  if (!ctx) return res.status(401).json({ error: '学生不存在' });
  res.json({ settings: parseSettings(ctx.row) });
});

router.put('/settings', (req, res) => {
  const ctx = context(req);
  if (!ctx) return res.status(401).json({ error: '学生不存在' });
  const settings = parseSettings(ctx.row);

  const siteEnabled =
    typeof req.body?.siteEnabled === 'boolean' ? req.body.siteEnabled : settings.siteEnabled;
  const directoryBrowsing =
    typeof req.body?.directoryBrowsing === 'boolean'
      ? req.body.directoryBrowsing
      : settings.directoryBrowsing;

  let defaultDocs = settings.defaultDocs;
  if (Array.isArray(req.body?.defaultDocs)) {
    defaultDocs = req.body.defaultDocs
      .map((name) => String(name).trim())
      .filter((name) => name && !/[\\/]/.test(name) && name !== '..' && name !== '.')
      .slice(0, 10);
    if (defaultDocs.length === 0) defaultDocs = ['index.html'];
  }

  let mimeTypes = settings.mimeTypes;
  if (req.body?.mimeTypes && typeof req.body.mimeTypes === 'object') {
    mimeTypes = {};
    for (const [rawKey, rawValue] of Object.entries(req.body.mimeTypes).slice(0, 50)) {
      const key = String(rawKey).trim().toLowerCase().replace(/^\./, '');
      const value = String(rawValue).trim();
      if (/^[a-z0-9]+$/.test(key) && /^[\w.+-]+\/[\w.+-]+(\s*;\s*[\w=.+-]+)*$/.test(value)) {
        mimeTypes[key] = value;
      }
    }
  }

  db.prepare(
    `UPDATE students SET site_enabled = ?, directory_browsing = ?, default_docs = ?, mime_types = ?
     WHERE id = ?`
  ).run(
    siteEnabled ? 1 : 0,
    directoryBrowsing ? 1 : 0,
    JSON.stringify(defaultDocs),
    JSON.stringify(mimeTypes),
    ctx.row.id
  );
  const fresh = db.prepare('SELECT * FROM students WHERE id = ?').get(ctx.row.id);
  res.json({ settings: parseSettings(fresh) });
});

export default router;
