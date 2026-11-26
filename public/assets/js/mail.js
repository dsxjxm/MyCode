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

  // ========== 初始化 ==========
  async function init() {
    try {
      const u = await fetch('/api/auth/me').then(r => r.json()).catch(() => null);
      if (!u || !u.user) { window.location.href = '/login.html'; return; }
      state.user = u.user;
      state.role = u.user.role;

      // UI 填充
      document.getElementById('roleTag').textContent = state.role === 'teacher' ? '👨‍🏫 教师' : '👨‍🎓 学生';
      document.getElementById('userInfo').textContent = `${state.user.name}（${state.user.username}）`;
      if (state.role === 'teacher') document.body.classList.add('is-teacher');

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
      ? `<div class="attachments"><h4>📎 附件（${mail.attachments.length}）</h4>${mail.attachments.map(a => `<div class="att-item">📄 ${a.name || '附件'}</div>`).join('')}</div>`
      : '';
    const smtpHtml = Array.isArray(mail.smtp_log) && mail.smtp_log.length > 0
      ? `<div class="proto-panel">
          <div class="proto-header">
            <span class="title">🔐 SMTP 协议交互日志</span>
            <button onclick="this.parentElement.parentElement.style.display='none'">关闭</button>
          </div>
          <div class="proto-content">
            ${mail.smtp_log.map(l => {
              const txt = l.text === null ? '<span class="null-data">(空行)</span>' : l.text.replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>').replace(/\r/g,'');
              return `<div class="line ${l.dir === 'C' ? 'client' : 'server'}"><span class="ts">[${new Date(l.ts).toLocaleTimeString('zh-CN')}]</span>${l.dir === 'C' ? '→ C:' : '← S:'} ${txt}</div>`;
            }).join('')}
          </div>
        </div>`
      : '';
    el.innerHTML = `
      <div class="detail-header">
        <div class="subject">${mail.subject || '(无主题)'}</div>
        <div class="meta">
          <span class="sender">${mail.sender_name || mail.sender_address}</span>
          <span>—</span>
          <span>${mail.sender_address}</span>
          <span style="margin-left:auto;color:#aaa;">${fmtTime(mail.created_at)}</span>
        </div>
        <div class="meta" style="color:#888;">
          <span>收件人: ${mail.recipient_address}</span>
          ${mail.cc_addresses && mail.cc_addresses !== '[]' ? `<span>抄送: ${mail.cc_addresses}</span>` : ''}
        </div>
      </div>
      <div class="detail-actions">
        <button onclick="replyMail()">↩️ 回复</button>
        <button onclick="forwardMail()">➡️ 转发</button>
        <button onclick="deleteCurrentMail()">🗑️ 删除</button>
        <button onclick="junkMail()" id="junkBtn">⚠️ 标记垃圾</button>
        <button onclick="printSmtpLog()">📋 复制 SMTP 日志</button>
      </div>
      <div class="detail-body">${mail.body || '(空正文)'}</div>
      ${atts}
      ${smtpHtml}
    `;
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
    document.getElementById('bodyInput').value = '\n\n-----\n' + (cur.body || '');
  }

  function forwardMail() {
    const cur = state.mails.find(x => x.mailbox_id === state.currentMailId);
    if (!cur) return;
    openCompose();
    document.getElementById('subjectInput').value = 'Fwd: ' + (cur.subject || '');
    document.getElementById('bodyInput').value = '\n\n-----\n' + (cur.body || '');
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
    ['toInput', 'ccInput', 'subjectInput', 'bodyInput'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('composeModal').classList.add('show');
    setTimeout(() => document.getElementById('toInput').focus(), 100);
    setupRecipientAutocomplete();
  }
  function closeCompose() { document.getElementById('composeModal').classList.remove('show'); }

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

  async function sendMail() {
    const to = document.getElementById('toInput').value.trim();
    const cc = document.getElementById('ccInput').value.trim();
    const subject = document.getElementById('subjectInput').value.trim();
    const body = document.getElementById('bodyInput').value;
    if (!to) { toast('请填写收件人', 'error'); return; }
    if (!subject && !body) { toast('主题和正文不能都为空', 'error'); if (!subject) document.getElementById('subjectInput').focus(); return; }

    const payload = {
      to: to.split(/[,\s;]+/).filter(Boolean),
      cc: cc ? cc.split(/[,\s;]+/).filter(Boolean) : [],
      subject, body
    };
    const qs = state.role === 'teacher' && state.mailAccount ? `?account_id=${state.mailAccount.id}` : '';

    try {
      // 先演示一段 SMTP 命令在 toast 中
      toast('📤 正在发送（SMTP 握手中...）', 'success', 1500);
      const res = await api('POST', '/send' + qs, payload);
      // 展示完整 SMTP 日志（在 toast 中显示摘要）
      const sentCount = res.delivered_to;
      const rejected = res.rejected || [];
      closeCompose();
      toast(`✅ 发送成功！送达 ${sentCount} 封${rejected.length ? `，${rejected.length} 封被拒绝` : ''}`, 'success', 3500);
      await refreshAll();
      // 切换到发件箱
      await switchFolder('sent');
      // 显示最后一封邮件的 SMTP 日志
      if (state.mails.length > 0) viewMail(state.mails[0].mailbox_id);
    } catch (e) {
      toast('❌ ' + e.message, 'error', 4000);
      // 尝试从错误响应里取 smtp_log
      try {
        const lastError = document.querySelector('.proto-panel');
        if (lastError) lastError.remove();
      } catch {}
    }
  }

  async function saveDraft() {
    const to = document.getElementById('toInput').value.trim();
    const cc = document.getElementById('ccInput').value.trim();
    const subject = document.getElementById('subjectInput').value.trim();
    const body = document.getElementById('bodyInput').value;
    const qs = state.role === 'teacher' && state.mailAccount ? `?account_id=${state.mailAccount.id}` : '';
    try {
      await api('POST', '/drafts' + qs, { to, cc, subject, body });
      closeCompose();
      toast('💾 已保存到草稿箱', 'success');
      await refreshAll();
      await switchFolder('draft');
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
