import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { db } from '../db.js';
import { verifyPreviewToken } from '../auth.js';
import { resolveInside, studentSpaceAbs } from '../storage.js';
import { logAccess } from '../services/accessLog.js';

const router = Router();

const BASE_MIME = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  pdf: 'application/pdf',
  wasm: 'application/wasm',
  zip: 'application/zip'
};

const SANDBOX_CSP = 'sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[ch]);
}

function page(title, heading, message) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>${escapeHtml(title)}</title>
<style>
body{font-family:"Segoe UI","Microsoft YaHei",sans-serif;background:#f5f6f8;color:#1f2937;margin:0;padding:60px 24px;}
.box{max-width:720px;margin:0 auto;background:#fff;border-left:6px solid #2563eb;border-radius:6px;padding:36px 40px;box-shadow:0 2px 14px rgba(0,0,0,.08);}
h1{font-size:22px;margin:0 0 14px;}
p{color:#6b7280;line-height:1.8;font-size:15px;}
code{background:#f3f4f6;padding:2px 6px;border-radius:4px;color:#b91c1c;}
</style></head><body><div class="box"><h1>${escapeHtml(heading)}</h1><p>${message}</p></div></body></html>`;
}

function dirListing(relPath, entries, token) {
  const base = `/preview/${encodeURIComponent(token)}/`;
  const rows = entries
    .map((entry) => {
      const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
      const href = `${base}${childRel.split('/').map(encodeURIComponent).join('/')}${entry.type === 'dir' ? '/' : ''}`;
      const size = entry.type === 'file' ? `${entry.size} B` : '&lt;文件夹&gt;';
      return `<tr><td><a href="${href}">${escapeHtml(entry.name)}${entry.type === 'dir' ? '/' : ''}</a></td><td>${size}</td><td>${entry.mtime ? new Date(entry.mtime).toLocaleString('zh-CN') : ''}</td></tr>`;
    })
    .join('');
  const parent = relPath
    ? `<p><a href="${base}${relPath.split('/').slice(0, -1).map(encodeURIComponent).join('/')}${relPath.includes('/') ? '/' : ''}">← 返回上级目录</a></p>`
    : '';
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>目录浏览 - /${escapeHtml(relPath)}</title>
<style>
body{font-family:"Segoe UI","Microsoft YaHei",sans-serif;margin:32px;color:#1f2937;background:#fff;}
h1{font-size:20px;border-bottom:2px solid #e5e7eb;padding-bottom:10px;}
table{border-collapse:collapse;width:100%;margin-top:16px;font-size:14px;}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid #eef0f3;}
th{background:#f8fafc;color:#64748b;font-weight:600;}
a{color:#2563eb;text-decoration:none;}a:hover{text-decoration:underline;}
.muted{color:#9ca3af;font-size:13px;margin-top:20px;}
</style></head><body>
<h1>目录浏览：/${escapeHtml(relPath || '')}</h1>
${parent}
<table><thead><tr><th>名称</th><th>大小</th><th>修改时间</th></tr></thead><tbody>${rows || '<tr><td colspan="3">空目录</td></tr>'}</tbody></table>
<p class="muted">这是 IIS 模拟的目录浏览页面。可在“站点设置”中关闭目录浏览。</p>
</body></html>`;
}

function servePreview(req, res) {
  const tokenData = verifyPreviewToken(req.params.token);
  if (!tokenData) {
    return res
      .status(403)
      .type('html')
      .send(page('链接已过期', 'HTTP 错误 403. 链接已过期', '预览链接无效或已过期，请回到工作台刷新预览。'));
  }
  const student = db
    .prepare(
      `SELECT s.*, c.folder AS class_folder FROM students s
       JOIN classes c ON c.id = s.class_id WHERE s.id = ?`
    )
    .get(tokenData.sid);
  if (!student) {
    return res
      .status(404)
      .type('html')
      .send(page('未找到站点', 'HTTP 错误 404. 未找到站点', '学生空间不存在。'));
  }
  if (student.site_enabled !== 1) {
    logAccess(student.id, { path: '/', status: 503, note: '站点已停止' });
    return res
      .status(503)
      .type('html')
      .send(
        page(
          '服务不可用',
          'HTTP 错误 503. 服务不可用',
          '该站点当前已停止。请回到工作台，在<code>站点设置</code>中启动 WWW 服务后重新预览。'
        )
      );
  }

  const base = path.join(studentSpaceAbs(student.class_folder, student.folder), 'www');
  const relPath = String(req.params[0] || '').replace(/^\/+/, '').replace(/\/+$/, '');
  const abs = resolveInside(base, relPath);
  if (!abs) {
    logAccess(student.id, { path: `/${relPath}`, status: 403, note: '非法路径' });
    return res
      .status(403)
      .type('html')
      .send(page('禁止访问', 'HTTP 错误 403. 禁止访问', '请求的路径不合法。'));
  }

  let mimeOverrides = {};
  try {
    mimeOverrides = JSON.parse(student.mime_types) || {};
  } catch {}
  let defaultDocs = ['index.html', 'index.htm'];
  try {
    defaultDocs = JSON.parse(student.default_docs) || defaultDocs;
  } catch {}

  let target = abs;
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    const found = defaultDocs
      .map((name) => path.join(target, name))
      .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (found) {
      target = found;
    } else if (student.directory_browsing === 1) {
      const entries = fs
        .readdirSync(target, { withFileTypes: true })
        .map((entry) => {
          const entryAbs = path.join(target, entry.name);
          const stat = fs.statSync(entryAbs);
          return {
            name: entry.name,
            type: entry.isDirectory() ? 'dir' : 'file',
            size: stat.size,
            mtime: stat.mtimeMs
          };
        })
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'zh-CN') : a.type === 'dir' ? -1 : 1));
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', SANDBOX_CSP);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      logAccess(student.id, { path: `/${relPath}`, status: 200, note: '目录浏览', size: entries.length });
      return res.send(dirListing(relPath, entries, req.params.token));
    } else {
      logAccess(student.id, { path: `/${relPath}`, status: 403, note: '无默认文档且目录浏览关闭' });
      return res
        .status(403)
        .type('html')
        .send(
          page(
            '禁止访问',
            'HTTP 错误 403. 禁止访问',
            '该目录未设置默认文档，且目录浏览已关闭。请添加 <code>index.html</code>，或在站点设置中开启目录浏览。'
          )
        );
    }
  }

  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    logAccess(student.id, { path: `/${relPath}`, status: 404, note: '文件不存在' });
    return res
      .status(404)
      .type('html')
      .send(
        page('未找到文件', 'HTTP 错误 404. 未找到文件', `请求的地址 <code>/${escapeHtml(relPath)}</code> 不存在。`)
      );
  }

  const ext = path.extname(target).slice(1).toLowerCase();
  let contentType = mimeOverrides[ext] || BASE_MIME[ext] || 'application/octet-stream';
  if (/^(text\/|application\/(json|javascript|xml))/.test(contentType) && !/charset=/i.test(contentType)) {
    contentType += '; charset=utf-8';
  }
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Security-Policy', SANDBOX_CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  const size = fs.statSync(target).size;
  logAccess(student.id, { path: `/${path.relative(base, target).split(path.sep).join('/')}`, status: 200, note: contentType.split(';')[0], size });
  res.send(fs.readFileSync(target));
}

router.get('/:token/', servePreview);
router.get('/:token/*', servePreview);

export default router;
