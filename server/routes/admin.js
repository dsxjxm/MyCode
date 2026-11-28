// 教师端运维接口：运行监控指标 + 学期归档（数据库快照）
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db, flushDb } from '../db.js';
import { requireTeacher } from '../auth.js';
import { ARCHIVE_DIR, DB_FILE, MAIL_ATTACH_DIR, TRASH_DIR } from '../paths.js';
import { metricsSnapshot } from '../services/metrics.js';
import {
  getAllowedExtensions,
  getUploadFileSizeConfig,
  saveAllowedExtensions,
  saveUploadFileSizeConfig,
  validateUploadFileSizeConfig
} from '../services/uploadRules.js';

const router = Router();
router.use(requireTeacher);

router.get('/metrics', (req, res) => {
  res.json(metricsSnapshot());
});

// 上传文件类型与大小限制
router.get('/upload-settings', (req, res) => {
  res.json({
    allowedExtensions: getAllowedExtensions(),
    fileSizeLimit: getUploadFileSizeConfig()
  });
});

router.put('/upload-settings', (req, res) => {
  const body = req.body || {};
  const hasExtensions = body.allowedExtensions != null || body.value != null;
  const hasFileSize = Object.prototype.hasOwnProperty.call(body, 'fileSizeLimit');
  let sizeConfig;
  if (hasFileSize) {
    try {
      sizeConfig = validateUploadFileSizeConfig(body.fileSizeLimit);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }
  if (hasExtensions) {
    const input = body.allowedExtensions != null ? body.allowedExtensions : body.value;
    saveAllowedExtensions(input);
  }
  if (sizeConfig) saveUploadFileSizeConfig(sizeConfig);
  res.json({
    ok: true,
    allowedExtensions: getAllowedExtensions(),
    fileSizeLimit: getUploadFileSizeConfig()
  });
});

// ==================== 学期归档 ====================

const ARCHIVE_RE = /^[A-Za-z0-9._\-\u4e00-\u9fa5]+\.db$/;

function isArchiveName(name) {
  return (
    typeof name === 'string' &&
    name.length <= 160 &&
    ARCHIVE_RE.test(name) &&
    name.indexOf('..') === -1
  );
}

function archivePath(name) {
  return path.join(ARCHIVE_DIR, name);
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function sanitizeSemester(input) {
  return String(input || '')
    .trim()
    .slice(0, 40)
    .replace(/[\\/:*?"<>|\s]+/g, '');
}

// 兼容 Node 12：递归删除目录内容（不使用 fs.rmSync）
function removeDirContents(dir) {
  let removed = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch (_) {
    return 0;
  }
  for (const name of entries) {
    const target = path.join(dir, name);
    try {
      const stat = fs.lstatSync(target);
      if (stat.isDirectory()) {
        removed += removeDirContents(target);
        fs.rmdirSync(target);
      } else {
        fs.unlinkSync(target);
        removed += 1;
      }
    } catch (_) {
      /* 单个文件失败不影响整体 */
    }
  }
  return removed;
}

function listArchives() {
  let files = [];
  try {
    files = fs.readdirSync(ARCHIVE_DIR);
  } catch (_) {
    return [];
  }
  const rows = [];
  for (const name of files) {
    if (!name.endsWith('.db')) continue;
    try {
      const stat = fs.statSync(path.join(ARCHIVE_DIR, name));
      rows.push({ name, size: stat.size, createdAt: stat.mtimeMs });
    } catch (_) {
      /* 忽略读取失败的文件 */
    }
  }
  rows.sort((a, b) => b.createdAt - a.createdAt);
  return rows;
}

router.get('/archives', (req, res) => {
  res.json({ archives: listArchives(), dir: ARCHIVE_DIR });
});

router.post('/archives', (req, res) => {
  const semester = sanitizeSemester(req.body && req.body.semester);
  const cleanupMail = Boolean(req.body && req.body.cleanupMail);
  const cleanupTrash = Boolean(req.body && req.body.cleanupTrash);

  // 先确保内存中的最新写入落盘，再复制整库快照
  flushDb();

  const name = `archive-${timestamp()}${semester ? '-' + semester : ''}.db`;
  const target = archivePath(name);
  try {
    fs.copyFileSync(DB_FILE, target);
  } catch (err) {
    return res.status(500).json({ error: `归档失败：${err.message}` });
  }

  const cleanup = { mailMessages: 0, mailAttachments: 0, trashEntries: 0 };
  try {
    if (cleanupMail) {
      cleanup.mailMessages = db.prepare('SELECT COUNT(*) AS c FROM mail_messages').get().c;
      db.prepare('DELETE FROM mail_messages').run(); // 级联清理 mail_mailboxes
      db.prepare('DELETE FROM mail_scheduled').run();
      db.prepare('DELETE FROM mail_login_codes').run();
      cleanup.mailAttachments = removeDirContents(MAIL_ATTACH_DIR);
    }
    if (cleanupTrash) {
      cleanup.trashEntries = removeDirContents(TRASH_DIR);
    }
    // 清理结果也需要落盘，否则重启后会恢复
    flushDb();
  } catch (err) {
    return res.status(500).json({
      error: `归档已生成，但清理失败：${err.message}`,
      archive: { name, size: safeSize(target), createdAt: Date.now() },
      cleanup
    });
  }

  res.json({
    ok: true,
    archive: { name, size: safeSize(target), createdAt: Date.now() },
    cleanup
  });
});

function safeSize(file) {
  try {
    return fs.statSync(file).size;
  } catch (_) {
    return 0;
  }
}

router.get('/archives/:name/download', (req, res) => {
  const name = req.params.name;
  if (!isArchiveName(name)) return res.status(400).json({ error: '归档文件名不合法' });
  const target = archivePath(name);
  if (!fs.existsSync(target)) return res.status(404).json({ error: '归档不存在' });
  res.download(target, name);
});

router.delete('/archives/:name', (req, res) => {
  const name = req.params.name;
  if (!isArchiveName(name)) return res.status(400).json({ error: '归档文件名不合法' });
  const target = archivePath(name);
  try {
    if (!fs.existsSync(target)) return res.status(404).json({ error: '归档不存在' });
    fs.unlinkSync(target);
  } catch (err) {
    return res.status(500).json({ error: `删除失败：${err.message}` });
  }
  res.json({ ok: true });
});

export default router;
