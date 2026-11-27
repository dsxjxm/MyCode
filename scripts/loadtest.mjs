// 局域网教学平台并发压测脚本（零依赖，Node 18+）
//
// 默认目标：http://127.0.0.1:3000，账号 20250101-20250103 / 123456
// 常用示例：
//   node scripts/loadtest.mjs
//   node scripts/loadtest.mjs --base http://192.168.1.10:3000 --accounts 20250101,20250102,20250103 --stages 20:30,40:30,60:30 --think 1000-2500 --write 30
//   node scripts/loadtest.mjs --stages 10:15,30:20,60:20,100:15 --think 0-15 --write 40   # 暴力压测
//
// 参数：
//   --base      目标地址          （默认 http://127.0.0.1:3000）
//   --accounts  学生账号,逗号分隔 （默认 20250101,20250102,20250103）
//   --password  学生密码          （默认 123456）
//   --domain    邮箱域名          （默认 example.local）
//   --stages    并发:时长秒,逗号分隔（默认 10:15,30:20,60:20,100:15）
//   --think     每次操作后的思考时间毫秒，如 1000-2500（默认 0-15）
//   --write     写操作占比百分比  （默认 40）
//   --pid       服务端 Node 进程 PID，仅 Linux 可读取内存占用
//   --db        数据库文件路径，仅用于统计文件大小
import fs from 'node:fs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const BASE = arg('base', process.env.BASE || 'http://127.0.0.1:3000');
const SERVER_PID = arg('pid', process.env.SERVER_PID || '');
const DB_FILE = arg('db', process.env.DB_FILE || '');
const DOMAIN = arg('domain', process.env.DOMAIN || 'example.local');
const PASSWORD = arg('password', process.env.PASSWORD || '123456');
const USERNAMES = arg('accounts', process.env.ACCOUNTS || '20250101,20250102,20250103')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const THINK = arg('think', process.env.THINK || '0-15').split('-').map(Number);
const THINK_MIN = THINK[0] || 0;
const THINK_MAX = THINK.length > 1 ? THINK[1] : THINK_MIN;
const WRITE_PCT = Number(arg('write', process.env.WRITE_PCT || 40));
const STAGES = arg('stages', process.env.STAGES || '10:15,30:20,60:20,100:15')
  .split(',')
  .map((s) => {
    const [vus, dur] = s.split(':').map(Number);
    return { vus, dur };
  });

const ACCOUNTS = USERNAMES.map((username) => ({ username, password: PASSWORD }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const percentile = (arr, p) => {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const rss = () => {
  if (!SERVER_PID) return null;
  try {
    const status = fs.readFileSync(`/proc/${SERVER_PID}/status`, 'utf8');
    const m = status.match(/VmRSS:\s+(\d+)\s+kB/);
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
};
const dbSize = () => {
  if (!DB_FILE) return null;
  try {
    return Math.round(fs.statSync(DB_FILE).size / 1024);
  } catch {
    return null;
  }
};

async function request(path, { method = 'GET', body, cookie, mailToken } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  if (mailToken) headers['x-mail-token'] = mailToken;
  const t0 = performance.now();
  try {
    const res = await fetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    });
    const text = await res.text();
    return {
      status: res.status,
      ok: res.ok,
      text,
      setCookie: res.headers.getSetCookie ? res.headers.getSetCookie() : [],
      ms: performance.now() - t0
    };
  } catch (err) {
    return { status: 0, ok: false, error: err.name + ': ' + err.message, ms: performance.now() - t0 };
  }
}

function parseSid(setCookie) {
  for (const line of setCookie) {
    const m = line.match(/(?:^|;\s*)sid=([^;]+)/);
    if (m) return `sid=${m[1]}`;
  }
  return '';
}

function newStats() {
  return { actions: {}, total: 0, errors: 0 };
}
function record(stats, action, res) {
  stats.total += 1;
  if (!res.ok) stats.errors += 1;
  const a = (stats.actions[action] ||= { n: 0, err: 0, lat: [] });
  a.n += 1;
  if (!res.ok) a.err += 1;
  a.lat.push(res.ms);
}

async function worker(id, deadline, stats) {
  const acct = ACCOUNTS[id % ACCOUNTS.length];
  const login = await request('/api/auth/login', {
    method: 'POST',
    body: { username: acct.username, password: acct.password }
  });
  record(stats, 'login', login);
  if (!login.ok) return;
  const cookie = parseSid(login.setCookie);

  let mailToken = '';
  const mailLogin = await request('/api/mail/login', {
    method: 'POST',
    cookie,
    body: { address: `${acct.username}@${DOMAIN}`, password: acct.password }
  });
  record(stats, 'mail-login', mailLogin);
  if (mailLogin.ok) {
    try {
      mailToken = JSON.parse(mailLogin.text || '')?.token || '';
    } catch {
      /* ignore */
    }
  }

  const fileName = `stress-vu${id}.html`;
  let seq = 0;
  while (Date.now() < deadline) {
    const r = Math.random();
    if (r >= WRITE_PCT / 100) {
      const q = Math.random();
      if (q < 0.34) record(stats, 'space-list', await request('/api/space/files', { cookie }));
      else if (q < 0.67) record(stats, 'space-read', await request('/api/space/file?path=index.html', { cookie }));
      else record(stats, 'mail-read', await request('/api/mail/mails?folder=inbox&limit=20', { cookie, mailToken }));
    } else if (Math.random() < 0.55 && mailToken) {
      const to = id % 2 === 0 ? `teacher@${DOMAIN}` : `${ACCOUNTS[(id + 1) % ACCOUNTS.length].username}@${DOMAIN}`;
      record(
        stats,
        'mail-send',
        await request('/api/mail/send', {
          method: 'POST',
          cookie,
          mailToken,
          body: { to: [to], subject: `压测 ${id}-${seq++}`, body: '并发测试邮件正文' }
        })
      );
    } else {
      record(
        stats,
        'space-write',
        await request('/api/space/file', {
          method: 'PUT',
          cookie,
          body: { path: fileName, content: `<h1>vu ${id} #${seq++}</h1>` }
        })
      );
    }
    await sleep(THINK_MIN + Math.random() * Math.max(0, THINK_MAX - THINK_MIN));
  }
}

function summarize(stage, stats, durationMs) {
  const lines = [];
  const totalRps = (stats.total / (durationMs / 1000)).toFixed(1);
  const allLat = Object.values(stats.actions).flatMap((a) => a.lat);
  lines.push(
    `\n== ${stage.vus} 并发 / ${stage.dur}s == 请求 ${stats.total}，吞吐 ${totalRps} req/s，错误 ${stats.errors}\n` +
      `   总体延迟 p50 ${percentile(allLat, 50).toFixed(0)}ms / p95 ${percentile(allLat, 95).toFixed(0)}ms / p99 ${percentile(allLat, 99).toFixed(0)}ms`
  );
  for (const [name, a] of Object.entries(stats.actions)) {
    lines.push(
      `   ${name.padEnd(11)} n=${String(a.n).padEnd(6)} 错误=${String(a.err).padEnd(4)} 平均=${(
        a.lat.reduce((s, x) => s + x, 0) / a.n
      ).toFixed(0)}ms p95=${percentile(a.lat, 95).toFixed(0)}ms`
    );
  }
  return lines.join('\n');
}

console.log(`目标：${BASE}`);
const health = await request('/health');
console.log('健康检查：', health.status, health.ok ? 'OK' : health.error || '');

for (const stage of STAGES) {
  const before = { rss: rss(), db: dbSize() };
  const stats = newStats();
  const start = Date.now();
  const deadline = start + stage.dur * 1000;
  const workers = Array.from({ length: stage.vus }, (_, i) => worker(i, deadline, stats));
  await Promise.all(workers);
  const elapsed = Date.now() - start;
  const after = { rss: rss(), db: dbSize() };
  console.log(summarize(stage, stats, elapsed));
  if (before.rss !== null || before.db !== null) {
    console.log(
      `   服务进程 RSS ${before.rss ?? '-'}MB -> ${after.rss ?? '-'}MB；数据库文件 ${before.db ?? '-'}KB -> ${after.db ?? '-'}KB`
    );
  }
}
console.log('\n压测结束');
