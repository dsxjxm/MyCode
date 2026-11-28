import { Router } from 'express';
import multer from 'multer';
import { db } from '../db.js';
import { requireStudent } from '../auth.js';
import { verifyPassword } from '../password.js';
import { createVfs } from '../services/vfs.js';
import { execFtp, initFtpState } from '../services/ftpSim.js';
import { execTelnet, initTelnetState } from '../services/telnetSim.js';
import { checkUploadName } from '../services/uploadRules.js';

const router = Router();
router.use(requireStudent);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

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
    vfs: createVfs(row.class_folder, row.folder)
  };
}

router.post('/exec', (req, res) => {
  const ctx = context(req);
  if (!ctx) return res.status(401).json({ error: '学生不存在' });

  const { mode = 'ftp', command = '', state, upload } = req.body || {};
  if (upload && upload.name) {
    const rule = checkUploadName(upload.name);
    if (!rule.ok) return res.status(400).json({ error: rule.error });
  }
  const deps = {
    vfs: ctx.vfs,
    hostName: 'student-ftp',
    studentName: ctx.row.name,
    auth: (username, password) => {
      if (username !== ctx.row.username) return false;
      return verifyPassword(password, ctx.row.password_hash);
    }
  };

  let result;
  if (mode === 'telnet') {
    const s = state && typeof state === 'object' ? state : initTelnetState();
    result = execTelnet(s, command, deps, upload);
  } else {
    const s = state && typeof state === 'object' ? state : initFtpState();
    result = execFtp(s, command, deps, upload);
  }
  res.json(result);
});

// 上传文件（put 命令用）：前端把本地文件读成文本后也可走 /exec 的 upload 字段；
// 此路由用于直接接收 multipart 文件，返回内容供前端组装 put 请求。
router.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未选择文件' });
  const rule = checkUploadName(req.file.originalname);
  if (!rule.ok) return res.status(400).json({ error: rule.error });
  const buf = req.file.buffer;
  const isBinary = buf.includes(0);
  if (isBinary) {
    return res.json({ name: req.file.originalname, content: buf.toString('base64'), binary: true, size: buf.length });
  }
  res.json({ name: req.file.originalname, content: buf.toString('utf8'), binary: false, size: buf.length });
});

export default router;
