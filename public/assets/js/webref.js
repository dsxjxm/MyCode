// WWW 实训：HTML / CSS / JS 语法帮助悬浮面板
// 功能：展开/收起、拖拽移动、搜索、按分组浏览、一键插入到编辑器
import { WEB_REF } from './webref-data.js';
import { toast } from './common.js';

const STORE_KEY = 'webrefPanelState';
const TAB_BY_EXT = { html: 'html', htm: 'html', css: 'css', js: 'js', mjs: 'js', json: 'js' };

export function initWebRef({ onInsert, getActiveExt } = {}) {
  const fab = document.getElementById('refFab');
  const panel = document.getElementById('refPanel');
  const head = document.getElementById('refHead');
  const body = document.getElementById('refBody');
  const tabs = document.getElementById('refTabs');
  const search = document.getElementById('refSearch');
  const list = document.getElementById('refList');
  const collapseBtn = document.getElementById('refCollapseBtn');
  const closeBtn = document.getElementById('refCloseBtn');
  if (!fab || !panel || !head || !tabs || !search || !list) return;

  const state = {
    tab: 'html',
    keyword: '',
    openKey: '',
    collapsed: false,
    left: null,
    top: null,
    entries: new Map(),
    nodes: new Map()
  };

  restore();

  // ---------- 状态存取 ----------
  function restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      if (Number.isFinite(saved.left)) state.left = saved.left;
      if (Number.isFinite(saved.top)) state.top = saved.top;
      state.collapsed = !!saved.collapsed;
    } catch {
      /* ignore */
    }
  }

  function save() {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({ left: state.left, top: state.top, collapsed: state.collapsed })
      );
    } catch {
      /* ignore */
    }
  }

  // ---------- 位置 ----------
  function applyPosition() {
    const rect = panel.getBoundingClientRect();
    const width = rect.width || 360;
    const height = rect.height || 48;
    if (state.left == null || state.top == null) {
      state.left = Math.max(12, window.innerWidth - width - 20);
      state.top = Math.max(76, Math.round(window.innerHeight * 0.14));
    }
    state.left = Math.min(Math.max(4, state.left), Math.max(4, window.innerWidth - width - 4));
    state.top = Math.min(Math.max(4, state.top), Math.max(4, window.innerHeight - height - 4));
    panel.style.left = `${Math.round(state.left)}px`;
    panel.style.top = `${Math.round(state.top)}px`;
  }

  // ---------- 展开 / 收起 / 关闭 ----------
  function openPanel() {
    const ext = typeof getActiveExt === 'function' ? String(getActiveExt() || '') : '';
    if (TAB_BY_EXT[ext] && TAB_BY_EXT[ext] !== state.tab) {
      state.tab = TAB_BY_EXT[ext];
    }
    panel.hidden = false;
    fab.hidden = true;
    panel.classList.toggle('collapsed', state.collapsed);
    render();
    applyPosition();
    if (!state.collapsed) search.focus();
  }

  function closePanel() {
    panel.hidden = true;
    fab.hidden = false;
  }

  function setCollapsed(next) {
    state.collapsed = next;
    panel.classList.toggle('collapsed', next);
    collapseBtn.textContent = next ? '＋' : '－';
    collapseBtn.title = next ? '展开' : '收起';
    applyPosition();
    save();
  }

  // ---------- 渲染 ----------
  function render() {
    state.entries.clear();
    state.nodes.clear();
    const items = WEB_REF[state.tab] || [];
    const kw = state.keyword.trim().toLowerCase();
    const filtered = kw
      ? items.filter((item) =>
          `${item.n} ${item.d} ${item.s} ${item.g}`.toLowerCase().includes(kw)
        )
      : items;

    list.innerHTML = '';
    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'ref-empty';
      empty.textContent = '没有匹配的条目，换个关键词试试';
      list.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    let currentGroup = '';
    filtered.forEach((item) => {
      const index = items.indexOf(item);
      const key = `${state.tab}:${index}`;
      state.entries.set(key, item);

      if (item.g !== currentGroup) {
        currentGroup = item.g;
        const title = document.createElement('div');
        title.className = 'ref-group-title';
        title.textContent = currentGroup;
        fragment.appendChild(title);
      }

      const wrap = document.createElement('div');
      wrap.className = 'ref-item';
      wrap.dataset.key = key;

      const itemHead = document.createElement('button');
      itemHead.type = 'button';
      itemHead.className = 'ref-item-head';
      const name = document.createElement('code');
      name.className = 'ref-name';
      name.textContent = item.n;
      const brief = document.createElement('span');
      brief.className = 'ref-brief';
      brief.textContent = item.d;
      itemHead.append(name, brief);

      const detail = document.createElement('div');
      detail.className = 'ref-detail';
      detail.hidden = true;

      const desc = document.createElement('p');
      desc.className = 'ref-desc';
      desc.textContent = item.d;
      detail.appendChild(desc);

      const syntax = document.createElement('pre');
      syntax.className = 'ref-code';
      syntax.textContent = item.s;
      detail.appendChild(syntax);

      if (item.e) {
        const example = document.createElement('pre');
        example.className = 'ref-code example';
        example.textContent = item.e;
        detail.appendChild(example);
      }

      const insertBtn = document.createElement('button');
      insertBtn.type = 'button';
      insertBtn.className = 'ref-insert';
      insertBtn.textContent = item.e ? '插入示例到编辑器' : '插入语法到编辑器';
      detail.appendChild(insertBtn);

      wrap.append(itemHead, detail);
      fragment.appendChild(wrap);
      state.nodes.set(key, wrap);
    });
    list.appendChild(fragment);
    updateOpenStates();
  }

  function updateOpenStates() {
    state.nodes.forEach((node, key) => {
      const open = key === state.openKey;
      node.classList.toggle('open', open);
      const detail = node.querySelector('.ref-detail');
      if (detail) detail.hidden = !open;
    });
  }

  // ---------- 事件 ----------
  tabs.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-ref-tab]');
    if (!btn) return;
    state.tab = btn.dataset.refTab;
    state.keyword = '';
    search.value = '';
    state.openKey = '';
    tabs.querySelectorAll('.ref-tab').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.refTab === state.tab);
    });
    render();
    list.scrollTop = 0;
  });

  search.addEventListener('input', () => {
    state.keyword = search.value;
    state.openKey = '';
    render();
    list.scrollTop = 0;
  });

  list.addEventListener('click', (event) => {
    const insertBtn = event.target.closest('.ref-insert');
    if (insertBtn) {
      const wrap = insertBtn.closest('.ref-item');
      const entry = wrap && state.entries.get(wrap.dataset.key);
      if (!entry) return;
      const text = entry.e || entry.s;
      if (typeof onInsert === 'function') {
        const ok = onInsert(text);
        if (ok === false) toast('请先在左侧打开一个文件再插入代码', 'info');
        else toast(`已插入「${entry.n}」`, 'success');
      }
      return;
    }
    const itemHead = event.target.closest('.ref-item-head');
    if (!itemHead) return;
    const wrap = itemHead.closest('.ref-item');
    const key = wrap.dataset.key;
    state.openKey = state.openKey === key ? '' : key;
    updateOpenStates();
  });

  fab.addEventListener('click', openPanel);
  closeBtn.addEventListener('click', closePanel);
  collapseBtn.addEventListener('click', () => setCollapsed(!state.collapsed));

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) closePanel();
  });

  // ---------- 拖拽 ----------
  let drag = null;
  head.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button')) return;
    const rect = panel.getBoundingClientRect();
    drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top, id: event.pointerId };
    panel.classList.add('dragging');
    try {
      head.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
    event.preventDefault();
  });

  head.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const rect = panel.getBoundingClientRect();
    state.left = Math.min(
      Math.max(4, event.clientX - drag.dx),
      Math.max(4, window.innerWidth - rect.width - 4)
    );
    state.top = Math.min(
      Math.max(4, event.clientY - drag.dy),
      Math.max(4, window.innerHeight - rect.height - 4)
    );
    panel.style.left = `${Math.round(state.left)}px`;
    panel.style.top = `${Math.round(state.top)}px`;
  });

  const endDrag = (event) => {
    if (!drag) return;
    drag = null;
    panel.classList.remove('dragging');
    try {
      head.releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
    save();
  };
  head.addEventListener('pointerup', endDrag);
  head.addEventListener('pointercancel', endDrag);

  window.addEventListener('resize', () => {
    if (panel.hidden) return;
    applyPosition();
  });

  // 初始状态
  panel.classList.toggle('collapsed', state.collapsed);
  collapseBtn.textContent = state.collapsed ? '＋' : '－';
  collapseBtn.title = state.collapsed ? '展开' : '收起';
  render();
}
