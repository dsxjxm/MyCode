import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { ensureDirs, PUBLIC_DIR } from './paths.js';
import { dbReady } from './db.js';
import { loadUser } from './auth.js';
import authRoutes from './routes/auth.js';
import classRoutes from './routes/classes.js';
import studentRoutes from './routes/students.js';
import spaceRoutes from './routes/space.js';
import previewRoutes from './routes/preview.js';
import noticeRoutes from './routes/notices.js';
import terminalRoutes from './routes/terminal.js';
import networkRoutes from './routes/network.js';
import mailRoutes from './routes/mail.js';
import { startMailScheduler } from './services/mailSim.js';

ensureDirs();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(loadUser);

app.use('/assets', express.static(path.join(PUBLIC_DIR, 'assets')));
app.use('/vendor', express.static(path.join(PUBLIC_DIR, 'vendor')));

app.use('/api/auth', authRoutes);
app.use('/api/classes', classRoutes);
app.use('/api/students', studentRoutes);
app.use('/api/space', spaceRoutes);
app.use('/api/notices', noticeRoutes);
app.use('/api/terminal', terminalRoutes);
app.use('/api/network', networkRoutes);
app.use('/api/mail', mailRoutes);
app.use('/preview', previewRoutes);

function redirectByRole(res, role) {
  res.redirect(role === 'teacher' ? '/admin.html' : '/workspace.html');
}

app.get('/', (req, res) => {
  if (!req.user) return res.redirect('/login.html');
  redirectByRole(res, req.user.role);
});

app.get('/login.html', (req, res) => {
  if (req.user) return redirectByRole(res, req.user.role);
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

app.get('/admin.html', (req, res) => {
  if (!req.user) return res.redirect('/login.html');
  if (req.user.role !== 'teacher') return res.redirect('/workspace.html');
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

app.get('/workspace.html', (req, res) => {
  if (!req.user) return res.redirect('/login.html');
  if (req.user.role !== 'student') return res.redirect('/admin.html');
  res.sendFile(path.join(PUBLIC_DIR, 'workspace.html'));
});

app.get('/terminal.html', (req, res) => {
  if (!req.user) return res.redirect('/login.html');
  if (req.user.role !== 'student') return res.redirect('/admin.html');
  res.sendFile(path.join(PUBLIC_DIR, 'terminal.html'));
});

app.get('/network.html', (req, res) => {
  if (!req.user) return res.redirect('/login.html');
  res.sendFile(path.join(PUBLIC_DIR, 'network.html'));
});

app.get('/mail.html', (req, res) => {
  if (!req.user) return res.redirect('/login.html');
  res.sendFile(path.join(PUBLIC_DIR, 'mail.html'));
});

app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));

app.use((err, req, res, _next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: '文件超出大小限制' });
  }
  console.error('[server error]', err);
  const status = err.status || 500;
  if (req.path.startsWith('/api')) {
    return res.status(status).json({ error: err.message || '服务器内部错误' });
  }
  res.status(status).send('服务器内部错误');
});

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// 等待数据库初始化完成后再监听端口
dbReady.then(() => {
  const server = http.createServer(app);
  server.listen(PORT, HOST, () => {
    startMailScheduler();
    const interfaces = os.networkInterfaces();
    const addresses = Object.values(interfaces)
      .flat()
      .filter((item) => item && item.family === 'IPv4' && !item.internal)
      .map((item) => item.address);
    console.log('');
    console.log('  局域网仿真实训教学平台 已启动');
    console.log(`  本机访问：http://localhost:${PORT}`);
    for (const address of addresses) {
      console.log(`  局域网访问：http://${address}:${PORT}`);
    }
    console.log('  教师初始账号：admin / admin123');
    console.log('');
  });
});
