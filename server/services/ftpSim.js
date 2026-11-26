// FTP 命令模拟器：纯函数状态机，返回标准 FTP 状态码文本
// state: { connected, loggedIn, cwd, user, host, pendingUser }
import { joinRel, normalizeRel } from './vfs.js';

export function initFtpState() {
  return { connected: false, loggedIn: false, cwd: '', user: null, host: null, pendingUser: null };
}

function parse(command) {
  const t = String(command || '').trim();
  if (!t) return { cmd: '', args: [] };
  const parts = t.split(/\s+/);
  return { cmd: parts[0].toLowerCase(), args: parts.slice(1) };
}

function displayPath(rel) {
  const n = normalizeRel(rel);
  return '/' + n;
}

function fmtSize(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

function lsListing(vfs, rel) {
  const r = vfs.list(rel);
  if (r.error) return null;
  const lines = r.entries.map((e) => {
    const type = e.type === 'dir' ? 'd' : '-';
    const perm = e.type === 'dir' ? 'rwxr-xr-x' : 'rw-r--r--';
    const size = String(e.size).padStart(8);
    const d = new Date(e.mtime);
    const date = d.toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
    return `${type}${perm} 1 student group ${size} ${date} ${e.name}${e.type === 'dir' ? '/' : ''}`;
  });
  return lines;
}

// deps: { vfs, auth(username,password)=>bool, studentName, hostName }
// upload: { name, content } 用于 put 命令
export function execFtp(state, command, deps, upload) {
  const out = [];
  let s = { ...state };
  const { cmd, args } = parse(command);
  if (!cmd) return { output: '', state: s };

  // 清屏由前端处理，后端忽略
  if (cmd === 'cls' || cmd === 'clear') return { output: '__CLEAR__', state: s };

  if (cmd === 'help' || cmd === '?') {
    out.push('可用命令：');
    out.push('  open [host]        连接 FTP 服务器');
    out.push('  user <账号>        输入用户名');
    out.push('  pass <密码>        输入密码');
    out.push('  ls / dir           列出当前目录');
    out.push('  cd <目录>          切换目录');
    out.push('  pwd                显示当前目录');
    out.push('  mkdir <目录>       创建目录');
    out.push('  rmdir <目录>       删除空目录');
    out.push('  delete <文件>      删除文件');
    out.push('  rename <旧> <新>   重命名');
    out.push('  get <文件>         下载文件');
    out.push('  put <文件>         上传文件');
    out.push('  status             查看连接状态');
    out.push('  bye / quit         断开连接');
    out.push('  help               显示本帮助');
    return { output: out.join('\n'), state: s };
  }

  if (cmd === 'bye' || cmd === 'quit' || cmd === 'exit') {
    s.connected = false;
    s.loggedIn = false;
    s.user = null;
    s.cwd = '';
    out.push('221 Goodbye');
    return { output: out.join('\n'), state: s };
  }

  if (cmd === 'open') {
    s.connected = true;
    s.loggedIn = false;
    s.host = args[0] || deps.hostName || 'student-ftp';
    out.push(`220 ${s.host} FTP server (Version 1.0) ready`);
    return { output: out.join('\n'), state: s };
  }

  if (!s.connected) {
    out.push('530 Not connected. 请先执行 open 连接服务器');
    return { output: out.join('\n'), state: s };
  }

  if (cmd === 'status') {
    out.push(`211-FTP server status:`);
    out.push(`    Connected to: ${s.host || '(none)'}`);
    out.push(`    Logged in: ${s.loggedIn ? 'yes (' + s.user + ')' : 'no'}`);
    out.push(`    Current directory: ${displayPath(s.cwd)}`);
    out.push(`211 End of status`);
    return { output: out.join('\n'), state: s };
  }

  if (cmd === 'user') {
    if (!args[0]) {
      out.push('501 Syntax error in parameters');
      return { output: out.join('\n'), state: s };
    }
    s.pendingUser = args[0];
    out.push('331 Username okay, need password');
    return { output: out.join('\n'), state: s };
  }

  if (cmd === 'pass') {
    if (!s.pendingUser) {
      out.push('503 Login with USER first');
      return { output: out.join('\n'), state: s };
    }
    const pwd = args.join(' ');
    const ok = deps.auth(s.pendingUser, pwd);
    if (ok) {
      s.loggedIn = true;
      s.user = s.pendingUser;
      s.cwd = '';
      s.pendingUser = null;
      out.push(`230 User ${s.user} logged in, proceed`);
    } else {
      s.pendingUser = null;
      out.push('530 Login incorrect');
    }
    return { output: out.join('\n'), state: s };
  }

  if (!s.loggedIn) {
    out.push('530 Please login with USER and PASS');
    return { output: out.join('\n'), state: s };
  }

  // 以下命令需要已登录
  if (cmd === 'ls' || cmd === 'dir') {
    const lines = lsListing(deps.vfs, s.cwd);
    if (!lines) {
      out.push('550 Failed to list directory');
    } else if (lines.length === 0) {
      out.push('226 Directory send OK (empty)');
    } else {
      out.push(...lines);
      out.push('226 Directory send OK');
    }
    return { output: out.join('\n'), state: s };
  }

  if (cmd === 'pwd') {
    out.push(`257 "${displayPath(s.cwd)}" is current directory`);
    return { output: out.join('\n'), state: s };
  }

  if (cmd === 'cd' || cmd === 'cwd') {
    if (!args[0]) {
      out.push('501 Syntax error in parameters');
      return { output: out.join('\n'), state: s };
    }
    const target = joinRel(s.cwd, args[0]);
    if (deps.vfs.isDir(target)) {
      s.cwd = target;
      out.push('250 Directory successfully changed');
    } else {
      out.push(`550 ${args[0]}: No such directory`);
    }
    return { output: out.join('\n'), state: s };
  }

  if (cmd === 'mkdir') {
    if (!args[0]) {
      out.push('501 Syntax error in parameters');
      return { output: out.join('\n'), state: s };
    }
    const target = joinRel(s.cwd, args[0]);
    const r = deps.vfs.mkdir(target);
    out.push(r.error ? `550 Create directory operation failed: ${r.error}` : `257 "${displayPath(target)}" created`);
    return { output: out.join('\n'), state: s };
  }

  if (cmd === 'rmdir') {
    if (!args[0]) {
      out.push('501 Syntax error in parameters');
      return { output: out.join('\n'), state: s };
    }
    const target = joinRel(s.cwd, args[0]);
    const r = deps.vfs.remove(target);
    out.push(r.error ? `550 Remove directory operation failed: ${r.error}` : '250 Remove directory operation successful');
    return { output: out.join('\n'), state: s };
  }

  if (cmd === 'delete' || cmd === 'rm') {
    if (!args[0]) {
      out.push('501 Syntax error in parameters');
      return { output: out.join('\n'), state: s };
    }
    const target = joinRel(s.cwd, args[0]);
    const r = deps.vfs.remove(target);
    out.push(r.error ? `550 Delete operation failed: ${r.error}` : '250 Delete operation successful');
    return { output: out.join('\n'), state: s };
  }

  if (cmd === 'rename') {
    if (args.length < 2) {
      out.push('501 Syntax error in parameters');
      return { output: out.join('\n'), state: s };
    }
    const from = joinRel(s.cwd, args[0]);
    const to = joinRel(s.cwd, args[1]);
    const r = deps.vfs.rename(from, to);
    out.push(r.error ? `550 Rename failed: ${r.error}` : '250 Rename successful');
    return { output: out.join('\n'), state: s };
  }

  if (cmd === 'get') {
    if (!args[0]) {
      out.push('501 Syntax error in parameters');
      return { output: out.join('\n'), state: s };
    }
    const target = joinRel(s.cwd, args[0]);
    const r = deps.vfs.readText(target);
    if (r.error) {
      out.push(`550 Failed to open file: ${r.error}`);
      return { output: out.join('\n'), state: s };
    }
    const lines = r.content.split('\n');
    const preview = lines.slice(0, 20).map((l) => `  ${l}`);
    if (lines.length > 20) preview.push(`  ... (共 ${lines.length} 行，已省略)`);
    out.push(`local: ${args[0]} remote: ${displayPath(target)}`);
    out.push(`226 Transfer complete. ${r.size} bytes received`);
    out.push(`---- 文件内容预览 ----`);
    out.push(...preview);
    out.push(`----------------------`);
    return { output: out.join('\n'), state: s, file: { name: args[0], content: r.content, size: r.size } };
  }

  if (cmd === 'put') {
    if (!args[0]) {
      out.push('501 Syntax error in parameters');
      return { output: out.join('\n'), state: s };
    }
    if (!upload || !upload.content) {
      out.push(`550 No file content provided for put. 请选择要上传的文件`);
      out.push(`__NEED_UPLOAD__`);
      return { output: out.join('\n'), state: s };
    }
    const target = joinRel(s.cwd, upload.name || args[0]);
    const r = deps.vfs.write(target, upload.content);
    if (r.error) {
      out.push(`550 Failed to upload: ${r.error}`);
    } else {
      out.push(`local: ${upload.name} remote: ${displayPath(target)}`);
      out.push(`226 Transfer complete. ${r.size} bytes sent`);
    }
    return { output: out.join('\n'), state: s };
  }

  out.push(`500 Unknown command: ${cmd}. 输入 help 查看可用命令`);
  return { output: out.join('\n'), state: s };
}
