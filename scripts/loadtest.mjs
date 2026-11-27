// 局域网教学平台并发压测脚本（零依赖，兼容 Node 12+，含 Win7/Win8 离线包内置运行时）
//
// 默认目标：http://127.0.0.1:3000，账号 20250101-20250103 / 123456
// 常用示例：
//   node scripts/loadtest.mjs
//   node scripts/loadtest.mjs --base http://192.168.1.10:3000 --accounts 20250101,20250102,20250103 --stages 20:30,40:30,60:30 --think 1000-2500 --write 30
//   node scripts/loadtest.mjs --stages 10:15,30:20,60:20,100:15 --think 0-15 --write 40   // 暴力压测
//
// 参数：
//   --base      目标地址          （默认 http://127.0.0.1:3000）
//   --accounts  学生账号,逗号分隔 （默认 20250101,20250102,20250103）
//   --password  学生密码          （默认 123456）
//   --domain    邮箱域名          （默认 example.local）
//   --stages    并发:时长秒,逗号分隔（默认 10:15,30:20,60:20,100:15）
//   --think     每次操作后的思考时间毫秒，如 1000-2500（默认 0-15）
//   --write     写操作占比百分比  （默认 40）
//   --pid       服务端 Node 进程 PID（仅 Linux 可读取内存占用）
//   --db        数据库文件路径（仅用于统计文件大小）
import http from 'http';
import fs from 'fs';

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const BASE = arg('base', process.env.BASE || 'http://127.0.0.1:3000');
const SERVER_PID = arg('pid', process.env.SERVER_PID || '');
const DB_FILE = arg('db', process.env.DB_FILE || '');
const DOMAIN = arg('domain', process.env.DOMAIN || 'example.local');
const PASSWORD = arg('password', process.env.PASSWORD || '123456');
const USERNAMES = arg('accounts', process.env.ACCOUNTS || '20250101,20250102,20250103')
  .split(',')
  .map(function (s) { return s.trim(); })
  .filter(Boolean);
const THINK = arg('think', process.env.THINK || '0-15').split('-').map(Number);
const THINK_MIN = THINK[0] || 0;
const THINK_MAX = THINK.length > 1 ? THINK[1] : THINK_MIN;
const WRITE_PCT = Number(arg('write', process.env.WRITE_PCT || 40));
const STAGES = arg('stages', process.env.STAGES || '10:15,30:20,60:20,100:15')
  .split(',')
  .map(function (s) {
    const parts = s.split(':').map(Number);
    return { vus: parts[0], dur: parts[1] };
  });

const ACCOUNTS = USERNAMES.map(function (username) {
  return { username: username, password: PASSWORD };
});

const agent = new http.Agent({ keepAlive: true, maxSockets: 300 });
const base = new URL(BASE);

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}
function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = arr.slice().sort(function (a, b) { return a - b; });
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}
function rssMB() {
  if (!SERVER_PID) return null;
  try {
    const status = fs.readFileSync('/proc/' + SERVER_PID + '/status', 'utf8');
    const m = status.match(/VmRSS:\s+(\d+)\s+kB/);
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch (err) {
    return null;
  }
}
function dbKB() {
  if (!DB_FILE) return null;
  try {
    return Math.round(fs.statSync(DB_FILE).size / 1024);
  } catch (err) {
    return null;
  }
}

function requestOnce(path, opts, fresh) {
  opts = opts || {};
  const method = opts.method || 'GET';
  const payload = opts.body === undefined ? null : Buffer.from(JSON.stringify(opts.body));
  const headers = {};
  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = payload.length;
  }
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.mailToken) headers['x-mail-token'] = opts.mailToken;
  if (fresh) headers.Connection = 'close';

  return new Promise(function (resolve) {
    const t0 = Date.now();
    const url = new URL(BASE + path);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: method,
        headers: headers,
        agent: fresh ? false : agent
      },
      function (res) {
        const chunks = [];
        res.on('data', function (c) { chunks.push(c); });
        res.on('end', function () {
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 400,
            text: Buffer.concat(chunks).toString('utf8'),
            setCookie: res.headers['set-cookie'] || [],
            ms: Date.now() - t0
          });
        });
      }
    );
    req.on('error', function (err) {
      resolve({ status: 0, ok: false, error: err.code || err.message, ms: Date.now() - t0 });
    });
    req.setTimeout(10000, function () {
      req.destroy(new Error('timeout'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

let retries = 0;
// 长连接偶发被服务端关闭会出现 ECONNRESET；对幂等的 GET 与登录换新连接重试，
// 写操作（保存/发邮件）不重试，避免重复提交影响结果。
function request(path, opts, attempt) {
  attempt = attempt || 1;
  return requestOnce(path, opts, attempt > 1).then(function (res) {
    const method = (opts && opts.method) || 'GET';
    const safeToRetry = method === 'GET' || /\/api\/(auth|mail)\/login$/.test(path);
    if (res.status === 0 && safeToRetry && attempt < 3) {
      retries += 1;
      return new Promise(function (r) { setTimeout(r, 80 * attempt); }).then(function () {
        return request(path, opts, attempt + 1);
      });
    }
    return res;
  });
}

function parseSid(setCookie) {
  for (let i = 0; i < setCookie.length; i++) {
    const m = String(setCookie[i]).match(/(?:^|;\s*)sid=([^;]+)/);
    if (m) return 'sid=' + m[1];
  }
  return '';
}

function newStats() {
  return { actions: {}, total: 0, errors: 0, firstError: '' };
}
function record(stats, action, res) {
  stats.total += 1;
  if (!res.ok) {
    stats.errors += 1;
    if (!stats.firstError) {
      stats.firstError = action + ' -> ' + (res.error || res.status + ' ' + String(res.text || '').slice(0, 120));
    }
  }
  if (!stats.actions[action]) stats.actions[action] = { n: 0, err: 0, lat: [] };
  const a = stats.actions[action];
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
    cookie: cookie,
    body: { address: acct.username + '@' + DOMAIN, password: acct.password }
  });
  record(stats, 'mail-login', mailLogin);
  if (mailLogin.ok) {
    try {
      const parsed = JSON.parse(mailLogin.text || '{}');
      mailToken = parsed && parsed.token ? parsed.token : '';
    } catch (err) {
      /* ignore */
    }
  }

  const fileName = 'stress-vu' + id + '.html';
  let seq = 0;
  while (Date.now() < deadline) {
    const r = Math.random();
    if (r >= WRITE_PCT / 100) {
      const q = Math.random();
      if (q < 0.34) record(stats, 'space-list', await request('/api/space/files', { cookie: cookie }));
      else if (q < 0.67) record(stats, 'space-read', await request('/api/space/file?path=index.html', { cookie: cookie }));
      else record(stats, 'mail-read', await request('/api/mail/mails?folder=inbox&limit=20', { cookie: cookie, mailToken: mailToken }));
    } else if (Math.random() < 0.55 && mailToken) {
      const to = id % 2 === 0
        ? 'teacher@' + DOMAIN
        : ACCOUNTS[(id + 1) % ACCOUNTS.length].username + '@' + DOMAIN;
      record(
        stats,
        'mail-send',
        await request('/api/mail/send', {
          method: 'POST',
          cookie: cookie,
          mailToken: mailToken,
          body: { to: [to], subject: '压测 ' + id + '-' + seq++, body: '并发测试邮件正文' }
        })
      );
    } else {
      record(
        stats,
        'space-write',
        await request('/api/space/file', {
          method: 'PUT',
          cookie: cookie,
          body: { path: fileName, content: '<h1>vu ' + id + ' #' + seq++ + '</h1>' }
        })
      );
    }
    await sleep(THINK_MIN + Math.random() * Math.max(0, THINK_MAX - THINK_MIN));
  }
}

function summarize(stage, stats, durationMs) {
  const lines = [];
  const totalRps = (stats.total / (durationMs / 1000)).toFixed(1);
  const allLat = [];
  Object.keys(stats.actions).forEach(function (k) {
    allLat.push.apply(allLat, stats.actions[k].lat);
  });
  lines.push(
    '\n== ' + stage.vus + ' 并发 / ' + stage.dur + 's == 请求 ' + stats.total +
    '，吞吐 ' + totalRps + ' req/s，错误 ' + stats.errors + '\n' +
    '   总体延迟 p50 ' + percentile(allLat, 50).toFixed(0) + 'ms / p95 ' +
    percentile(allLat, 95).toFixed(0) + 'ms / p99 ' + percentile(allLat, 99).toFixed(0) + 'ms'
  );
  Object.keys(stats.actions).forEach(function (name) {
    const a = stats.actions[name];
    let sum = 0;
    for (let i = 0; i < a.lat.length; i++) sum += a.lat[i];
    lines.push(
      '   ' + name.padEnd(11) + ' n=' + String(a.n).padEnd(6) + ' 错误=' + String(a.err).padEnd(4) +
      ' 平均=' + (sum / a.n).toFixed(0) + 'ms p95=' + percentile(a.lat, 95).toFixed(0) + 'ms'
    );
  });
  if (stats.firstError) lines.push('   首个错误：' + stats.firstError);
  return lines.join('\n');
}

async function main() {
  console.log('目标：' + BASE + '，账号数 ' + ACCOUNTS.length + '，写占比 ' + WRITE_PCT + '%，思考时间 ' + THINK_MIN + '-' + THINK_MAX + 'ms');
  const health = await request('/health');
  console.log('健康检查：' + health.status + ' ' + (health.ok ? 'OK' : health.error || ''));

  for (let i = 0; i < STAGES.length; i++) {
    const stage = STAGES[i];
    const before = { rss: rssMB(), db: dbKB() };
    const stats = newStats();
    const start = Date.now();
    const deadline = start + stage.dur * 1000;
    const workers = [];
    for (let v = 0; v < stage.vus; v++) workers.push(worker(v, deadline, stats));
    await Promise.all(workers);
    const elapsed = Date.now() - start;
    const after = { rss: rssMB(), db: dbKB() };
    console.log(summarize(stage, stats, elapsed));
    if (before.rss !== null || before.db !== null) {
      console.log(
        '   服务进程 RSS ' + (before.rss === null ? '-' : before.rss) + 'MB -> ' +
        (after.rss === null ? '-' : after.rss) + 'MB；数据库文件 ' +
        (before.db === null ? '-' : before.db) + 'KB -> ' + (after.db === null ? '-' : after.db) + 'KB'
      );
    }
    await sleep(1000);
  }
  console.log('\n压测结束，网络层重试 ' + retries + ' 次（ECONNRESET 等，已自动换新连接）');
}

main().catch(function (err) {
  console.error('压测失败：', err);
  process.exit(1);
});
