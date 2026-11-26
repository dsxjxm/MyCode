// 邮件服务器前端 — 状态管理 + UI 渲染 + API 交互
(function () {
  'use strict';

  // ========== 状态 ==========
  const state = {
    user: null,
    role: null,
    folder: 'inbox',
    mails: [],
    counts: { inbox: { total: 0, unread: 0 }, sent: { total: 0, unread: 0 }, draft: { total: 0, unread: 0 }, junk: { total: 0, unread: 0 }, trash: { total: 0, unread: 0 } },
    currentMailId: null,
    mailAccount: null,     // 当前绑定的邮箱账号（学生=自己，教师=选中的）
    smtp_log: [],
    attachments: [],       // 待发送附件 [{id,name,size,stored}]
  };

  // ========== API 封装 ==========
  async function api(method, path, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch('/api/mail' + path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // ========== 工具 ==========
  function toast(msg, type = 'success', ms = 2500) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast show ' + type;
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), ms);
  }
  function debounce(fn, ms) {
    let t; return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }
  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) {
      return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    }
    const year = d.getFullYear() === now.getFullYear() ? '' : d.getFullYear() + '/';
    return `${year}${d.getMonth() + 1}/${d.getDate()}`;
  }
  function truncate(s, n = 32) {
    s = s || '';
    return s.length > n ? s.slice(0, n) + '…' : s;
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escapeAttr(s) {
    return escapeHtml(s);
  }
  function fmtSize(bytes) {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }
  function accountQuery() {
    return state.role === 'teacher' && state.mailAccount ? `account_id=${state.mailAccount.id}` : '';
  }

  // ========== 初始化 ==========
  async function init() {
    try {
      const u = await fetch('/api/auth/me').then(r => r.json()).catch(() => null);
      if (!u || !u.user) { window.location.href = '/login.html'; return; }
      state.user = u.user;
      state.role = u.user.role;

      // UI 填充
      const me = state.user;
      const cls = me.className || me.class_name || '';
      document.getElementById('userChip').textContent =
        `${cls ? cls + ' · ' : ''}${me.name}（${me.username}）`;
      if (state.role === 'teacher') document.body.classList.add('is-teacher');
      const logoutBtn = document.getElementById('logoutBtn');
      if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
          await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
          window.location.href = '/login.html';
        });
      }

      // 加载邮箱配置 + 确定 mailAccount
      await loadMailIdentity();
      await refreshAll();
    } catch (e) {
      toast(e.message || '初始化失败', 'error');
    }
  }

  async function loadMailIdentity() {
    // 通过 counts 接口隐式触发 bindMailAccount，然后根据当前用户推断邮箱
    try {
      const counts = await api('GET', '/mails/counts');
      state.counts = counts;
    } catch { /* 可能没有邮箱账号 */ }

    // 查 config + 账号列表，拿到当前账号地址
    try {
      const cfg = await api('GET', '/config');
      const accounts = await api('GET', '/accounts');
      if (state.role === 'student') {
        const myAcct = accounts.find(a => a.student_id === state.user.id);
        state.mailAccount = myAcct || null;
      } else {
        // 教师默认显示第一个学生的邮箱
        state.mailAccount = accounts[0] || null;
      }
      if (state.mailAccount) {
        document.getElementById('myAddr').textContent = state.mailAccount.full_address;
      } else {
        document.getElementById('myAddr').textContent = '(无)';
        toast('没有可用的邮箱账号', 'error');
      }
    } catch (e) {
      toast('加载邮箱配置失败: ' + e.message, 'error');
    }
  }

  // ========== 核心操作 ==========
  async function refreshAll() {
    try {
      // 如果是教师且指定了 account_id，需要重新请求 counts / mails
      const counts = await api('GET', '/mails/counts' + (state.mailAccount && state.role === 'teacher' ? `?account_id=${state.mailAccount.id}` : ''));
      state.counts = counts;
      renderCounts();
      await loadMailList();
    } catch (e) { toast(e.message, 'error'); }
  }

  function renderCounts() {
    const folders = ['inbox', 'sent', 'draft', 'junk', 'trash'];
    for (const f of folders) {
      const el = document.getElementById('cnt-' + f);
      const c = state.counts[f];
      // 未读数显示（收件箱显示未读，其他显示总数）
      if (f === 'inbox') {
        el.textContent = c.unread > 0 ? c.unread : (c.total > 0 ? c.total : '');
        el.style.display = c.total > 0 ? 'inline' : 'none';
      } else {
        el.textContent = c.total > 0 ? c.total : '';
        el.style.display = c.total > 0 ? 'inline' : 'none';
      }
    }
    document.getElementById('emptyTrashBtn').style.display = state.folder === 'trash' ? 'inline' : 'none';
  }

  async function switchFolder(folder) {
    state.folder = folder;
    state.currentMailId = null;
    document.querySelectorAll('.sidebar .folder').forEach(el => el.classList.toggle('active', el.dataset.folder === folder));
    document.getElementById('emptyTrashBtn').style.display = folder === 'trash' ? 'inline' : 'none';
    document.getElementById('mailDetail').innerHTML = '<div class="empty-detail">⬅️ 从左侧选择一封邮件查看详情</div>';
    await loadMailList();
  }

  async function loadMailList() {
    try {
      const qs = new URLSearchParams();
      qs.set('folder', state.folder);
      if (state.role === 'teacher' && state.mailAccount) qs.set('account_id', state.mailAccount.id);
      const list = await api('GET', '/mails?' + qs.toString());
      state.mails = list;
      renderMailList();
    } catch (e) { toast(e.message, 'error'); }
  }

  function renderMailList() {
    const tbody = document.getElementById('mailTbody');
    const empty = document.getElementById('emptyHint');
    tbody.innerHTML = '';
    if (state.mails.length === 0) {
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';
    for (const m of state.mails) {
      const isUnread = m.is_read === 0;
      const tr = document.createElement('tr');
      tr.className = isUnread ? 'unread' : '';
      tr.onclick = () => viewMail(m.mailbox_id);
      tr.innerHTML = `
        <td>${isUnread ? '<span style="width:8px;height:8px;background:#3d7fb5;border-radius:50%;display:inline-block;"></span>' : ''}</td>
        <td onclick="event.stopPropagation();toggleStar(${m.mailbox_id})">
          <span class="star ${m.is_starred ? 'on' : 'off'}">${m.is_starred ? '★' : '☆'}</span>
        </td>
        <td title="${m.sender_address}">${truncate(m.sender_address || m.sender_name, 20)}</td>
        <td title="${m.subject}">${truncate(m.subject || '(无主题)', 40)}<span style="color:#aaa;font-weight:400;font-size:12px;margin-left:6px;">${truncate(m.body || '', 20)}</span></td>
        <td>${fmtTime(m.created_at)}</td>
      `;
      tbody.appendChild(tr);
    }
  }

  async function viewMail(mailboxId) {
    try {
      const qs = new URLSearchParams();
      if (state.role === 'teacher' && state.mailAccount) qs.set('account_id', state.mailAccount.id);
      const mail = await api('GET', `/mails/${mailboxId}?` + qs.toString());
      state.currentMailId = mailboxId;
      renderMailDetail(mail);
      // 刷新 counts（已读标记更新）
      refreshAll();
    } catch (e) { toast(e.message, 'error'); }
  }

  function renderMailDetail(mail) {
    const el = document.getElementById('mailDetail');
    const atts = Array.isArray(mail.attachments) && mail.attachments.length > 0
      ? `<div class="attachments"><h4>📎 附件（${mail.attachments.length}）</h4>${mail.attachments.map(a =>
          `<a class="detail-attach-link" href="/api/mail/attachments/${encodeURIComponent(a.stored || a.id)}" download>📄 ${(a.name || '附件')} <span style="color:#999;">(${fmtSize(a.size)})</span></a>`
        ).join('')}</div>`
      : '';
    const hasHtml = !!(mail.html_body && mail.html_body.trim());
    const bodyHtml = hasHtml
      ? `<div class="detail-body"><iframe sandbox srcdoc="${escapeAttr(mail.html_body)}"></iframe></div>`
      : `<div class="detail-body" style="padding:18px 24px;white-space:pre-wrap;">${escapeHtml(mail.body || '(空正文)')}</div>`;
    const isInbox = mail.folder === 'inbox';
    const smtpHtml = Array.isArray(mail.smtp_log) && mail.smtp_log.length > 0
      ? `<div class="proto-panel">
          <div class="proto-header">
            <span class="title">🔐 SMTP 协议交互日志</span>
            <button onclick="this.parentElement.parentElement.style.display='none'">关闭</button>
          </div>
          <div class="proto-content">
            ${mail.smtp_log.map(l => {
              const txt = l.text === null ? '<span class="null-data">(空行)</span>' : escapeHtml(l.text).replace(/\n/g,'<br>');
              return `<div class="line ${l.dir === 'C' ? 'client' : 'server'}"><span class="ts">[${new Date(l.ts).toLocaleTimeString('zh-CN')}]</span>${l.dir === 'C' ? '→ C:' : '← S:'} ${txt}</div>`;
            }).join('')}
          </div>
        </div>`
      : '';
    el.innerHTML = `
      <div class="detail-header">
        <div class="subject">${escapeHtml(mail.subject || '(无主题)')}</div>
        <div class="meta">
          <span class="sender">${escapeHtml(mail.sender_name || mail.sender_address)}</span>
          <span>—</span>
          <span>${escapeHtml(mail.sender_address)}</span>
          <span style="margin-left:auto;color:#aaa;">${fmtTime(mail.created_at)}</span>
        </div>
        <div class="meta" style="color:#888;">
          <span>收件人: ${escapeHtml(mail.recipient_address)}</span>
          ${mail.cc_addresses && mail.cc_addresses !== '[]' ? `<span>抄送: ${escapeHtml(mail.cc_addresses)}</span>` : ''}
        </div>
      </div>
      <div class="detail-actions">
        <button onclick="replyMail()">↩️ 回复</button>
        <button onclick="forwardMail()">➡️ 转发</button>
        <button onclick="deleteCurrentMail()">🗑️ 删除</button>
        <button onclick="junkMail()">⚠️ 标记垃圾</button>
        ${isInbox ? `<button onclick="blacklistFromMail()" style="color:#e74c3c;">🚫 拉黑发件人</button>` : ''}
        <button onclick="printSmtpLog()">📋 复制 SMTP 日志</button>
      </div>
      ${bodyHtml}
      ${atts}
      ${smtpHtml}
    `;
    // iframe 自动高度
    const iframe = el.querySelector('.detail-body iframe');
    if (iframe) {
      iframe.onload = () => {
        try { iframe.style.height = Math.min(iframe.contentDocument.body.scrollHeight + 20, 600) + 'px'; } catch {}
      };
    }
  }

  async function toggleStar(mailboxId) {
    try {
      await api('PUT', `/mails/${mailboxId}/star`);
      // 先本地换星标，避免刷新
      const m = state.mails.find(x => x.mailbox_id === mailboxId);
      if (m) m.is_starred = m.is_starred ? 0 : 1;
      renderMailList();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function markAllRead() {
    try {
      await api('PUT', '/mails/mark-all-read', { folder: state.folder });
      toast('已标记全部已读', 'success');
      await refreshAll();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function deleteCurrentMail() {
    if (!state.currentMailId) return;
    if (!confirm('确定要删除这封邮件吗？')) return;
    try {
      await api('DELETE', `/mails/${state.currentMailId}`);
      toast('已删除', 'success');
      state.currentMailId = null;
      document.getElementById('mailDetail').innerHTML = '<div class="empty-detail">⬅️ 从左侧选择一封邮件查看详情</div>';
      await refreshAll();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function junkMail() {
    if (!state.currentMailId) return;
    try {
      await api('PUT', `/mails/${state.currentMailId}/move`, { folder: 'junk' });
      toast('已移至垃圾邮件', 'success');
      await switchFolder(state.folder);
    } catch (e) { toast(e.message, 'error'); }
  }

  async function emptyTrash() {
    if (!confirm('确定要清空回收站吗？此操作不可恢复。')) return;
    try {
      await api('PUT', '/mails/empty-trash');
      toast('回收站已清空', 'success');
      await refreshAll();
    } catch (e) { toast(e.message, 'error'); }
  }

  function replyMail() {
    const cur = state.mails.find(x => x.mailbox_id === state.currentMailId);
    if (!cur) return;
    openCompose();
    document.getElementById('toInput').value = cur.sender_address;
    document.getElementById('subjectInput').value = 'Re: ' + (cur.subject || '');
    document.getElementById('bodyEditor').innerHTML =
      `<p><br></p><p style="color:#888;">----- 原邮件 -----</p><blockquote style="border-left:2px solid #ccc;padding-left:10px;color:#666;">${escapeHtml(cur.body || '')}</blockquote>`;
  }

  function forwardMail() {
    const cur = state.mails.find(x => x.mailbox_id === state.currentMailId);
    if (!cur) return;
    openCompose();
    document.getElementById('subjectInput').value = 'Fwd: ' + (cur.subject || '');
    document.getElementById('bodyEditor').innerHTML =
      `<p><br></p><p style="color:#888;">----- 转发邮件 -----</p><blockquote style="border-left:2px solid #ccc;padding-left:10px;color:#666;">${escapeHtml(cur.body || '')}</blockquote>`;
  }

  function printSmtpLog() {
    const text = document.querySelector('.proto-panel .proto-content');
    if (!text) { toast('这封邮件没有 SMTP 日志', 'error'); return; }
    const lines = Array.from(text.querySelectorAll('.line')).map(el => el.textContent);
    navigator.clipboard?.writeText(lines.join('\n')).then(
      () => toast('SMTP 日志已复制到剪贴板', 'success'),
      () => toast('复制失败', 'error')
    );
  }

  function refresh() { refreshAll(); }

  let searchTimer;
  function doSearch() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const kw = document.getElementById('searchInput').value.trim();
      if (!kw) { await loadMailList(); return; }
      try {
        const qs = new URLSearchParams();
        qs.set('folder', state.folder);
        qs.set('keyword', kw);
        if (state.role === 'teacher' && state.mailAccount) qs.set('account_id', state.mailAccount.id);
        state.mails = await api('GET', '/mails?' + qs.toString());
        renderMailList();
      } catch (e) { toast(e.message, 'error'); }
    }, 300);
  }

  // ========== 写邮件弹窗 ==========
  let _composeMode = 'send'; // send / draft / reply / forward

  function openCompose() {
    _composeMode = 'send';
    document.getElementById('composeTitle').textContent = '✉️ 写邮件';
    ['toInput', 'ccInput', 'subjectInput'].forEach(id => document.getElementById(id).value = '');
    const editor = document.getElementById('bodyEditor');
    editor.innerHTML = '';
    state.attachments = [];
    renderAttachChips();
    resetSchedRow();
    document.getElementById('composeModal').classList.add('show');
    setTimeout(() => document.getElementById('toInput').focus(), 100);
    setupRecipientAutocomplete();
    setupRichText();
    setupAttachInput();
  }
  function closeCompose() { document.getElementById('composeModal').classList.remove('show'); }

  // 富文本工具栏
  let _rtBound = false;
  function setupRichText() {
    if (_rtBound) return;
    _rtBound = true;
    const toolbar = document.getElementById('rtToolbar');
    const editor = document.getElementById('bodyEditor');
    toolbar.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
    toolbar.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      editor.focus();
      const cmd = btn.dataset.cmd;
      const val = btn.dataset.value || null;
      if (cmd === 'createLink') {
        const url = prompt('请输入链接地址：', 'https://');
        if (url) document.execCommand('createLink', false, url);
      } else if (cmd === 'removeFormat') {
        document.execCommand('removeFormat');
      } else if (cmd === 'foreColor' || cmd === 'hiliteColor') {
        document.execCommand(cmd, false, val || '#e74c3c');
      } else {
        document.execCommand(cmd, false, null);
      }
      editor.focus();
    });
  }

  function getComposeBody() {
    const editor = document.getElementById('bodyEditor');
    const html = editor.innerHTML.trim();
    const text = editor.innerText.trim();
    // 完全空（只有 <br>）视为空
    return { html: text ? html : '', text };
  }

  // 附件
  let _attachBound = false;
  function setupAttachInput() {
    if (_attachBound) return;
    _attachBound = true;
    document.getElementById('attachInput').addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      for (const f of files) {
        if (state.attachments.length >= 5) { toast('最多 5 个附件', 'error'); break; }
        if (f.size > 10 * 1024 * 1024) { toast(`「${f.name}」超过 10MB，已跳过`, 'error'); continue; }
        try {
          const fd = new FormData();
          fd.append('file', f);
          const res = await fetch('/api/mail/attachments', { method: 'POST', body: fd });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || '上传失败');
          state.attachments.push(data.attachment);
          renderAttachChips();
        } catch (err) { toast(err.message, 'error'); }
      }
    });
  }

  function renderAttachChips() {
    const box = document.getElementById('attachChips');
    box.innerHTML = state.attachments.map((a, i) =>
      `<span class="attach-chip">📄 ${escapeHtml(a.name)} <span style="color:#8aa;">${fmtSize(a.size)}</span><span class="rm" onclick="removeAttachment(${i})">×</span></span>`
    ).join('');
  }
  function removeAttachment(i) {
    state.attachments.splice(i, 1);
    renderAttachChips();
  }

  async function setupRecipientAutocomplete() {
    // 简单的自动补全：监听输入，下拉显示本地邮箱
    const input = document.getElementById('toInput');
    if (input._bound) return;
    input._bound = true;
    input.addEventListener('input', debounce(async () => {
      const q = input.value.trim();
      if (q.length < 1) return;
      try {
        const qs = new URLSearchParams();
        qs.set('q', q);
        if (state.role === 'teacher' && state.mailAccount) qs.set('account_id', state.mailAccount.id);
        const rows = await api('GET', '/recipients/search?' + qs.toString());
        showAutocomplete(input, rows);
      } catch {}
    }, 200));
  }

  function showAutocomplete(input, rows) {
    // 移除旧下拉
    document.querySelectorAll('.ac-dropdown').forEach(el => el.remove());
    if (!rows || rows.length === 0) return;
    const rect = input.getBoundingClientRect();
    const dd = document.createElement('div');
    dd.className = 'ac-dropdown';
    dd.style.cssText = `position:fixed;top:${rect.bottom + 2}px;left:${rect.left}px;right:${rect.right}px;background:#fff;border:1px solid #ddd;border-radius:4px;box-shadow:0 4px 16px rgba(0,0,0,.15);z-index:250;max-height:180px;overflow:auto;font-size:12px;`;
    for (const r of rows) {
      const row = document.createElement('div');
      row.style.cssText = 'padding:6px 10px;cursor:pointer;border-bottom:1px solid #f0f0f0;';
      row.innerHTML = `<span style="font-weight:600;color:#3d7fb5;">${r.full_address}</span><span style="color:#aaa;margin-left:8px;">${r.display_name || ''}</span>`;
      row.onmouseenter = () => row.style.background = '#eef4fb';
      row.onmouseleave = () => row.style.background = '#fff';
      row.onclick = () => { input.value = r.full_address; dd.remove(); };
      dd.appendChild(row);
    }
    document.body.appendChild(dd);
    // 点击其他处关闭
    setTimeout(() => {
      document.addEventListener('click', function close(e) {
        if (!dd.contains(e.target) && e.target !== input) { dd.remove(); document.removeEventListener('click', close); }
      });
    }, 50);
  }

  function collectCompose() {
    const to = document.getElementById('toInput').value.trim();
    const cc = document.getElementById('ccInput').value.trim();
    const subject = document.getElementById('subjectInput').value.trim();
    const body = getComposeBody();
    return {
      toArr: to.split(/[,\s;]+/).filter(Boolean),
      ccArr: cc ? cc.split(/[,\s;]+/).filter(Boolean) : [],
      subject, bodyText: body.text, bodyHtml: body.html
    };
  }

  async function sendMail() {
    const c = collectCompose();
    if (c.toArr.length === 0) { toast('请填写收件人', 'error'); return; }
    if (!c.subject && !c.bodyText) { toast('主题和正文不能都为空', 'error'); return; }

    const payload = {
      to: c.toArr, cc: c.ccArr,
      subject: c.subject, body: c.bodyText, html_body: c.bodyHtml,
      attachments: state.attachments
    };
    const qs = accountQuery() ? `?${accountQuery()}` : '';

    try {
      toast('📤 正在发送（SMTP 握手中...）', 'success', 1500);
      const res = await api('POST', '/send' + qs, payload);
      const rejected = res.rejected || [];
      closeCompose();
      toast(`✅ 发送成功！送达 ${res.delivered_to} 封${rejected.length ? `，${rejected.length} 封被拒绝` : ''}`, 'success', 3500);
      await refreshAll();
      await switchFolder('sent');
      if (state.mails.length > 0) viewMail(state.mails[0].mailbox_id);
    } catch (e) {
      toast('❌ ' + e.message, 'error', 4000);
    }
  }

  async function saveDraft() {
    const c = collectCompose();
    const qs = accountQuery() ? `?${accountQuery()}` : '';
    try {
      await api('POST', '/drafts' + qs, {
        to: c.toArr, cc: c.ccArr, subject: c.subject,
        body: c.bodyText, html_body: c.bodyHtml, attachments: state.attachments
      });
      closeCompose();
      toast('💾 已保存到草稿箱', 'success');
      await refreshAll();
      await switchFolder('draft');
    } catch (e) { toast(e.message, 'error'); }
  }

  // ========== 定时发送 ==========
  function resetSchedRow() {
    document.getElementById('schedRow').style.display = 'none';
    document.getElementById('schedConfirmBtn').style.display = 'none';
    document.getElementById('schedToggleBtn').style.display = 'inline-block';
    document.getElementById('schedTime').value = '';
  }
  function toggleSched() {
    const row = document.getElementById('schedRow');
    const show = row.style.display === 'none';
    row.style.display = show ? 'flex' : 'none';
    document.getElementById('schedConfirmBtn').style.display = show ? 'inline-block' : 'none';
    document.getElementById('schedToggleBtn').style.display = show ? 'none' : 'inline-block';
    if (show) {
      // 默认 5 分钟后
      const t = new Date(Date.now() + 5 * 60 * 1000);
      t.setSeconds(0, 0);
      const pad = n => String(n).padStart(2, '0');
      document.getElementById('schedTime').value =
        `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}`;
    }
  }
  async function scheduleMail() {
    const c = collectCompose();
    if (c.toArr.length === 0) { toast('请填写收件人', 'error'); return; }
    if (!c.subject && !c.bodyText) { toast('主题和正文不能都为空', 'error'); return; }
    const tval = document.getElementById('schedTime').value;
    if (!tval) { toast('请选择发送时间', 'error'); return; }
    const sendAt = new Date(tval).getTime();
    if (!sendAt || sendAt <= Date.now()) { toast('发送时间必须晚于当前时间', 'error'); return; }
    const qs = accountQuery() ? `?${accountQuery()}` : '';
    try {
      await api('POST', '/scheduled' + qs, {
        to: c.toArr, cc: c.ccArr, subject: c.subject,
        body: c.bodyText, html_body: c.bodyHtml,
        attachments: state.attachments, send_at: sendAt
      });
      closeCompose();
      toast(`⏰ 已设定于 ${new Date(sendAt).toLocaleString('zh-CN')} 发送`, 'success', 3500);
    } catch (e) { toast(e.message, 'error'); }
  }

  async function openSched() {
    document.getElementById('schedModal').classList.add('show');
    const content = document.getElementById('schedContent');
    content.innerHTML = '<p style="color:#aaa;">加载中...</p>';
    try {
      const list = await api('GET', '/scheduled' + (accountQuery() ? `?${accountQuery()}` : ''));
      if (list.length === 0) { content.innerHTML = '<p style="color:#aaa;padding:20px 0;">暂无定时发送任务</p>'; return; }
      content.innerHTML = `<table>
        <thead><tr><th>主题</th><th>收件人</th><th>计划发送</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>${list.map(t => `
          <tr>
            <td>${escapeHtml(truncate(t.subject || '(无主题)', 18))}</td>
            <td>${escapeHtml(truncate((t.to_addresses || []).join(', '), 20))}</td>
            <td>${new Date(t.send_at).toLocaleString('zh-CN')}</td>
            <td>${schedStatusLabel(t.status)}${t.error ? `<div style="color:#e74c3c;font-size:11px;">${escapeHtml(t.error)}</div>` : ''}</td>
            <td>${t.status === 'pending' ? `<button class="btn btn-sm" style="color:#e74c3c;" onclick="cancelScheduled(${t.id})">取消</button>` : '-'}</td>
          </tr>`).join('')}</tbody></table>
        <p style="color:#999;font-size:11px;margin-top:10px;">💡 任务在设定时间到达后由服务器自动发出，并出现在「已发送」中。</p>`;
    } catch (e) { content.innerHTML = `<p style="color:#e74c3c;">${e.message}</p>`; }
  }
  function closeSched() { document.getElementById('schedModal').classList.remove('show'); }
  function schedStatusLabel(s) {
    const map = { pending: '<span style="color:#e6882d;">待发送</span>', sent: '<span style="color:#27ae60;">已发送</span>', cancelled: '<span style="color:#999;">已取消</span>', failed: '<span style="color:#e74c3c;">失败</span>' };
    return map[s] || s;
  }
  async function cancelScheduled(id) {
    if (!confirm('确定取消这个定时任务吗？')) return;
    try {
      await api('DELETE', `/scheduled/${id}` + (accountQuery() ? `?${accountQuery()}` : ''));
      toast('已取消', 'success');
      await openSched();
    } catch (e) { toast(e.message, 'error'); }
  }

  // ========== 黑名单 ==========
  async function openBlacklist() {
    document.getElementById('blacklistModal').classList.add('show');
    const content = document.getElementById('blacklistContent');
    content.innerHTML = '<p style="color:#aaa;">加载中...</p>';
    try {
      const list = await api('GET', '/blacklist' + (accountQuery() ? `?${accountQuery()}` : ''));
      content.innerHTML = `
        <div class="row-form" style="align-items:flex-end;">
          <div class="form-group"><label>要拒收的发件人邮箱</label>
            <input id="blAddr" placeholder="例如 20250101@example.local" style="width:260px;">
          </div>
          <button class="btn btn-primary" onclick="addBlacklistAddress()">🚫 加入黑名单</button>
        </div>
        ${list.length === 0 ? '<p style="color:#aaa;padding:14px 0;">黑名单为空</p>' : `
        <table><thead><tr><th>发件人</th><th>加入时间</th><th>操作</th></tr></thead>
        <tbody>${list.map(b => `<tr>
          <td><b>${escapeHtml(b.blocked_address)}</b></td>
          <td style="color:#aaa;">${fmtTime(b.created_at)}</td>
          <td><button class="btn btn-sm" style="color:#e74c3c;" onclick="removeBlacklistAddress(${b.id})">移除</button></td>
        </tr>`).join('')}</tbody></table>`}
        <p style="color:#999;font-size:11px;margin-top:10px;">💡 加入黑名单后，来自该地址的邮件会在 SMTP 的 RCPT TO 阶段被 550 拒收。</p>
      `;
    } catch (e) { content.innerHTML = `<p style="color:#e74c3c;">${e.message}</p>`; }
  }
  function closeBlacklist() { document.getElementById('blacklistModal').classList.remove('show'); }
  async function addBlacklistAddress() {
    const address = document.getElementById('blAddr').value.trim();
    if (!address) { toast('请输入邮箱地址', 'error'); return; }
    try {
      await api('POST', '/blacklist' + (accountQuery() ? `?${accountQuery()}` : ''), { address });
      toast('已加入黑名单', 'success');
      await openBlacklist();
    } catch (e) { toast(e.message, 'error'); }
  }
  async function removeBlacklistAddress(id) {
    try {
      await api('DELETE', `/blacklist/${id}` + (accountQuery() ? `?${accountQuery()}` : ''));
      toast('已移除', 'success');
      await openBlacklist();
    } catch (e) { toast(e.message, 'error'); }
  }
  async function blacklistFromMail() {
    const cur = state.mails.find(x => x.mailbox_id === state.currentMailId);
    if (!cur) return;
    const addr = cur.sender_address;
    if (!confirm(`确定将 ${addr} 加入黑名单吗？此后来自该地址的邮件将被拒收。`)) return;
    try {
      await api('POST', '/blacklist' + (accountQuery() ? `?${accountQuery()}` : ''), { address: addr });
      toast('已拉黑 ' + addr, 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  // ========== 教师管理 ==========
  let _adminTab = 'config';

  async function openAdmin(which) {
    _adminTab = which === 'pop3' ? 'pop3' : (which === 'accounts' ? 'accounts' : 'config');
    document.getElementById('adminTitle').textContent = _adminTab === 'config' ? '⚙️ 邮件服务器配置'
      : _adminTab === 'accounts' ? '👥 邮箱账号管理'
      : '🔌 POP3 会话模拟';
    const tabs = document.getElementById('adminTabs');
    tabs.innerHTML = `
      <div class="tab ${_adminTab === 'config' ? 'active' : ''}" onclick="switchAdminTab('config')">服务器配置</div>
      <div class="tab ${_adminTab === 'accounts' ? 'active' : ''}" onclick="switchAdminTab('accounts')">账号管理</div>
      <div class="tab ${_adminTab === 'pop3' ? 'active' : ''}" onclick="switchAdminTab('pop3')">POP3 测试</div>
    `;
    document.getElementById('adminModal').classList.add('show');
    await renderAdminTab();
  }
  function closeAdmin() { document.getElementById('adminModal').classList.remove('show'); }
  function switchAdminTab(t) { _adminTab = t; openAdmin(t); }

  async function renderAdminTab() {
    const content = document.getElementById('adminContent');
    if (_adminTab === 'config') {
      try {
        const cfg = await api('GET', '/config');
        content.innerHTML = `
          <div class="row-form">
            <div class="form-group"><label>邮件域名</label><input id="cfgDomain" value="${cfg.domain || ''}"></div>
            <div class="form-group"><label>SMTP 端口</label><input id="cfgSmtp" type="number" value="${cfg.smtp_port || 25}"></div>
            <div class="form-group"><label>POP3 端口</label><input id="cfgPop3" type="number" value="${cfg.pop3_port || 110}"></div>
            <div class="form-group"><label>最大邮件大小 (KB)</label><input id="cfgMax" type="number" value="${cfg.max_size_kb || 10240}"></div>
            <div class="form-group"><label>服务状态</label>
              <select id="cfgEnabled" style="padding:6px;border:1px solid #ddd;border-radius:4px;">
                <option value="1" ${cfg.enabled ? 'selected' : ''}>✅ 启用</option>
                <option value="0" ${!cfg.enabled ? 'selected' : ''}>🚫 禁用（模拟 SMTP 450 错误）</option>
              </select>
            </div>
          </div>
          <button class="btn btn-primary" onclick="saveMailConfig()">💾 保存配置</button>
          <p style="color:#888;font-size:11px;margin-top:12px;">
            💡 提示：改完域名后，已存在的邮箱账号域名不会自动变更。可以删除旧账号让系统重新 seed。
          </p>
        `;
      } catch (e) { content.innerHTML = `<p style="color:#e74c3c;">${e.message}</p>`; }
    } else if (_adminTab === 'accounts') {
      try {
        const accounts = await api('GET', '/accounts');
        content.innerHTML = `
          <div style="margin-bottom:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <input id="newAcctUser" placeholder="邮箱前缀 (如 teacher02)" style="padding:6px;border:1px solid #ddd;border-radius:4px;font-size:12px;width:150px;">
            <input id="newAcctDisplay" placeholder="显示名" style="padding:6px;border:1px solid #ddd;border-radius:4px;font-size:12px;width:120px;">
            <input id="newAcctPwd" type="password" placeholder="初始密码" value="123456" style="padding:6px;border:1px solid #ddd;border-radius:4px;font-size:12px;width:120px;">
            <button class="btn btn-primary" onclick="createAccount()">➕ 创建账号</button>
            <button class="btn btn-danger btn-sm" onclick="resetAllPwd()">🔄 全部重置密码为 123456</button>
            <span style="margin-left:16px;">查看模式：
              <select id="viewAcctSelect" onchange="viewAccount(this.value)" style="padding:6px;border:1px solid #ddd;border-radius:4px;">
                <option value="">选择一个邮箱查看</option>
                ${accounts.map(a => `<option value="${a.id}" ${state.mailAccount && state.mailAccount.id === a.id ? 'selected' : ''}>${a.full_address} ${a.student_name ? '(' + a.student_name + ')' : ''}</option>`).join('')}
              </select>
            </span>
          </div>
          <table>
            <thead><tr><th>ID</th><th>完整邮箱地址</th><th>显示名</th><th>关联学生</th><th>创建时间</th><th>操作</th></tr></thead>
            <tbody>
              ${accounts.map(a => `
                <tr>
                  <td>${a.id}</td>
                  <td><b>${a.full_address}</b></td>
                  <td>${a.display_name || '-'}</td>
                  <td>${a.student_name ? `${a.student_name}（${a.student_no}）` : '<span style="color:#aaa;">未关联</span>'}</td>
                  <td style="color:#aaa;">${fmtTime(a.created_at)}</td>
                  <td>
                    <button class="btn btn-sm" onclick="viewAccount(${a.id})">查看</button>
                    <button class="btn btn-sm" onclick="resetOnePwd(${a.id})">改密</button>
                    <button class="btn btn-sm" style="color:#e74c3c;" onclick="delAccount(${a.id})">删除</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `;
      } catch (e) { content.innerHTML = `<p style="color:#e74c3c;">${e.message}</p>`; }
    } else { // pop3
      if (!state.mailAccount) { content.innerHTML = '<p style="color:#aaa;">请先在"账号管理"中选择一个邮箱</p>'; return; }
      try {
        const res = await api('GET', `/pop3-session?account_id=${state.mailAccount.id}`);
        content.innerHTML = `
          <p style="margin:0 0 10px 0;color:#3d7fb5;">🔐 ${state.mailAccount.full_address} 的 POP3 会话（共 ${res.log.length} 条交互）</p>
          <pre style="background:#1e1e2e;color:#cdd6f4;padding:14px;border-radius:4px;font-size:12px;max-height:500px;overflow:auto;margin:0;font-family:'Cascadia Mono',Consolas,monospace;line-height:1.5;">
${res.log.map(l => `[${new Date(l.ts).toLocaleTimeString('zh-CN')}] ${l.dir === 'C' ? '→ C:' : '← S:'} ${l.text}`).join('\n')}
          </pre>
        `;
      } catch (e) { content.innerHTML = `<p style="color:#e74c3c;">${e.message}</p>`; }
    }
  }

  async function saveMailConfig() {
    try {
      await api('PUT', '/config', {
        domain: document.getElementById('cfgDomain').value,
        smtp_port: Number(document.getElementById('cfgSmtp').value),
        pop3_port: Number(document.getElementById('cfgPop3').value),
        max_size_kb: Number(document.getElementById('cfgMax').value),
        enabled: document.getElementById('cfgEnabled').value === '1'
      });
      toast('✅ 配置已保存', 'success');
      await loadMailIdentity();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function createAccount() {
    const username = document.getElementById('newAcctUser').value.trim();
    const display_name = document.getElementById('newAcctDisplay').value.trim();
    const password = document.getElementById('newAcctPwd').value;
    if (!username || !password) { toast('用户名和密码必填', 'error'); return; }
    try {
      await api('POST', '/accounts', { username, display_name, password });
      toast('✅ 账号已创建', 'success');
      await renderAdminTab();
    } catch (e) { toast(e.message, 'error'); }
  }
  async function resetOnePwd(id) {
    const pwd = prompt('请输入新密码（至少 4 位）：', '123456');
    if (!pwd || pwd.length < 4) return;
    try { await api('PUT', `/accounts/${id}/password`, { password: pwd }); toast('✅ 密码已更新', 'success'); }
    catch (e) { toast(e.message, 'error'); }
  }
  async function delAccount(id) {
    if (!confirm('确定要删除此邮箱账号吗？关联的邮件也会一起删除。')) return;
    try { await api('DELETE', `/accounts/${id}`); toast('✅ 已删除', 'success'); if (state.mailAccount?.id === id) state.mailAccount = null; await renderAdminTab(); await loadMailIdentity(); await refreshAll(); }
    catch (e) { toast(e.message, 'error'); }
  }
  async function resetAllPwd() {
    if (!confirm('确定要把所有邮箱账号密码重置为 123456 吗？')) return;
    try { await api('POST', '/accounts/reset-all-passwords'); toast('✅ 已重置', 'success'); }
    catch (e) { toast(e.message, 'error'); }
  }
  async function viewAccount(id) {
    const accounts = await api('GET', '/accounts');
    state.mailAccount = accounts.find(a => a.id === Number(id)) || null;
    if (state.mailAccount) {
      document.getElementById('myAddr').textContent = state.mailAccount.full_address;
      toast(`🔍 正在以管理员身份查看 ${state.mailAccount.full_address}`, 'success', 2500);
      closeAdmin();
      await refreshAll();
    }
  }

  // ========== 通讯簿 ==========
  let _bookContacts = [];
  async function openAddressBook() {
    document.getElementById('bookModal').classList.add('show');
    const list = document.getElementById('bookList');
    list.innerHTML = '<p style="color:#888;font-size:13px;">加载中…</p>';
    try {
      _bookContacts = await api('GET', '/address-book');
    } catch (e) {
      list.innerHTML = `<p style="color:#c0392b;font-size:13px;">加载失败：${escapeHtml(e.message)}</p>`;
      return;
    }
    const search = document.getElementById('bookSearch');
    search.value = '';
    search.oninput = () => renderBook(search.value.trim().toLowerCase());
    renderBook('');
  }
  function renderBook(kw) {
    const list = document.getElementById('bookList');
    const rows = _bookContacts.filter((c) => !kw
      || String(c.full_address || '').toLowerCase().includes(kw)
      || String(c.display_name || '').toLowerCase().includes(kw)
      || String(c.real_name || '').toLowerCase().includes(kw)
      || String(c.student_no || '').toLowerCase().includes(kw));
    if (!rows.length) {
      list.innerHTML = '<p style="color:#888;font-size:13px;">没有匹配的联系人</p>';
      return;
    }
    const myAddr = String(state.mailAccount?.full_address || '').toLowerCase();
    list.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead><tr style="color:#8a94a3;text-align:left;">
        <th style="padding:6px;">姓名</th><th>学号</th><th>邮箱地址</th><th></th>
      </tr></thead>
      <tbody>${rows.map((c) => {
        const isSelf = myAddr && String(c.full_address || '').toLowerCase() === myAddr;
        const action = isSelf
          ? '<span style="color:#9aa5b1;font-size:11px;">（我）</span>'
          : `<button class="btn-sched" style="padding:4px 10px;" onclick="useContact('${escapeAttr(c.full_address || '')}')">写邮件</button>`;
        return `<tr style="border-top:1px solid #eef1f5;">
        <td style="padding:7px 6px;">${escapeHtml(c.display_name || c.real_name || '')}
          <div style="color:#9aa5b1;font-size:11px;">${escapeHtml(c.class_name || '')}</div></td>
        <td style="padding:7px 6px;color:#666;">${escapeHtml(c.student_no || '')}</td>
        <td style="padding:7px 6px;color:#2c5f8a;">${escapeHtml(c.full_address || '')}</td>
        <td style="padding:7px 6px;text-align:right;">${action}</td>
      </tr>`;
      }).join('')}</tbody></table>`;
  }
  function useContact(address) {
    closeAddressBook();
    openCompose();
    document.getElementById('toInput').value = address;
    document.getElementById('subjectInput').focus();
  }
  function closeAddressBook() {
    document.getElementById('bookModal').classList.remove('show');
  }

  // ========== 导出到全局 ==========
  window.switchFolder = switchFolder;
  window.refresh = refresh;
  window.openCompose = openCompose;
  window.closeCompose = closeCompose;
  window.sendMail = sendMail;
  window.saveDraft = saveDraft;
  window.toggleStar = toggleStar;
  window.markAllRead = markAllRead;
  window.deleteCurrentMail = deleteCurrentMail;
  window.junkMail = junkMail;
  window.emptyTrash = emptyTrash;
  window.replyMail = replyMail;
  window.forwardMail = forwardMail;
  window.printSmtpLog = printSmtpLog;
  window.removeAttachment = removeAttachment;
  window.toggleSched = toggleSched;
  window.scheduleMail = scheduleMail;
  window.openSched = openSched;
  window.closeSched = closeSched;
  window.cancelScheduled = cancelScheduled;
  window.openBlacklist = openBlacklist;
  window.closeBlacklist = closeBlacklist;
  window.addBlacklistAddress = addBlacklistAddress;
  window.removeBlacklistAddress = removeBlacklistAddress;
  window.blacklistFromMail = blacklistFromMail;
  window.openAddressBook = openAddressBook;
  window.closeAddressBook = closeAddressBook;
  window.useContact = useContact;
  window.openAdmin = openAdmin;
  window.closeAdmin = closeAdmin;
  window.saveMailConfig = saveMailConfig;
  window.createAccount = createAccount;
  window.resetOnePwd = resetOnePwd;
  window.delAccount = delAccount;
  window.resetAllPwd = resetAllPwd;
  window.viewAccount = viewAccount;
  window.switchAdminTab = switchAdminTab;
  window.doSearch = doSearch;
  window.debounce = debounce;

  // ========== 启动 ==========
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
