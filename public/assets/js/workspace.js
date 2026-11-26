import {
  api,
  bindLogout,
  confirmDialog,
  debounce,
  escapeHtml,
  guardRole,
  promptDialog,
  toast
} from './common.js';

window.ace.config.set('basePath', '/vendor/ace');
window.ace.config.set('modePath', '/vendor/ace');
window.ace.config.set('themePath', '/vendor/ace');

const state = {
  me: null,
  files: [],
  tabs: [],
  activePath: null,
  selectedDir: '',
  previewToken: '',
  settings: null,
  expanded: new Set(),
  spacePath: '',
  autoOpened: false
};

const el = {
  lab: document.getElementById('lab'),
  userChip: document.getElementById('userChip'),
  logoutBtn: document.getElementById('logoutBtn'),
  fileTree: document.getElementById('fileTree'),
  currentDir: document.getElementById('currentDir'),
  spacePath: document.getElementById('spacePath'),
  tabs: document.getElementById('tabs'),
  editor: document.getElementById('editor'),
  editorEmpty: document.getElementById('editorEmpty'),
  statusText: document.getElementById('statusText'),
  saveState: document.getElementById('saveState'),
  cursorInfo: document.getElementById('cursorInfo'),
  previewFrame: document.getElementById('previewFrame'),
  previewUrl: document.getElementById('previewUrl'),
  settingsPanel: document.getElementById('settingsPanel'),
  setSiteEnabled: document.getElementById('setSiteEnabled'),
  siteEnabledText: document.getElementById('siteEnabledText'),
  setDirBrowsing: document.getElementById('setDirBrowsing'),
  docList: document.getElementById('docList'),
  docAddInput: document.getElementById('docAddInput'),
  docAddBtn: document.getElementById('docAddBtn'),
  mimePresetBtn: document.getElementById('mimePresetBtn'),
  logBox: document.getElementById('logBox'),
  refreshLogsBtn: document.getElementById('refreshLogsBtn'),
  fontUp: document.getElementById('fontUp'),
  fontDown: document.getElementById('fontDown'),
  setMime: document.getElementById('setMime'),
  fileInput: document.getElementById('fileInput')
};

let editor = null;
let suppressChange = false;
let lastPreviewRel = null;
let scheduleSave = () => {};
let docDraft = [];

init();

async function init() {
  const user = await guardRole('student');
  if (!user) return;
  state.me = user;
  el.userChip.textContent = `${user.className} · ${user.name}（${user.username}）`;
  bindLogout(el.logoutBtn);
  initEditor();
  bindEvents();
  await loadSpace();
}

function initEditor() {
  const savedSize = Number(localStorage.getItem('editorFontSize')) || 13.5;
  editor = window.ace.edit('editor');
  editor.setTheme('ace/theme/chrome');
  editor.session.setUseWorker(false);
  editor.setOptions({
    fontSize: `${savedSize}px`,
    showPrintMargin: false,
    wrap: true,
    tabSize: 2,
    useSoftTabs: true,
    highlightActiveLine: true,
    enableBasicAutocompletion: true,
    enableLiveAutocompletion: false
  });
  editor.session.on('change', onEditorChange);
  editor.selection.on('changeCursor', () => {
    const pos = editor.getCursorPosition();
    el.cursorInfo.textContent = `第 ${pos.row + 1} 行，第 ${pos.column + 1} 列`;
  });
  editor.commands.addCommand({
    name: 'saveFile',
    bindKey: { win: 'Ctrl-S', mac: 'Cmd-S' },
    exec: () => saveActive(true)
  });
  scheduleSave = debounce(() => saveActive(false), 1200);
  el.editor.classList.add('hidden');
}

function bindEvents() {
  document.getElementById('newFileBtn').addEventListener('click', () => createEntry('file'));
  document.getElementById('newDirBtn').addEventListener('click', () => createEntry('dir'));
  document.getElementById('uploadBtn').addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', uploadFiles);
  document.getElementById('refreshPreviewBtn').addEventListener('click', () => refreshPreview());
  document.getElementById('settingsBtn').addEventListener('click', () => {
    el.settingsPanel.hidden = !el.settingsPanel.hidden;
    if (!el.settingsPanel.hidden) {
      syncSettingsForm();
      loadLogs();
    }
  });
  document.getElementById('closeSettingsBtn').addEventListener('click', () => {
    el.settingsPanel.hidden = true;
  });
  document.getElementById('saveSettingsBtn').addEventListener('click', saveSettings);
  el.setSiteEnabled.addEventListener('change', () => {
    el.siteEnabledText.textContent = el.setSiteEnabled.checked ? '已启动' : '已停止';
  });
  el.fontUp.addEventListener('click', () => changeFontSize(1));
  el.fontDown.addEventListener('click', () => changeFontSize(-1));
  el.refreshLogsBtn.addEventListener('click', loadLogs);
  el.mimePresetBtn.addEventListener('click', fillMimePresets);
  el.docAddBtn.addEventListener('click', addDefaultDoc);
  el.docAddInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') addDefaultDoc();
  });
  el.docList.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-doc]');
    if (!btn) return;
    const index = Number(btn.dataset.index);
    const action = btn.dataset.doc;
    if (action === 'up' && index > 0) {
      [docDraft[index - 1], docDraft[index]] = [docDraft[index], docDraft[index - 1]];
    } else if (action === 'down' && index < docDraft.length - 1) {
      [docDraft[index + 1], docDraft[index]] = [docDraft[index], docDraft[index + 1]];
    } else if (action === 'del') {
      docDraft.splice(index, 1);
    }
    renderDocList();
  });

  document.getElementById('fullscreenBtn').addEventListener('click', (event) => {
    el.lab.classList.toggle('preview-full');
    const on = el.lab.classList.contains('preview-full');
    event.currentTarget.textContent = on ? '退出全屏' : '全屏';
    editor.resize();
  });

  el.fileTree.addEventListener('click', async (event) => {
    const act = event.target.closest('.tree-act');
    if (act) {
      event.stopPropagation();
      const target = act.closest('.tree-row').dataset.path;
      if (act.dataset.act === 'rename') await renamePath(target);
      if (act.dataset.act === 'download') downloadPath(target);
      return;
    }
    const del = event.target.closest('.tree-del');
    if (del) {
      event.stopPropagation();
      await deletePath(del.dataset.del);
      return;
    }
    const row = event.target.closest('.tree-row');
    if (!row) return;
    const path = row.dataset.path;
    if (row.dataset.type === 'dir') {
      state.selectedDir = path;
      if (state.expanded.has(path)) state.expanded.delete(path);
      else state.expanded.add(path);
      renderTree();
      updateCurrentDir();
    } else {
      state.selectedDir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      updateCurrentDir();
      await openFile(path);
    }
  });

  el.tabs.addEventListener('click', async (event) => {
    const close = event.target.closest('.tab-close');
    if (close) {
      event.stopPropagation();
      await closeTab(close.dataset.close);
      return;
    }
    const tabEl = event.target.closest('.tab');
    if (tabEl) activateTab(tabEl.dataset.path);
  });

  const splitter = document.getElementById('splitter');
  splitter.addEventListener('mousedown', (event) => {
    event.preventDefault();
    const rect = el.lab.getBoundingClientRect();
    const startX = event.clientX;
    const editorWidth = document.querySelector('.editor-pane').getBoundingClientRect().width;
    const onMove = (moveEvent) => {
      const next = Math.max(280, Math.min(rect.width - 620, editorWidth + moveEvent.clientX - startX));
      el.lab.style.gridTemplateColumns = `236px ${next}px 6px minmax(320px, 1fr)`;
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      editor.resize();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  splitter.addEventListener('dblclick', () => {
    el.lab.style.gridTemplateColumns = '';
    editor.resize();
  });

  window.addEventListener('beforeunload', (event) => {
    if (state.tabs.some((tab) => tab.dirty)) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
}

function onEditorChange() {
  if (suppressChange) return;
  const tab = activeTab();
  if (!tab) return;
  tab.content = editor.getValue();
  tab.dirty = true;
  el.saveState.textContent = '未保存…';
  scheduleSave();
}

async function loadSpace() {
  try {
    const data = await api('/api/space/files');
    state.files = data.files;
    state.previewToken = data.previewToken;
    state.settings = data.settings;
    state.spacePath = data.spacePath;
    el.spacePath.textContent = `个人空间：${data.spacePath}`;
    if (state.expanded.size === 0) {
      data.files.filter((file) => file.type === 'dir').forEach((file) => state.expanded.add(file.path));
    }
    renderTree();
    syncSettingsForm();
    if (!state.autoOpened) {
      const starter =
        data.files.find((file) => file.path === 'index.html' && file.type === 'file') ||
        data.files.find((file) => file.type === 'file' && /\.html?$/i.test(file.path));
      state.autoOpened = true;
      if (starter) await openFile(starter.path);
      else refreshPreview();
    } else {
      refreshPreview();
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function reloadFiles() {
  const data = await api('/api/space/files');
  state.files = data.files;
  state.previewToken = data.previewToken;
  state.settings = data.settings;
  state.tabs = state.tabs.filter((tab) => state.files.some((file) => file.path === tab.path && file.type === 'file'));
  const activeMissing = !state.tabs.some((tab) => tab.path === state.activePath);
  if (activeMissing) {
    state.activePath = null;
    const next = state.tabs[state.tabs.length - 1];
    if (next) {
      activateTab(next.path);
      syncSettingsForm();
      return;
    }
  }
  renderTree();
  renderTabs();
  syncSettingsForm();
  if (!state.activePath) showEmptyEditor();
  refreshPreview();
}

function buildTree(files) {
  const root = { name: '', path: '', type: 'dir', children: new Map() };
  for (const file of files) {
    const parts = file.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const name = parts[i];
      const path = parts.slice(0, i + 1).join('/');
      if (!node.children.has(path)) {
        node.children.set(path, { name, path, type: 'dir', children: new Map() });
      }
      node = node.children.get(path);
    }
    const last = parts[parts.length - 1];
    if (file.type === 'dir') {
      if (!node.children.has(file.path)) {
        node.children.set(file.path, { name: last, path: file.path, type: 'dir', children: new Map() });
      }
    } else {
      node.children.set(file.path, { name: last, path: file.path, type: 'file', size: file.size, mtime: file.mtime });
    }
  }
  return root;
}

function renderTree() {
  el.fileTree.innerHTML = '';
  if (!state.files.length) {
    el.fileTree.innerHTML = '<div class="tree-empty">空间为空，点击上方按钮新建文件</div>';
    return;
  }
  const tree = buildTree(state.files);
  el.fileTree.appendChild(renderChildren(tree, 0));
}

function renderChildren(node, depth) {
  const wrap = document.createElement('div');
  const items = [...node.children.values()].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'tree-row';
    row.dataset.path = item.path;
    row.dataset.type = item.type;
    row.style.paddingLeft = `${8 + depth * 14}px`;
    if (item.type === 'dir') {
      const open = state.expanded.has(item.path);
      row.innerHTML = `
        <span class="caret">${open ? '▾' : '▸'}</span>
        <span class="tree-name">${escapeHtml(item.name)}</span>
        <button class="tree-act" type="button" data-act="rename" title="重命名">✎</button>
        <button class="tree-del" type="button" title="删除文件夹">×</button>`;
      row.querySelector('.tree-del').dataset.del = item.path;
      if (open) row.classList.add('open');
      if (state.selectedDir === item.path) row.classList.add('selected');
      wrap.appendChild(row);
      if (open) wrap.appendChild(renderChildren(item, depth + 1));
    } else {
      const ext = (item.name.split('.').pop() || '').toLowerCase();
      let badge = 'f-other';
      let label = ext.slice(0, 4) || 'txt';
      if (['html', 'htm'].includes(ext)) { badge = 'f-html'; label = 'html'; }
      else if (ext === 'css') { badge = 'f-css'; label = 'css'; }
      else if (['js', 'mjs'].includes(ext)) { badge = 'f-js'; label = 'js'; }
      else if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'].includes(ext)) { badge = 'f-img'; label = 'img'; }
      row.innerHTML = `
        <span class="file-badge ${badge}">${escapeHtml(label)}</span>
        <span class="tree-name" title="${escapeHtml(item.path)}">${escapeHtml(item.name)}</span>
        <button class="tree-act" type="button" data-act="rename" title="重命名">✎</button>
        <button class="tree-act" type="button" data-act="download" title="下载">↓</button>
        <button class="tree-del" type="button" title="删除文件">×</button>`;
      row.querySelector('.tree-del').dataset.del = item.path;
      if (state.activePath === item.path) row.classList.add('selected');
      wrap.appendChild(row);
    }
  }
  return wrap;
}

function updateCurrentDir() {
  el.currentDir.textContent = `www/${state.selectedDir ? `${state.selectedDir}/` : ''}`;
}

function renderTabs() {
  el.tabs.innerHTML = state.tabs
    .map(
      (tab) => `
      <div class="tab ${tab.path === state.activePath ? 'active' : ''}">
        <span class="tab-dot ${tab.dirty ? 'on' : ''}"></span>
        <span class="tab-name" title="${escapeHtml(tab.path)}">${escapeHtml(tab.path.split('/').pop())}</span>
        <button class="tab-close" type="button" title="关闭">×</button>
      </div>`
    )
    .join('');
  el.tabs.querySelectorAll('.tab').forEach((tabEl, index) => {
    const tab = state.tabs[index];
    tabEl.dataset.path = tab.path;
    tabEl.querySelector('.tab-close').dataset.close = tab.path;
  });
}

function updateTabDot(tab) {
  const idx = state.tabs.indexOf(tab);
  const tabEl = el.tabs.children[idx];
  if (!tabEl) return;
  const dot = tabEl.querySelector('.tab-dot');
  if (dot) dot.classList.toggle('on', tab.dirty);
}

function activeTab() {
  return state.tabs.find((tab) => tab.path === state.activePath) || null;
}

async function openFile(path) {
  let tab = state.tabs.find((item) => item.path === path);
  if (!tab) {
    try {
      const { content } = await api(`/api/space/file?path=${encodeURIComponent(path)}`);
      tab = { path, content, dirty: false };
      state.tabs.push(tab);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
  }
  activateTab(path);
}

function activateTab(path) {
  const tab = state.tabs.find((item) => item.path === path);
  if (!tab) return;
  state.activePath = path;
  suppressChange = true;
  editor.setValue(tab.content ?? '', -1);
  suppressChange = false;
  editor.session.setMode(modeForPath(path));
  el.editor.classList.remove('hidden');
  el.editorEmpty.classList.add('hidden');
  editor.resize();
  renderTabs();
  renderTree();
  el.statusText.textContent = `已打开 ${path}`;
  el.saveState.textContent = tab.dirty ? '未保存…' : '已同步';
  const rel = previewRel();
  if (rel !== lastPreviewRel) refreshPreview();
}

function modeForPath(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  if (['html', 'htm'].includes(ext)) return 'ace/mode/html';
  if (ext === 'css') return 'ace/mode/css';
  if (['js', 'mjs', 'json'].includes(ext)) return 'ace/mode/javascript';
  return 'ace/mode/text';
}

function showEmptyEditor() {
  el.editor.classList.add('hidden');
  el.editorEmpty.classList.remove('hidden');
  el.cursorInfo.textContent = '';
  el.saveState.textContent = '';
  renderTabs();
}

async function closeTab(path) {
  const tab = state.tabs.find((item) => item.path === path);
  if (tab?.dirty) {
    const ok = await confirmDialog({
      title: '关闭文件',
      message: `「${escapeHtml(path)}」还有未保存的修改，确定关闭吗？`,
      okText: '仍然关闭',
      danger: true
    });
    if (!ok) return;
  }
  state.tabs = state.tabs.filter((item) => item.path !== path);
  if (state.activePath === path) {
    const next = state.tabs[state.tabs.length - 1];
    if (next) {
      activateTab(next.path);
      return;
    }
    state.activePath = null;
    showEmptyEditor();
    refreshPreview();
    return;
  }
  renderTabs();
}

async function saveActive(manual) {
  const tab = activeTab();
  if (!tab) {
    if (manual) toast('当前没有打开的文件', 'info');
    return;
  }
  if (!tab.dirty) {
    if (manual) {
      toast('文件已保存', 'info');
      refreshPreview();
    }
    return;
  }
  try {
    await api('/api/space/file', {
      method: 'PUT',
      body: { path: tab.path, content: tab.content }
    });
    tab.dirty = false;
    updateTabDot(tab);
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    el.saveState.textContent = `已保存 ${time}`;
    if (manual) toast('保存成功', 'success');
    schedulePreviewRefresh();
  } catch (err) {
    el.saveState.textContent = '保存失败';
    toast(err.message, 'error');
  }
}

async function createEntry(type) {
  const label = type === 'dir' ? '文件夹名称' : '文件名（可含子目录，如 css/demo.css）';
  const value = await promptDialog({
    title: type === 'dir' ? '新建文件夹' : '新建文件',
    label,
    placeholder: type === 'dir' ? '例如 images' : '例如 about.html',
    value: ''
  });
  if (!value) return;
  const path = state.selectedDir ? `${state.selectedDir}/${value}` : value;
  try {
    await api('/api/space/new', { method: 'POST', body: { path, type } });
    toast(type === 'dir' ? '文件夹已创建' : '文件已创建', 'success');
    if (type === 'dir') state.expanded.add(path);
    await reloadFiles();
    if (type === 'file') await openFile(path);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deletePath(path) {
  const ok = await confirmDialog({
    title: '删除',
    message: `确定删除「${escapeHtml(path)}」吗？若为文件夹会连同内部文件一起删除。`,
    okText: '删除',
    danger: true
  });
  if (!ok) return;
  try {
    await api('/api/space/delete', { method: 'POST', body: { path } });
    toast('已删除', 'success');
    state.tabs = state.tabs.filter((tab) => tab.path !== path && !tab.path.startsWith(`${path}/`));
    await reloadFiles();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function uploadFiles() {
  const files = [...el.fileInput.files];
  if (!files.length) return;
  for (const file of files) {
    const form = new FormData();
    form.append('path', state.selectedDir);
    form.append('file', file);
    try {
      await api('/api/space/upload', { method: 'POST', body: form });
      toast(`已上传 ${file.name}`, 'success');
    } catch (err) {
      toast(`${file.name}：${err.message}`, 'error');
    }
  }
  el.fileInput.value = '';
  await reloadFiles();
}

function syncSettingsForm() {
  const settings = state.settings;
  if (!settings) return;
  el.setSiteEnabled.checked = settings.siteEnabled;
  el.setDirBrowsing.checked = settings.directoryBrowsing;
  docDraft = [...(settings.defaultDocs || [])];
  renderDocList();
  el.setMime.value = Object.entries(settings.mimeTypes || {})
    .map(([key, value]) => `${key} ${value}`)
    .join('\n');
  el.siteEnabledText.textContent = settings.siteEnabled ? '已启动' : '已停止';
}

function renderDocList() {
  if (!docDraft.length) {
    el.docList.innerHTML = '<div class="muted small" style="padding:6px 0">暂无默认文档</div>';
    return;
  }
  el.docList.innerHTML = docDraft
    .map(
      (name, index) => `
      <div class="doc-item">
        <span class="doc-index">${index + 1}</span>
        <span class="doc-name">${escapeHtml(name)}</span>
        <span class="doc-ops">
          <button class="mini-btn" type="button" data-doc="up" data-index="${index}" ${index === 0 ? 'disabled' : ''} title="上移">↑</button>
          <button class="mini-btn" type="button" data-doc="down" data-index="${index}" ${index === docDraft.length - 1 ? 'disabled' : ''} title="下移">↓</button>
          <button class="mini-btn danger" type="button" data-doc="del" data-index="${index}" title="移除">×</button>
        </span>
      </div>`
    )
    .join('');
}

function addDefaultDoc() {
  const name = el.docAddInput.value.trim();
  if (!name) return;
  if (/[\\/]/.test(name)) {
    toast('默认文档不能包含斜杠', 'error');
    return;
  }
  if (docDraft.includes(name)) {
    toast('已存在该默认文档', 'info');
    return;
  }
  if (docDraft.length >= 10) {
    toast('最多设置 10 个默认文档', 'error');
    return;
  }
  docDraft.push(name);
  el.docAddInput.value = '';
  renderDocList();
}

function fillMimePresets() {
  const presets = {
    html: 'text/html',
    htm: 'text/html',
    css: 'text/css',
    js: 'text/javascript',
    json: 'application/json',
    xml: 'application/xml',
    txt: 'text/plain',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    ico: 'image/x-icon',
    pdf: 'application/pdf',
    mp4: 'video/mp4',
    mp3: 'audio/mpeg',
    woff: 'font/woff',
    woff2: 'font/woff2'
  };
  const merged = new Map();
  for (const line of el.setMime.value.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2) merged.set(parts[0].toLowerCase(), parts.slice(1).join(' '));
  }
  for (const [key, value] of Object.entries(presets)) {
    if (!merged.has(key)) merged.set(key, value);
  }
  el.setMime.value = [...merged.entries()].map(([key, value]) => `${key} ${value}`).join('\n');
  toast('已填入常用 MIME 类型，可继续修改后保存', 'success');
}

async function loadLogs() {
  try {
    const { logs } = await api('/api/space/logs');
    if (!logs.length) {
      el.logBox.innerHTML = '<span class="muted small">暂无访问记录，刷新预览后会出现</span>';
      return;
    }
    el.logBox.innerHTML = logs
      .map(
        (log) => `
      <div class="log-row">
        <span class="log-time">${new Date(log.time).toLocaleTimeString('zh-CN', { hour12: false })}</span>
        <span class="log-status s${log.status}">${log.status}</span>
        <span class="log-path" title="${escapeHtml(log.path)}">${escapeHtml(log.path)}</span>
        <span class="log-note">${escapeHtml(log.note || '')}</span>
      </div>`
      )
      .join('');
  } catch (err) {
    el.logBox.innerHTML = `<span class="muted small">${escapeHtml(err.message)}</span>`;
  }
}

function changeFontSize(delta) {
  const current = Number(localStorage.getItem('editorFontSize')) || 13.5;
  const next = Math.min(22, Math.max(11, current + delta));
  localStorage.setItem('editorFontSize', String(next));
  editor.setFontSize(`${next}px`);
}

async function saveSettings() {
  const mimeTypes = {};
  for (const line of el.setMime.value.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2) mimeTypes[parts[0]] = parts.slice(1).join(' ');
  }
  try {
    const { settings } = await api('/api/space/settings', {
      method: 'PUT',
      body: {
        siteEnabled: el.setSiteEnabled.checked,
        directoryBrowsing: el.setDirBrowsing.checked,
        defaultDocs: docDraft,
        mimeTypes
      }
    });
    state.settings = settings;
    syncSettingsForm();
    toast('站点设置已保存', 'success');
    refreshPreview();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function renamePath(path) {
  const current = path.split('/').pop();
  const newName = await promptDialog({
    title: '重命名',
    label: `为「${current}」输入新名称`,
    value: current,
    okText: '重命名'
  });
  if (!newName || newName === current) return;
  try {
    const result = await api('/api/space/rename', {
      method: 'POST',
      body: { path, newName }
    });
    const newPath = result.path;
    state.tabs.forEach((tab) => {
      if (tab.path === path) tab.path = newPath;
      else if (tab.path.startsWith(`${path}/`)) tab.path = newPath + tab.path.slice(path.length);
    });
    if (state.activePath === path) state.activePath = newPath;
    else if (state.activePath?.startsWith(`${path}/`)) {
      state.activePath = newPath + state.activePath.slice(path.length);
    }
    if (state.selectedDir === path) state.selectedDir = newPath;
    else if (state.selectedDir.startsWith(`${path}/`)) {
      state.selectedDir = newPath + state.selectedDir.slice(path.length);
    }
    await reloadFiles();
    updateCurrentDir();
    toast('已重命名', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

function downloadPath(path) {
  location.href = `/api/space/download?path=${encodeURIComponent(path)}`;
}

function previewRel() {
  const tab = activeTab();
  if (tab && /\.html?$/i.test(tab.path)) return tab.path;
  return '';
}

function refreshPreview() {
  if (!state.previewToken) return;
  const rel = previewRel();
  const encoded = rel ? rel.split('/').map(encodeURIComponent).join('/') : '';
  el.previewUrl.textContent = `/${rel || ''}${state.settings && !state.settings.siteEnabled ? '（站点已停止）' : ''}`;
  el.previewFrame.src = `/preview/${state.previewToken}/${encoded}?t=${Date.now()}`;
  lastPreviewRel = rel;
}

const schedulePreviewRefresh = debounce(refreshPreview, 450);
