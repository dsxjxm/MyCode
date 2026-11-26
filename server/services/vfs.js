// 虚拟文件系统：基于每个学生的 ftp/ 目录，提供 FTP 模拟所需的文件操作
// 所有路径都是相对 ftp 根目录的相对路径，统一用 / 分隔
import fs from 'node:fs';
import path from 'node:path';
import { studentSpaceAbs, resolveInside, sanitizeName } from '../storage.js';

// 规范化相对路径：解析 . 和 ..，去掉重复/首尾斜杠，返回相对 ftp 根的路径（无首尾 /）
export function normalizeRel(input) {
  let p = String(input || '').replace(/\\/g, '/');
  p = p.replace(/^\/+/, '');
  const parts = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join('/');
}

// 拼接 cwd 与目标路径：以 / 开头视为从 ftp 根开始，否则相对 cwd
export function joinRel(cwd, target) {
  const t = String(target || '').replace(/\\/g, '/');
  if (t.startsWith('/')) return normalizeRel(t);
  const base = normalizeRel(cwd);
  return normalizeRel(base ? `${base}/${t}` : t);
}

export function createVfs(classFolder, studentFolder) {
  const root = path.join(studentSpaceAbs(classFolder, studentFolder), 'ftp');
  fs.mkdirSync(root, { recursive: true });

  // 把相对路径解析为受保护的绝对路径，越界返回 null
  function abs(rel) {
    return resolveInside(root, rel || '');
  }

  function list(rel) {
    const a = abs(rel);
    if (!a || !fs.existsSync(a)) return { error: '目录不存在' };
    const stat = fs.statSync(a);
    if (!stat.isDirectory()) return { error: '不是目录' };
    const entries = fs.readdirSync(a, { withFileTypes: true });
    const out = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const s = fs.statSync(path.join(a, e.name));
      out.push({
        name: e.name,
        type: e.isDirectory() ? 'dir' : 'file',
        size: s.size,
        mtime: s.mtime
      });
    }
    out.sort((x, y) =>
      x.type !== y.type ? (x.type === 'dir' ? -1 : 1) : x.name.localeCompare(y.name, 'zh-CN')
    );
    return { entries: out };
  }

  function exists(rel) {
    const a = abs(rel);
    return !!(a && fs.existsSync(a));
  }

  function isDir(rel) {
    const a = abs(rel);
    return !!(a && fs.existsSync(a) && fs.statSync(a).isDirectory());
  }

  function stat(rel) {
    const a = abs(rel);
    if (!a || !fs.existsSync(a)) return null;
    const s = fs.statSync(a);
    return { name: path.basename(a), type: s.isDirectory() ? 'dir' : 'file', size: s.size, mtime: s.mtime };
  }

  function mkdir(rel) {
    const a = abs(rel);
    if (!a) return { error: '路径非法' };
    if (fs.existsSync(a)) return { error: '目录已存在' };
    fs.mkdirSync(a, { recursive: true });
    return { ok: true };
  }

  function remove(rel) {
    const a = abs(rel);
    if (!a || !fs.existsSync(a)) return { error: '文件不存在' };
    const s = fs.statSync(a);
    if (s.isDirectory()) {
      if (fs.readdirSync(a).length > 0) return { error: '目录非空' };
      fs.rmdirSync(a);
    } else {
      fs.unlinkSync(a);
    }
    return { ok: true };
  }

  function rename(from, to) {
    const a = abs(from);
    const b = abs(to);
    if (!a || !b) return { error: '路径非法' };
    if (!fs.existsSync(a)) return { error: '源文件不存在' };
    if (fs.existsSync(b)) return { error: '目标已存在' };
    fs.renameSync(a, b);
    return { ok: true };
  }

  // 读取文件内容（限 2MB，二进制返回 null）
  function readText(rel) {
    const a = abs(rel);
    if (!a || !fs.existsSync(a)) return { error: '文件不存在' };
    const s = fs.statSync(a);
    if (s.isDirectory()) return { error: '是目录' };
    if (s.size > 2 * 1024 * 1024) return { error: '文件超过 2MB' };
    const buf = fs.readFileSync(a);
    if (buf.includes(0)) return { error: '二进制文件无法以文本显示' };
    return { content: buf.toString('utf8'), size: s.size };
  }

  function write(rel, content) {
    const a = abs(rel);
    if (!a) return { error: '路径非法' };
    fs.mkdirSync(path.dirname(a), { recursive: true });
    fs.writeFileSync(a, content);
    return { ok: true, size: Buffer.byteLength(content) };
  }

  return { root, list, exists, isDir, stat, mkdir, remove, rename, readText, write, abs };
}

export { sanitizeName };
