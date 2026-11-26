export async function api(url, options = {}) {
  const opts = { credentials: 'same-origin', ...options, headers: { ...(options.headers || {}) } };
  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, opts);
  const type = res.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const message = (data && data.error) || (typeof data === 'string' && data) || res.statusText;
    const err = new Error(message);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[ch]);
}

export function formatSize(bytes) {
  const num = Number(bytes || 0);
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  return `${(num / 1024 / 1024).toFixed(2)} MB`;
}

export function formatTime(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

export function debounce(fn, wait = 300) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

export function toast(message, type = 'info') {
  let wrap = document.querySelector('.toast-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'toast-wrap';
    document.body.appendChild(wrap);
  }
  const item = document.createElement('div');
  item.className = `toast toast-${type}`;
  item.textContent = message;
  wrap.appendChild(item);
  setTimeout(() => item.classList.add('show'), 10);
  setTimeout(() => {
    item.classList.remove('show');
    setTimeout(() => item.remove(), 200);
  }, 2800);
}

export function openDialog({ title, body, width = 520, buttons = [], onMount }) {
  const mask = document.createElement('div');
  mask.className = 'dialog-mask';
  const dialog = document.createElement('div');
  dialog.className = 'dialog';
  dialog.style.maxWidth = `${width}px`;
  dialog.innerHTML = `
    <div class="dialog-head">
      <h3>${escapeHtml(title)}</h3>
      <button class="dialog-close" type="button" aria-label="关闭">×</button>
    </div>
    <div class="dialog-body"></div>
    <div class="dialog-foot"></div>`;
  const bodyEl = dialog.querySelector('.dialog-body');
  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body instanceof Node) bodyEl.appendChild(body);
  const foot = dialog.querySelector('.dialog-foot');
  const close = () => mask.remove();
  (buttons || []).forEach((item) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn ${item.variant === 'primary' ? 'btn-primary' : item.variant === 'danger' ? 'btn-danger' : 'btn-ghost'}`;
    btn.textContent = item.text;
    btn.addEventListener('click', async () => {
      const shouldClose = item.onClick ? await item.onClick(dialog, close) : true;
      if (shouldClose !== false) close();
    });
    foot.appendChild(btn);
  });
  dialog.querySelector('.dialog-close').addEventListener('click', close);
  mask.addEventListener('click', (event) => {
    if (event.target === mask) close();
  });
  document.body.appendChild(mask);
  mask.appendChild(dialog);
  if (onMount) onMount(dialog, close);
  return { el: dialog, body: bodyEl, close };
}

export function confirmDialog({ title = '确认操作', message, okText = '确定', danger = false }) {
  return new Promise((resolve) => {
    let decided = false;
    const dlg = openDialog({
      title,
      body: `<p class="dialog-text">${message}</p>`,
      width: 440,
      buttons: [
        { text: '取消', variant: 'ghost', onClick: () => { decided = true; resolve(false); } },
        {
          text: okText,
          variant: danger ? 'danger' : 'primary',
          onClick: () => { decided = true; resolve(true); }
        }
      ]
    });
    const observer = new MutationObserver(() => {
      if (!document.body.contains(dlg.el) && !decided) {
        decided = true;
        resolve(false);
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true });
  });
}

export function promptDialog({ title, label, value = '', placeholder = '', okText = '确定' }) {
  return new Promise((resolve) => {
    let decided = false;
    const body = document.createElement('div');
    body.innerHTML = `
      <label class="field-label">${escapeHtml(label || '')}</label>
      <input class="input" id="promptInput" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}">`;
    const dlg = openDialog({
      title,
      body,
      width: 440,
      buttons: [
        { text: '取消', variant: 'ghost', onClick: () => { decided = true; resolve(null); } },
        {
          text: okText,
          variant: 'primary',
          onClick: () => {
            decided = true;
            resolve(dlg.el.querySelector('#promptInput').value.trim());
          }
        }
      ],
      onMount: (el) => {
        const input = el.querySelector('#promptInput');
        input.focus();
        input.select();
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            decided = true;
            resolve(input.value.trim());
            dlg.close();
          }
        });
      }
    });
    const observer = new MutationObserver(() => {
      if (!document.body.contains(dlg.el) && !decided) {
        decided = true;
        resolve(null);
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true });
  });
}

export async function guardRole(role) {
  try {
    const { user } = await api('/api/auth/me');
    if (user.role !== role) {
      location.href = user.role === 'teacher' ? '/admin.html' : '/workspace.html';
      return null;
    }
    return user;
  } catch {
    location.href = '/login.html';
    return null;
  }
}

export function bindLogout(button) {
  if (!button) return;
  button.addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } finally {
      location.href = '/login.html';
    }
  });
}
