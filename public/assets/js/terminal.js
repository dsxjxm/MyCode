import { api, bindLogout, escapeHtml, guardRole, toast } from './common.js';

const FTP_INIT = { connected: false, loggedIn: false, cwd: '', user: null, host: null, pendingUser: null };
const TELNET_INIT = { connected: false, loggedIn: false, step: '', user: null, host: null, cwd: '' };

const QUICK = {
  ftp: ['open', 'user', 'pass', 'ls', 'pwd', 'cd', 'mkdir', 'delete', 'rename', 'get', 'put', 'help', 'bye'],
  telnet: ['open', 'ls', 'pwd', 'cd', 'get', 'put', 'whoami', 'date', 'echo', 'help', 'exit']
};

const state = {
  mode: 'ftp',
  ftp: { ...FTP_INIT },
  telnet: { ...TELNET_INIT },
  history: [],
  historyIdx: -1,
  me: null
};

const el = {
  userChip: document.getElementById('userChip'),
  logoutBtn: document.getElementById('logoutBtn'),
  output: document.getElementById('output'),
  cmdInput: document.getElementById('cmdInput'),
  prompt: document.getElementById('prompt'),
  quickGrid: document.getElementById('quickGrid'),
  statusLine: document.getElementById('statusLine'),
  historyList: document.getElementById('historyList'),
  uploadBtn: document.getElementById('uploadBtn'),
  fileInput: document.getElementById('fileInput'),
  modeSwitch: document.querySelector('.mode-switch')
};

init();

async function init() {
  const user = await guardRole('student');
  if (!user) return;
  state.me = user;
  el.userChip.textContent = `${user.className} · ${user.name}（${user.username}）`;
  bindLogout(el.logoutBtn);
  bindEvents();
  loadHistory();
  renderQuick();
  printWelcome();
  el.cmdInput.focus();
}

function bindEvents() {
  el.cmdInput.addEventListener('keydown', onInputKey);
  el.modeSwitch.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    switchMode(btn.dataset.mode);
  });
  el.quickGrid.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-cmd]');
    if (!btn) return;
    const cmd = btn.dataset.cmd;
    if (cmd === 'put') {
      el.fileInput.click();
      return;
    }
    if (cmd === 'user' || cmd === 'cd' || cmd === 'mkdir' || cmd === 'delete' || cmd === 'rename' || cmd === 'get' || cmd === 'open' || cmd === 'echo') {
      el.cmdInput.value = cmd + ' ';
      el.cmdInput.focus();
      return;
    }
    runCommand(cmd);
  });
  el.uploadBtn.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', onFileSelected);
  el.historyList.addEventListener('click', (e) => {
    const item = e.target.closest('.history-item');
    if (!item) return;
    el.cmdInput.value = item.dataset.cmd;
    el.cmdInput.focus();
  });
}

function switchMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  document.querySelectorAll('.mode-switch button').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  renderQuick();
  clearTerminal();
  printWelcome();
  updatePrompt();
  updateStatus();
  el.cmdInput.focus();
}

function renderQuick() {
  const cmds = QUICK[state.mode] || [];
  el.quickGrid.innerHTML = cmds
    .map((c) => `<button type="button" data-cmd="${c}">${c}</button>`)
    .join('');
}

function printWelcome() {
  if (state.mode === 'ftp') {
    appendLine(`# FTP 模拟终端 — 操作学生个人 FTP 空间`, 'dim');
    appendLine(`# 依次执行：open → user 学号 → pass 密码，即可登录`, 'dim');
    appendLine(`# 输入 help 查看所有命令`, 'dim');
  } else {
    appendLine(`# Telnet 模拟终端 — 远程登录到模拟服务器`, 'dim');
    appendLine(`# 执行 open 主机名，然后按提示输入学号、密码登录`, 'dim');
    appendLine(`# 输入 help 查看所有命令`, 'dim');
  }
  appendLine('');
}

function clearTerminal() {
  el.output.innerHTML = '';
}

function appendLine(text, cls = '') {
  const div = document.createElement('div');
  div.className = 'line' + (cls ? ' ' + cls : '');
  div.textContent = text;
  el.output.appendChild(div);
  el.output.scrollTop = el.output.scrollHeight;
}

function appendHtml(html) {
  const div = document.createElement('div');
  div.className = 'line';
  div.innerHTML = html;
  el.output.appendChild(div);
  el.output.scrollTop = el.output.scrollHeight;
}

function classifyLine(text) {
  if (/^(550|530|500|501|503|425|421)/.test(text)) return 'err';
  if (/^(2\d\d|3\d\d)/.test(text)) return 'code';
  return '';
}

function renderOutput(command, result) {
  appendLine(`${promptText()} ${command}`, 'echo');
  if (result.output === '__CLEAR__') {
    clearTerminal();
    return;
  }
  const lines = String(result.output || '').split('\n');
  for (const line of lines) {
    if (line === '__NEED_UPLOAD__') {
      appendLine(`>>> 请点击左侧「上传文件」选择要上传的文件`, 'dim');
      continue;
    }
    appendLine(line, classifyLine(line));
  }
  if (result.file) {
    const safeName = escapeHtml(result.file.name);
    const id = 'dl_' + Date.now();
    appendHtml(
      `<a class="get-link" id="${id}">⬇ 下载 ${safeName}（${result.file.size} 字节）</a>`
    );
    document.getElementById(id).addEventListener('click', () => downloadFile(result.file));
  }
}

function promptText() {
  return state.mode === 'ftp' ? 'ftp>' : currentTelnetPrompt();
}

function currentTelnetPrompt() {
  const s = state.telnet;
  if (!s.connected) return 'telnet>';
  if (s.step === 'awaitingUser') return 'login:';
  if (s.step === 'awaitingPass') return 'Password:';
  return '$';
}

function updatePrompt() {
  el.prompt.textContent = promptText() + ' ';
}

function updateStatus() {
  const s = state.mode === 'ftp' ? state.ftp : state.telnet;
  let html = '';
  if (state.mode === 'ftp') {
    html = `模式：<b>FTP</b><br>`;
    html += `连接：${s.connected ? `<b>${escapeHtml(s.host || '已连接')}</b>` : '未连接'}<br>`;
    html += `登录：${s.loggedIn ? `<b>${escapeHtml(s.user)}</b>` : '未登录'}<br>`;
    html += `目录：<b>/${escapeHtml(s.cwd || '')}</b>`;
  } else {
    html = `模式：<b>Telnet</b><br>`;
    html += `连接：${s.connected ? `<b>${escapeHtml(s.host || '已连接')}</b>` : '未连接'}<br>`;
    html += `登录：${s.loggedIn ? `<b>${escapeHtml(s.user)}</b>` : '未登录'}<br>`;
    html += `目录：<b>/${escapeHtml(s.cwd || '')}</b>`;
  }
  el.statusLine.innerHTML = html;
}

function historyKey() {
  return `lan_term_history_${state.me?.username || 'anon'}`;
}
function loadHistory() {
  try {
    const raw = localStorage.getItem(historyKey());
    const arr = raw ? JSON.parse(raw) : [];
    if (Array.isArray(arr)) {
      state.history = arr.filter((x) => typeof x === 'string').slice(-50);
      renderHistory();
    }
  } catch {}
}
function saveHistory() {
  try {
    localStorage.setItem(historyKey(), JSON.stringify(state.history));
  } catch {}
}

function addHistory(cmd) {
  if (!cmd.trim()) return;
  if (state.history[state.history.length - 1] === cmd) return;
  state.history.push(cmd);
  if (state.history.length > 50) state.history.shift();
  renderHistory();
  saveHistory();
}

function renderHistory() {
  el.historyList.innerHTML = state.history
    .slice()
    .reverse()
    .map((c) => `<div class="history-item" data-cmd="${escapeHtml(c)}">${escapeHtml(c)}</div>`)
    .join('');
}

async function runCommand(command, upload) {
  const cmd = (command || '').trim();
  if (!cmd) return;
  addHistory(cmd);
  state.historyIdx = -1;
  try {
    const cur = state.mode === 'ftp' ? state.ftp : state.telnet;
    const result = await api('/api/terminal/exec', {
      method: 'POST',
      body: { mode: state.mode, command: cmd, state: cur, upload }
    });
    renderOutput(cmd, result);
    if (result.state) {
      if (state.mode === 'ftp') state.ftp = result.state;
      else state.telnet = result.state;
    }
    updatePrompt();
    updateStatus();
  } catch (err) {
    appendLine(`错误：${err.message}`, 'err');
  }
}

function onInputKey(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    const val = el.cmdInput.value;
    el.cmdInput.value = '';
    runCommand(val);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (state.history.length === 0) return;
    if (state.historyIdx === -1) state.historyIdx = state.history.length - 1;
    else if (state.historyIdx > 0) state.historyIdx--;
    el.cmdInput.value = state.history[state.historyIdx];
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (state.historyIdx === -1) return;
    if (state.historyIdx < state.history.length - 1) {
      state.historyIdx++;
      el.cmdInput.value = state.history[state.historyIdx];
    } else {
      state.historyIdx = -1;
      el.cmdInput.value = '';
    }
  }
}

function onFileSelected(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const content = reader.result;
    const upload = { name: file.name, content: typeof content === 'string' ? content : '' };
    if (typeof content !== 'string') {
      toast('二进制文件暂不支持文本上传', 'error');
      el.fileInput.value = '';
      return;
    }
    runCommand(`put ${file.name}`, upload);
    el.fileInput.value = '';
  };
  reader.readAsText(file);
}

function downloadFile(file) {
  const blob = new Blob([file.content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`已下载 ${file.name}`, 'success');
}
