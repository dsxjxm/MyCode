import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { DATA_DIR } from './paths.js';

const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'sid';

const secretFile = path.join(DATA_DIR, '.secret');
let SECRET;
if (fs.existsSync(secretFile)) {
  SECRET = fs.readFileSync(secretFile, 'utf8').trim();
} else {
  SECRET = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretFile, SECRET, { mode: 0o600 });
}

export function createSession(role, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL;
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token, role, user_id, expires_at) VALUES (?, ?, ?, ?)').run(
    token,
    role,
    userId,
    expiresAt
  );
  return token;
}

export function deleteSession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

export function setSessionCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_TTL / 1000)}; SameSite=Lax`
  );
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

export function loadUser(req, _res, next) {
  req.cookies = parseCookies(req.headers.cookie || '');
  const token = req.cookies[COOKIE_NAME];
  req.user = null;
  req.sessionToken = token || null;
  if (token) {
    const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
    if (session && session.expires_at > Date.now()) {
      if (session.role === 'teacher') {
        const row = db.prepare('SELECT id, username, name FROM teachers WHERE id = ?').get(session.user_id);
        if (row) req.user = { role: 'teacher', ...row };
      } else if (session.role === 'student') {
        const row = db
          .prepare(
            `SELECT s.id, s.username, s.name, s.student_no, s.status, s.class_id, c.name AS class_name
             FROM students s JOIN classes c ON c.id = s.class_id WHERE s.id = ?`
          )
          .get(session.user_id);
        if (row && row.status === 'active') req.user = { role: 'student', ...row };
      }
    }
  }
  next();
}

export function requireTeacher(req, res, next) {
  if (req.user && req.user.role === 'teacher') return next();
  res.status(401).json({ error: '请先以教师身份登录' });
}

export function requireStudent(req, res, next) {
  if (req.user && req.user.role === 'student') return next();
  res.status(401).json({ error: '请先以学生身份登录' });
}

function sign(data) {
  return crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
}

export function buildPreviewToken(studentId, ttl = 12 * 60 * 60 * 1000) {
  const payload = Buffer.from(
    JSON.stringify({ sid: studentId, exp: Date.now() + ttl })
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifyPreviewToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

export { COOKIE_NAME };
