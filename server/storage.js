import fs from 'node:fs';
import path from 'node:path';
import { CLASSES_DIR, TRASH_DIR } from './paths.js';

export const STUDENT_SUBDIRS = ['www', 'ftp', 'homework', 'design'];

export function sanitizeName(input, fallback = '未命名') {
  const cleaned = String(input ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .replace(/^\.+$/, '');
  return (cleaned || fallback).slice(0, 60);
}

function uniquePath(baseDir, desired) {
  let candidate = path.join(baseDir, desired);
  let i = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(baseDir, `${desired}_${i}`);
    i += 1;
  }
  return candidate;
}

export function createClassFolder(className) {
  fs.mkdirSync(CLASSES_DIR, { recursive: true });
  const abs = uniquePath(CLASSES_DIR, sanitizeName(className, '班级'));
  fs.mkdirSync(abs, { recursive: true });
  return path.basename(abs);
}

export function createStudentFolder(classFolder, studentNo, studentName) {
  const classAbs = path.join(CLASSES_DIR, classFolder);
  fs.mkdirSync(classAbs, { recursive: true });
  const desired = `${sanitizeName(studentNo, '学号')}_${sanitizeName(studentName, '姓名')}`;
  const abs = uniquePath(classAbs, desired);
  fs.mkdirSync(abs, { recursive: true });
  for (const sub of STUDENT_SUBDIRS) {
    fs.mkdirSync(path.join(abs, sub), { recursive: true });
  }
  seedStarterSite(path.join(abs, 'www'));
  return path.basename(abs);
}

export function studentSpaceAbs(classFolder, studentFolder) {
  return path.join(CLASSES_DIR, classFolder, studentFolder);
}

export function studentSubdirAbs(classFolder, studentFolder, sub) {
  return path.join(studentSpaceAbs(classFolder, studentFolder), sub);
}

export function moveToTrash(absPath, label = '') {
  if (!fs.existsSync(absPath)) return null;
  fs.mkdirSync(TRASH_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const target = path.join(TRASH_DIR, `${stamp}_${sanitizeName(label || path.basename(absPath))}`);
  fs.renameSync(absPath, target);
  return target;
}

export function resolveInside(baseAbs, relPath = '') {
  let rel = String(relPath || '');
  try {
    rel = decodeURIComponent(rel);
  } catch {
    return null;
  }
  rel = rel.replace(/^[/\\]+/, '');
  if (rel.includes('\u0000')) return null;
  const abs = path.resolve(baseAbs, rel);
  const base = path.resolve(baseAbs);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

export function listTree(baseAbs, relBase = '', depth = 0) {
  if (depth > 8) return [];
  const abs = path.join(baseAbs, relBase);
  if (!fs.existsSync(abs)) return [];
  const entries = fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
  const out = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push({ path: rel, name: entry.name, type: 'dir' });
      out.push(...listTree(baseAbs, rel, depth + 1));
    } else if (entry.isFile()) {
      const stat = fs.statSync(path.join(baseAbs, rel));
      out.push({ path: rel, name: entry.name, type: 'file', size: stat.size, mtime: stat.mtimeMs });
    }
  }
  return out;
}

export function readTextFile(abs, limit = 2 * 1024 * 1024) {
  const stat = fs.statSync(abs);
  if (stat.size > limit) throw new Error('文件超过 2MB，无法在编辑器中打开');
  const buffer = fs.readFileSync(abs);
  if (buffer.includes(0)) throw new Error('该文件是二进制文件，无法编辑');
  return buffer.toString('utf8');
}

export function writeTextFile(abs, content) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, String(content ?? ''), 'utf8');
}

function seedStarterSite(wwwAbs) {
  const indexPath = path.join(wwwAbs, 'index.html');
  if (fs.existsSync(indexPath)) return;

  fs.mkdirSync(path.join(wwwAbs, 'css'), { recursive: true });
  fs.mkdirSync(path.join(wwwAbs, 'js'), { recursive: true });
  fs.mkdirSync(path.join(wwwAbs, 'images'), { recursive: true });

  fs.writeFileSync(
    indexPath,
    `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>我的第一个网页</title>
  <link rel="stylesheet" href="css/style.css">
</head>
<body>
  <main class="card">
    <h1>你好，<span id="who">同学</span>！</h1>
    <p>这是你的 WWW 实训站点。左侧修改 HTML / CSS / JS，右侧实时查看渲染效果。</p>
    <button id="btn">点我试试</button>
    <p id="msg" class="msg"></p>
  </main>
  <script src="js/main.js"></script>
</body>
</html>
`,
    'utf8'
  );

  fs.writeFileSync(
    path.join(wwwAbs, 'css', 'style.css'),
    `* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
  background: linear-gradient(135deg, #e0f2fe, #ede9fe);
}
.card {
  width: min(520px, 90vw);
  padding: 32px;
  border-radius: 16px;
  background: #ffffff;
  box-shadow: 0 16px 40px rgba(15, 23, 42, 0.12);
  text-align: center;
}
h1 { margin: 0 0 12px; color: #0f172a; font-size: 26px; }
p { color: #475569; line-height: 1.7; }
button {
  padding: 10px 26px;
  border: none;
  border-radius: 999px;
  background: #2563eb;
  color: #fff;
  font-size: 15px;
  cursor: pointer;
}
button:hover { background: #1d4ed8; }
.msg { min-height: 24px; color: #16a34a; font-weight: 600; }
`,
    'utf8'
  );

  fs.writeFileSync(
    path.join(wwwAbs, 'js', 'main.js'),
    `const who = document.getElementById('who');
const btn = document.getElementById('btn');
const msg = document.getElementById('msg');

// 试试修改这里，点击保存后右边会立即刷新
who.textContent = '世界';

btn.addEventListener('click', () => {
  msg.textContent = '按钮点击成功！现在你可以修改 CSS 和 JS 了。';
});
`,
    'utf8'
  );
}
