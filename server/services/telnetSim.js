// Telnet 模拟：模拟远程登录到一台服务器，执行基础 shell 命令
// 复用学生的 ftp 目录作为远程文件系统
import { joinRel, normalizeRel } from './vfs.js';

export function initTelnetState() {
  return { connected: false, loggedIn: false, step: '', user: null, host: null, cwd: '' };
}

function parse(command) {
  const t = String(command || '').trim();
  if (!t) return { cmd: '', args: [], raw: '' };
  const idx = t.indexOf(' ');
  if (idx < 0) return { cmd: t.toLowerCase(), args: [], raw: t };
  return { cmd: t.slice(0, idx).toLowerCase(), args: [t.slice(idx + 1)], raw: t };
}

export function execTelnet(state, command, deps, upload) {
  const out = [];
  let s = { ...state };
  const { cmd, raw } = parse(command);

  if (cmd === 'help') {
    out.push('可用命令：');
    out.push('  open <host>     远程登录到服务器');
    out.push('  close / exit    断开连接');
    out.push('  ls              列出当前目录');
    out.push('  cd <目录>       切换目录');
    out.push('  pwd             显示当前目录');
    out.push('  whoami          显示当前用户');
    out.push('  date            显示当前时间');
    out.push('  echo <文本>     回显文本');
    out.push('  get <文件>      下载文件（生成下载链接）');
    out.push('  put <文件>      上传文件（点击左侧上传按钮选择）');
    out.push('  clear           清屏');
    out.push('  help            显示本帮助');
    return { output: out.join('\n'), state: s };
  }

  if (cmd === 'clear' || cmd === 'cls') return { output: '__CLEAR__', state: s };

  if (cmd === 'open') {
    const host = raw.slice(5).trim() || deps.hostName || 'student-server';
    s.connected = true;
    s.loggedIn = false;
    s.step = 'awaitingUser';
    s.host = host;
    out.push(`Trying ${host}...`);
    out.push(`Connected to ${host}.`);
    out.push(`Escape character is '^]'.`);
    out.push(`Ubuntu 22.04 LTS`);
    out.push(`login: `);
    return { output: out.join('\n'), state: s };
  }

  if (cmd === 'close' || cmd === 'exit' || cmd === 'logout') {
    if (!s.connected) {
      out.push('telnet: not connected');
      return { output: out.join('\n'), state: s };
    }
    s.connected = false;
    s.loggedIn = false;
    s.step = '';
    s.user = null;
    s.cwd = '';
    out.push('Connection closed.');
    return { output: out.join('\n'), state: s };
  }

  if (!s.connected) {
    out.push('telnet: not connected. 请先执行 open <host>');
    return { output: out.join('\n'), state: s };
  }

  // 登录交互流程
  if (s.step === 'awaitingUser') {
    s.user = raw;
    s.step = 'awaitingPass';
    out.push(`Password: `);
    return { output: out.join('\n'), state: s };
  }
  if (s.step === 'awaitingPass') {
    const ok = deps.auth(s.user, raw);
    if (ok) {
      s.loggedIn = true;
      s.step = '';
      s.cwd = '';
      const now = new Date().toLocaleString('zh-CN', { hour12: false });
      out.push(`Last login: ${now} on tty1`);
      out.push(`Welcome to Student-Server`);
      out.push(`$ `);
    } else {
      s.step = 'awaitingUser';
      s.user = null;
      out.push(`Login incorrect`);
      out.push(`login: `);
    }
    return { output: out.join('\n'), state: s };
  }

  if (!s.loggedIn) {
    out.push('Login first.');
    return { output: out.join('\n'), state: s };
  }

  // 已登录 shell 命令
  if (cmd === 'whoami') {
    out.push(s.user);
    out.push('$ ');
    return { output: out.join('\n'), state: s };
  }
  if (cmd === 'date') {
    out.push(new Date().toString());
    out.push('$ ');
    return { output: out.join('\n'), state: s };
  }
  if (cmd === 'echo') {
    out.push(raw.slice(5));
    out.push('$ ');
    return { output: out.join('\n'), state: s };
  }
  if (cmd === 'pwd') {
    out.push('/home/' + s.user + (s.cwd ? '/' + normalizeRel(s.cwd) : ''));
    out.push('$ ');
    return { output: out.join('\n'), state: s };
  }
  if (cmd === 'ls' || cmd === 'dir') {
    const r = deps.vfs.list(s.cwd);
    if (r.error) {
      out.push(`ls: cannot access '${s.cwd || '/'}': ${r.error}`);
    } else {
      const names = r.entries.map((e) => (e.type === 'dir' ? e.name + '/' : e.name));
      out.push(names.join('  ') || '(empty)');
    }
    out.push('$ ');
    return { output: out.join('\n'), state: s };
  }
  if (cmd === 'cd') {
    const target = joinRel(s.cwd, raw.slice(3).trim());
    if (deps.vfs.isDir(target)) {
      s.cwd = target;
    } else {
      out.push(`-bash: cd: ${raw.slice(3).trim()}: No such file or directory`);
    }
    out.push('$ ');
    return { output: out.join('\n'), state: s };
  }

  if (cmd === 'get') {
    const arg = raw.slice(4).trim();
    if (!arg) {
      out.push('usage: get <file>');
      out.push('$ ');
      return { output: out.join('\n'), state: s };
    }
    const target = joinRel(s.cwd, arg);
    const r = deps.vfs.readText(target);
    if (r.error) {
      out.push(`get: cannot read '${arg}': ${r.error}`);
    } else {
      const lines = r.content.split('\n');
      const preview = lines.slice(0, 20).map((l) => `  ${l}`);
      if (lines.length > 20) preview.push(`  ... (共 ${lines.length} 行，已省略)`);
      out.push(`get: receiving '${arg}' (${r.size} bytes)`);
      out.push(`---- 文件内容预览 ----`);
      out.push(...preview);
      out.push(`----------------------`);
      out.push('$ ');
      return { output: out.join('\n'), state: s, file: { name: arg, content: r.content, size: r.size } };
    }
    out.push('$ ');
    return { output: out.join('\n'), state: s };
  }
  if (cmd === 'put') {
    const arg = raw.slice(4).trim();
    if (!arg) {
      out.push('usage: put <file>');
      out.push('$ ');
      return { output: out.join('\n'), state: s };
    }
    if (!upload || !upload.content) {
      out.push(`put: no file content provided for '${arg}'. 请点击左侧「上传文件」选择文件`);
      out.push(`__NEED_UPLOAD__`);
      out.push('$ ');
      return { output: out.join('\n'), state: s };
    }
    const target = joinRel(s.cwd, upload.name || arg);
    const r = deps.vfs.write(target, upload.content);
    if (r.error) {
      out.push(`put: failed to upload '${arg}': ${r.error}`);
    } else {
      out.push(`put: sending '${upload.name || arg}' (${r.size} bytes)`);
      out.push(`put: transfer complete`);
    }
    out.push('$ ');
    return { output: out.join('\n'), state: s };
  }

  out.push(`-bash: ${cmd}: command not found`);
  out.push('$ ');
  return { output: out.join('\n'), state: s };
}
