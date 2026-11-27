import {
  api,
  bindLogout,
  confirmDialog,
  escapeHtml,
  formatSize,
  formatTime,
  guardRole,
  openDialog,
  promptDialog,
  toast
} from './common.js';

const state = {
  user: null,
  classes: [],
  students: [],
  classId: '',
  search: '',
  selected: new Set()
};

const el = {
  userName: document.getElementById('userName'),
  classTable: document.getElementById('classTable'),
  classEmpty: document.getElementById('classEmpty'),
  studentTable: document.getElementById('studentTable'),
  studentEmpty: document.getElementById('studentEmpty'),
  classFilter: document.getElementById('classFilter'),
  exportXlsx: document.getElementById('exportXlsx'),
  exportCsv: document.getElementById('exportCsv'),
  studentSearch: document.getElementById('studentSearch'),
  selectAll: document.getElementById('selectAll'),
  batchDeleteBtn: document.getElementById('batchDeleteBtn')
};

init();

async function init() {
  const user = await guardRole('teacher');
  if (!user) return;
  state.user = user;
  el.userName.textContent = `${user.name}（${user.username}）`;
  bindLogout(document.getElementById('logoutBtn'));
  bindNav();
  bindActions();
  await loadClasses();
  await loadStudents();
  await loadOverview();
  loadModuleSettings();
  const semesterInput = document.getElementById('archiveSemester');
  if (semesterInput && !semesterInput.value) semesterInput.value = defaultSemester();
}

// 模块设置：是否允许学生编辑网络配置
async function loadModuleSettings() {
  const box = document.getElementById('netStudentEdit');
  if (!box) return;
  try {
    const s = await api('/api/network/settings');
    box.checked = !!s.student_can_edit_network;
  } catch (_) { /* 忽略 */ }
  box.addEventListener('change', async () => {
    try {
      await api('/api/network/settings', {
        method: 'PUT',
        body: { student_can_edit_network: box.checked }
      });
      toast(box.checked ? '已允许学生编辑网络配置' : '已禁止学生编辑网络配置', 'success');
    } catch (err) {
      box.checked = !box.checked;
      toast(err.message || '保存失败', 'error');
    }
  });
}

function bindNav() {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      document.querySelectorAll('.nav-item').forEach((item) => item.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.view').forEach((item) => item.classList.remove('active'));
      document.getElementById(`view-${view}`).classList.add('active');
      if (view !== 'monitor') stopMonitor();
      if (view === 'students') loadStudents();
      if (view === 'overview') loadOverview();
      if (view === 'monitor') startMonitor();
      if (view === 'archive') loadArchives();
    });
  });
}

// ==================== 运行监控 ====================
const monitor = { timer: null, running: false, loading: false };

function startMonitor() {
  if (monitor.running) return;
  monitor.running = true;
  const toggle = document.getElementById('monitorToggleBtn');
  if (toggle) toggle.textContent = '暂停刷新';
  loadMonitor();
  monitor.timer = setInterval(loadMonitor, 3000);
}

function stopMonitor() {
  if (monitor.timer) clearInterval(monitor.timer);
  monitor.timer = null;
  monitor.running = false;
  const toggle = document.getElementById('monitorToggleBtn');
  if (toggle) toggle.textContent = '恢复刷新';
}

async function loadMonitor() {
  if (monitor.loading) return;
  monitor.loading = true;
  try {
    const data = await api('/api/admin/metrics');
    renderMonitor(data);
  } catch (err) {
    const updated = document.getElementById('monitorUpdated');
    if (updated) updated.textContent = `刷新失败：${err.message}`;
  } finally {
    monitor.loading = false;
  }
}

function formatDuration(sec) {
  const total = Math.max(0, Math.floor(sec || 0));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const mi = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}天 ${h}小时`;
  if (h > 0) return `${h}小时 ${mi}分`;
  if (mi > 0) return `${mi}分 ${s}秒`;
  return `${s}秒`;
}

function renderMonitor(m) {
  const set = (id, text) => {
    const node = document.getElementById(id);
    if (node) node.textContent = text;
  };
  const online = m.online || {};
  const traffic = m.traffic || {};
  const sys = m.system || {};
  const login = m.login || {};

  set('monOnline', String(online.total || 0));
  set('monOnlineSub', `教师 ${online.teachers || 0} · 学生 ${online.students || 0}`);
  set('monRps', String(traffic.rps || 0));
  set('monP95', `${traffic.p95 || 0} ms`);
  set('monLatencySub', `平均 ${traffic.avg || 0} ms · P99 ${traffic.p99 || 0} ms`);
  set('monCpu', `${sys.cpuPercent || 0}%`);
  set('monCpuSub', `${sys.cpuCount || 0} 核`);
  set('monLoad', Number(sys.load1 || 0).toFixed(2));
  set('monLoadSub', `5m ${Number(sys.load5 || 0).toFixed(2)} · 15m ${Number(sys.load15 || 0).toFixed(2)}`);
  set('monMem', formatSize(sys.memRss || 0));
  set('monMemSub', `堆 ${formatSize(sys.memHeapUsed || 0)} · 系统空闲 ${formatSize(sys.memFree || 0)}`);
  set('monErrors', String(traffic.errorRequests || 0));
  set('monTotalSub', `累计 ${traffic.totalRequests || 0} 次请求`);
  set('monQueue', String(login.queued || 0));
  set('monQueueSub', `并发上限 ${login.maxConcurrent || 0} · 累计限流 ${login.throttled || 0} 次`);
  set('monUptime', formatDuration(m.uptimeSec || 0));
  set('monUptimeSub', m.serverTime ? `更新于 ${formatTime(m.serverTime)}` : '');
  set('monDbSize', formatSize((m.db && m.db.sizeBytes) || 0));
  set('monitorUpdated', m.serverTime ? `更新于 ${formatTime(m.serverTime)}` : '—');

  const onlineList = online.list || [];
  const onlineBody = document.getElementById('onlineTable');
  if (onlineBody) {
    onlineBody.innerHTML = onlineList
      .map(
        (u) => `
        <tr>
          <td><b>${escapeHtml(u.name)}</b></td>
          <td>${u.role === 'teacher' ? '教师' : '学生'}</td>
          <td class="mono">${escapeHtml(u.username)}</td>
          <td class="muted">${formatTime(u.lastSeen)}</td>
          <td class="mono">${escapeHtml(u.ip || '')}</td>
        </tr>`
      )
      .join('');
  }
  const onlineEmpty = document.getElementById('onlineEmpty');
  if (onlineEmpty) onlineEmpty.hidden = onlineList.length > 0;
  const onlineMeta = document.getElementById('onlineMeta');
  if (onlineMeta) onlineMeta.textContent = `近 ${online.windowSec || 180} 秒内有活动`;

  const slowItems = (m.slow && m.slow.items) || [];
  const slowBody = document.getElementById('slowTable');
  if (slowBody) {
    slowBody.innerHTML = slowItems
      .map(
        (s) => `
        <tr>
          <td class="muted mono">${formatTime(s.at)}</td>
          <td class="mono">${escapeHtml(s.method)} ${escapeHtml(s.path)}</td>
          <td><b>${s.ms} ms</b></td>
          <td>${s.status}</td>
          <td class="muted">${escapeHtml(s.user)}</td>
        </tr>`
      )
      .join('');
  }
  const slowEmpty = document.getElementById('slowEmpty');
  if (slowEmpty) slowEmpty.hidden = slowItems.length > 0;
  const slowMeta = document.getElementById('slowMeta');
  if (slowMeta) slowMeta.textContent = `最近 ${slowItems.length} 条 · ≥ ${(m.slow && m.slow.thresholdMs) || 500} ms`;

  // 环境自检与自动配置
  const env = m.env || {};
  const envGrid = document.getElementById('envGrid');
  if (envGrid && env.tier) {
    const items = [
      ['性能档位', `${env.label}（${env.tier}）`],
      ['CPU 型号', env.cpuModel || '—'],
      ['CPU 核心', `${env.cpuCores || 0} 核`],
      ['内存', `总 ${env.totalMemGB || 0} GB · 空闲 ${env.freeMemGB || 0} GB`],
      ['scrypt 基准', `${env.scryptMs || 0} ms / 次`],
      ['登录并发上限', `${env.loginConcurrency || 0}（已生效）`],
      ['线程池大小', String(env.uvThreadPoolSize || 0)],
      ['写盘防抖', `${env.persistDebounceMs || 0} ms`],
      ['慢请求阈值', `${env.slowThresholdMs || 0} ms`],
      ['建议压测并发', `${env.suggestedVus || 0} 路`],
      ['Node / 平台', `${env.nodeVersion || ''} · ${env.platform || ''}/${env.arch || ''}`]
    ];
    envGrid.innerHTML = items
      .map(
        ([k, v]) =>
          `<div class="env-item"><div class="env-k">${escapeHtml(k)}</div><div class="env-v">${escapeHtml(
            String(v)
          )}</div></div>`
      )
      .join('');
    const envMeta = document.getElementById('envMeta');
    if (envMeta) {
      envMeta.textContent = env.detectedAt
        ? `检测于 ${formatTime(env.detectedAt)} · 配置已自动生效`
        : '配置已自动生效';
    }
  }
}

// ==================== 学期归档 ====================
function defaultSemester() {
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  const startYear = month >= 9 ? year : year - 1;
  const term = month >= 9 || month <= 1 ? '第一学期' : '第二学期';
  return `${startYear}-${startYear + 1}学年${term}`;
}

async function loadArchives() {
  let data;
  try {
    data = await api('/api/admin/archives');
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  const archives = data.archives || [];
  const body = document.getElementById('archiveTable');
  if (body) {
    body.innerHTML = archives
      .map(
        (a) => `
        <tr>
          <td class="mono">${escapeHtml(a.name)}</td>
          <td>${formatSize(a.size)}</td>
          <td class="muted">${formatTime(a.createdAt)}</td>
          <td class="right">
            <a class="btn btn-ghost btn-sm" href="/api/admin/archives/${encodeURIComponent(a.name)}/download">下载</a>
            <button class="btn btn-danger-ghost btn-sm" data-archive-del="${escapeHtml(a.name)}" type="button">删除</button>
          </td>
        </tr>`
      )
      .join('');
  }
  const empty = document.getElementById('archiveEmpty');
  if (empty) empty.hidden = archives.length > 0;
  const meta = document.getElementById('archiveMeta');
  if (meta) meta.textContent = `${archives.length} 个`;
  const dir = document.getElementById('archiveDir');
  if (dir && data.dir) dir.textContent = `归档目录：${data.dir}`;
}

async function createArchive() {
  const semesterEl = document.getElementById('archiveSemester');
  const mailEl = document.getElementById('archiveCleanMail');
  const trashEl = document.getElementById('archiveCleanTrash');
  const btn = document.getElementById('createArchiveBtn');
  const semester = semesterEl ? semesterEl.value.trim() : '';
  const cleanupMail = !!(mailEl && mailEl.checked);
  const cleanupTrash = !!(trashEl && trashEl.checked);
  const extras = [cleanupMail ? '清理邮件' : '', cleanupTrash ? '清空回收站' : '']
    .filter(Boolean)
    .join('、');
  const ok = await confirmDialog({
    title: '确认归档',
    message: `将保存当前数据库快照${extras ? `，并${extras}` : ''}。清理后不可恢复（归档文件保留清理前数据），确定继续吗？`,
    okText: '开始归档',
    danger: cleanupMail || cleanupTrash
  });
  if (!ok) return;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '归档中…';
  }
  try {
    const result = await api('/api/admin/archives', {
      method: 'POST',
      body: { semester, cleanupMail, cleanupTrash }
    });
    const c = result.cleanup || {};
    const detail = [];
    if (cleanupMail) detail.push(`清理邮件 ${c.mailMessages || 0} 封`);
    if (cleanupTrash) detail.push(`清理回收站 ${c.trashEntries || 0} 项`);
    toast(
      `归档已创建：${result.archive.name}${detail.length ? `（${detail.join('，')}）` : ''}`,
      'success'
    );
    await loadArchives();
  } catch (err) {
    toast(err.message, 'error');
    await loadArchives();
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '立即归档';
    }
  }
}

async function deleteArchive(name) {
  const ok = await confirmDialog({
    title: '删除归档',
    message: `确定删除归档「${escapeHtml(name)}」吗？此操作不可恢复。`,
    okText: '删除',
    danger: true
  });
  if (!ok) return;
  try {
    await api(`/api/admin/archives/${encodeURIComponent(name)}`, { method: 'DELETE' });
    toast('归档已删除', 'success');
    await loadArchives();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function bindActions() {
  document.getElementById('addClassBtn').addEventListener('click', () => classDialog());
  el.classTable.querySelector('tbody').addEventListener('click', async (event) => {
    const btn = event.target.closest('button[data-act]');
    if (!btn) return;
    const cls = state.classes.find((item) => item.id === Number(btn.dataset.id));
    if (!cls) return;
    if (btn.dataset.act === 'edit-class') classDialog(cls);
    if (btn.dataset.act === 'del-class') deleteClass(cls);
  });

  el.classFilter.addEventListener('change', () => {
    state.classId = el.classFilter.value;
    updateExportLinks();
    loadStudents();
  });

  document.getElementById('addStudentBtn').addEventListener('click', () => studentDialog());
  document.getElementById('importBtn').addEventListener('click', importDialog);
  document.getElementById('changePwdBtn').addEventListener('click', changePasswordDialog);
  el.batchDeleteBtn.addEventListener('click', batchDeleteStudents);
  document.getElementById('refreshOverviewBtn').addEventListener('click', loadOverview);
  document.getElementById('sendNoticeBtn').addEventListener('click', sendNotice);
  document.getElementById('noticeList').addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-notice-del]');
    if (!btn) return;
    const ok = await confirmDialog({
      title: '删除通知',
      message: '确定删除这条通知吗？学生工作台将不再显示。',
      okText: '删除',
      danger: true
    });
    if (!ok) return;
    try {
      await api(`/api/notices/${btn.dataset.noticeDel}`, { method: 'DELETE' });
      toast('通知已删除', 'success');
      await loadOverview();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  el.studentSearch.addEventListener('input', () => {
    state.search = el.studentSearch.value;
    renderStudents();
  });

  el.selectAll.addEventListener('change', () => {
    const visible = visibleStudents();
    if (el.selectAll.checked) visible.forEach((student) => state.selected.add(student.id));
    else visible.forEach((student) => state.selected.delete(student.id));
    renderStudents();
  });

  el.studentTable.querySelector('tbody').addEventListener('change', (event) => {
    const checkbox = event.target.closest('.row-check');
    if (!checkbox) return;
    const id = Number(checkbox.dataset.id);
    if (checkbox.checked) state.selected.add(id);
    else state.selected.delete(id);
    updateBatchBar();
  });

  el.studentTable.querySelector('tbody').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-act]');
    if (!btn) return;
    const student = state.students.find((item) => item.id === Number(btn.dataset.id));
    if (!student) return;
    const act = btn.dataset.act;
    if (act === 'edit-student') studentDialog(student);
    if (act === 'reset-pwd') resetPassword(student);
    if (act === 'space') spaceDialog(student);
    if (act === 'ftp-space') ftpSpaceDialog(student);
    if (act === 'del-student') deleteStudent(student);
  });

  document.getElementById('monitorToggleBtn').addEventListener('click', () => {
    if (monitor.running) stopMonitor();
    else startMonitor();
  });
  document.getElementById('monitorRefreshBtn').addEventListener('click', loadMonitor);
  document.getElementById('archiveRefreshBtn').addEventListener('click', loadArchives);
  document.getElementById('createArchiveBtn').addEventListener('click', createArchive);
  document.getElementById('archiveTable').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-archive-del]');
    if (!btn) return;
    deleteArchive(btn.dataset.archiveDel);
  });
}

async function loadClasses() {
  const { classes } = await api('/api/classes');
  state.classes = classes;
  renderClasses();
  renderClassFilter();
  updateExportLinks();
}

function renderClasses() {
  const tbody = el.classTable.querySelector('tbody');
  el.classEmpty.hidden = state.classes.length > 0;
  tbody.innerHTML = state.classes
    .map(
      (cls) => `
      <tr>
        <td><b>${escapeHtml(cls.name)}</b></td>
        <td>${escapeHtml(cls.grade) || '—'}</td>
        <td class="muted">${escapeHtml(cls.description) || '—'}</td>
        <td>${cls.student_count}</td>
        <td class="muted">${formatTime(cls.created_at)}</td>
        <td class="right">
          <button class="btn btn-ghost btn-sm" data-act="edit-class" data-id="${cls.id}" type="button">编辑</button>
          <button class="btn btn-danger-ghost btn-sm" data-act="del-class" data-id="${cls.id}" type="button">删除</button>
        </td>
      </tr>`
    )
    .join('');
}

function renderClassFilter() {
  const current = state.classId;
  el.classFilter.innerHTML =
    `<option value="">全部班级</option>` +
    state.classes
      .map((cls) => `<option value="${cls.id}">${escapeHtml(cls.name)}</option>`)
      .join('');
  if (current && state.classes.some((cls) => String(cls.id) === String(current))) {
    el.classFilter.value = current;
  } else {
    state.classId = '';
    el.classFilter.value = '';
  }
  renderNoticeScope();
}

function renderNoticeScope() {
  const select = document.getElementById('noticeScope');
  if (!select) return;
  const current = select.value;
  select.innerHTML =
    '<option value="">全体学生</option>' +
    state.classes
      .map((cls) => `<option value="${cls.id}">${escapeHtml(cls.name)}</option>`)
      .join('');
  if (current && state.classes.some((cls) => String(cls.id) === String(current))) {
    select.value = current;
  }
}

async function loadOverview() {
  try {
    const { stats } = await api('/api/notices/stats');
    document.getElementById('stClasses').textContent = stats.classes;
    document.getElementById('stStudents').textContent = stats.students;
    document.getElementById('stSites').textContent = stats.sites;
    document.getElementById('stTodayNew').textContent = stats.today_new;
    document.getElementById('stDisabled').textContent = stats.disabled;
    document.getElementById('stNotices').textContent = stats.notices;
  } catch (err) {
    toast(err.message, 'error');
  }
  await loadNotices();
}

async function loadNotices() {
  try {
    const { notices } = await api('/api/notices');
    const list = document.getElementById('noticeList');
    if (!notices.length) {
      list.innerHTML = '<div class="empty">还没有发布通知</div>';
      return;
    }
    list.innerHTML = notices
      .map(
        (notice) => `
        <div class="notice-item">
          <div class="notice-item-head">
            <b>${escapeHtml(notice.title)}</b>
            <span class="chip ${notice.class_id ? 'chip-off' : 'chip-ok'}">${notice.class_id ? escapeHtml(notice.class_name || '班级') : '全体学生'}</span>
            <span class="muted small">${formatTime(notice.created_at)}</span>
            <button class="btn btn-danger-ghost btn-sm" data-notice-del="${notice.id}" type="button">删除</button>
          </div>
          <p>${escapeHtml(notice.content)}</p>
        </div>`
      )
      .join('');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function sendNotice() {
  const title = document.getElementById('noticeTitle').value.trim();
  const content = document.getElementById('noticeContent').value.trim();
  const classId = document.getElementById('noticeScope').value;
  if (!title || !content) {
    toast('请填写通知标题和内容', 'error');
    return;
  }
  const button = document.getElementById('sendNoticeBtn');
  button.disabled = true;
  try {
    await api('/api/notices', {
      method: 'POST',
      body: { title, content, classId: classId || null }
    });
    document.getElementById('noticeTitle').value = '';
    document.getElementById('noticeContent').value = '';
    toast('通知已发布', 'success');
    await loadOverview();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function updateExportLinks() {
  const suffix = state.classId ? `&classId=${state.classId}` : '';
  el.exportXlsx.href = `/api/students/export?format=xlsx${suffix}`;
  el.exportCsv.href = `/api/students/export?format=csv${suffix}`;
}

function classDialog(cls = null) {
  const isEdit = Boolean(cls);
  const body = `
    <label class="field"><span>班级名称 *</span>
      <input class="input" id="clsName" value="${escapeHtml(cls?.name || '')}" placeholder="例如：计算机应用 25-1 班">
    </label>
    <label class="field"><span>年级</span>
      <input class="input" id="clsGrade" value="${escapeHtml(cls?.grade || '')}" placeholder="例如：2025级">
    </label>
    <label class="field"><span>说明</span>
      <input class="input" id="clsDesc" value="${escapeHtml(cls?.description || '')}" placeholder="可选">
    </label>
    <p class="hint">保存后会自动在数据目录下创建对应班级文件夹。</p>`;

  openDialog({
    title: isEdit ? '编辑班级' : '新增班级',
    body,
    width: 480,
    buttons: [
      { text: '取消', variant: 'ghost' },
      {
        text: '保存',
        variant: 'primary',
        onClick: async (dialog) => {
          const payload = {
            name: dialog.querySelector('#clsName').value.trim(),
            grade: dialog.querySelector('#clsGrade').value.trim(),
            description: dialog.querySelector('#clsDesc').value.trim()
          };
          if (!payload.name) {
            toast('请输入班级名称', 'error');
            return false;
          }
          try {
            if (isEdit) await api(`/api/classes/${cls.id}`, { method: 'PUT', body: payload });
            else await api('/api/classes', { method: 'POST', body: payload });
            toast(isEdit ? '班级已更新' : '班级已创建', 'success');
            await loadClasses();
            await loadStudents();
            return true;
          } catch (err) {
            toast(err.message, 'error');
            return false;
          }
        }
      }
    ],
    onMount: (dialog) => dialog.querySelector('#clsName').focus()
  });
}

async function deleteClass(cls) {
  const ok = await confirmDialog({
    title: '删除班级',
    message: `确定删除班级「${escapeHtml(cls.name)}」吗？该班级的学生账号将被一并删除，学生空间会移入回收站。`,
    okText: '删除',
    danger: true
  });
  if (!ok) return;
  try {
    await api(`/api/classes/${cls.id}`, { method: 'DELETE' });
    toast('班级已删除', 'success');
  } catch (err) {
    if (err.status === 409 && err.data?.needConfirm) {
      const again = await confirmDialog({
        title: '再次确认',
        message: `${escapeHtml(err.data.error)}。确认继续删除吗？`,
        okText: '确认删除',
        danger: true
      });
      if (!again) return;
      try {
        await api(`/api/classes/${cls.id}?force=1`, { method: 'DELETE' });
        toast('班级已删除', 'success');
      } catch (inner) {
        toast(inner.message, 'error');
        return;
      }
    } else {
      toast(err.message, 'error');
      return;
    }
  }
  if (String(state.classId) === String(cls.id)) state.classId = '';
  await loadClasses();
  await loadStudents();
}

async function loadStudents() {
  const query = state.classId ? `?classId=${state.classId}` : '';
  try {
    const { students } = await api(`/api/students${query}`);
    state.students = students;
    state.selected.clear();
    renderStudents();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function visibleStudents() {
  const keyword = state.search.trim().toLowerCase();
  if (!keyword) return state.students;
  return state.students.filter(
    (student) =>
      student.student_no.toLowerCase().includes(keyword) ||
      student.name.toLowerCase().includes(keyword) ||
      student.username.toLowerCase().includes(keyword)
  );
}

function renderStudents() {
  const tbody = el.studentTable.querySelector('tbody');
  const students = visibleStudents();
  el.studentEmpty.hidden = students.length > 0;
  el.studentEmpty.textContent = state.search ? '没有匹配的学生' : '该班级暂无学生。';
  tbody.innerHTML = students
    .map(
      (student) => `
      <tr>
        <td class="check-col"><input type="checkbox" class="row-check" data-id="${student.id}" ${state.selected.has(student.id) ? 'checked' : ''}></td>
        <td>${escapeHtml(student.student_no)}</td>
        <td><b>${escapeHtml(student.name)}</b></td>
        <td><code>${escapeHtml(student.username)}</code></td>
        <td><span class="chip ${student.status === 'active' ? 'chip-ok' : 'chip-off'}">${student.status === 'active' ? '正常' : '停用'}</span></td>
        <td class="muted">${escapeHtml(student.folder)}</td>
        <td class="right">
          <button class="btn btn-ghost btn-sm" data-act="space" data-id="${student.id}" type="button">站点空间</button>
          <button class="btn btn-ghost btn-sm" data-act="ftp-space" data-id="${student.id}" type="button">FTP 空间</button>
          <button class="btn btn-ghost btn-sm" data-act="edit-student" data-id="${student.id}" type="button">编辑</button>
          <button class="btn btn-ghost btn-sm" data-act="reset-pwd" data-id="${student.id}" type="button">重置密码</button>
          <button class="btn btn-danger-ghost btn-sm" data-act="del-student" data-id="${student.id}" type="button">删除</button>
        </td>
      </tr>`
    )
    .join('');
  const allSelected = students.length > 0 && students.every((student) => state.selected.has(student.id));
  el.selectAll.checked = allSelected;
  el.selectAll.indeterminate = !allSelected && students.some((student) => state.selected.has(student.id));
  updateBatchBar();
}

function updateBatchBar() {
  const count = state.selected.size;
  el.batchDeleteBtn.disabled = count === 0;
  el.batchDeleteBtn.textContent = count ? `批量删除 (${count})` : '批量删除';
}

async function batchDeleteStudents() {
  const ids = [...state.selected];
  if (!ids.length) return;
  const ok = await confirmDialog({
    title: '批量删除学生',
    message: `确定删除选中的 ${ids.length} 名学生吗？账号将被删除，其空间文件夹会移入回收站。`,
    okText: `删除 ${ids.length} 人`,
    danger: true
  });
  if (!ok) return;
  let failed = 0;
  for (const id of ids) {
    try {
      await api(`/api/students/${id}`, { method: 'DELETE' });
      state.selected.delete(id);
    } catch {
      failed += 1;
    }
  }
  toast(failed ? `删除完成，${failed} 名学生删除失败` : `已删除 ${ids.length} 名学生`, failed ? 'error' : 'success');
  await loadStudents();
  await loadClasses();
}

function changePasswordDialog() {
  const body = `
    <label class="field"><span>原密码</span>
      <input class="input" type="password" id="pwdOld" autocomplete="current-password">
    </label>
    <label class="field"><span>新密码（至少 6 位）</span>
      <input class="input" type="password" id="pwdNew" autocomplete="new-password">
    </label>
    <label class="field"><span>确认新密码</span>
      <input class="input" type="password" id="pwdConfirm" autocomplete="new-password">
    </label>
    <p class="hint">修改后请牢记新密码，下次登录使用新密码。</p>`;
  openDialog({
    title: '修改教师密码',
    body,
    width: 440,
    buttons: [
      { text: '取消', variant: 'ghost' },
      {
        text: '保存',
        variant: 'primary',
        onClick: async (dialog) => {
          const oldPassword = dialog.querySelector('#pwdOld').value;
          const newPassword = dialog.querySelector('#pwdNew').value;
          const confirm = dialog.querySelector('#pwdConfirm').value;
          if (newPassword.length < 6) {
            toast('新密码至少 6 位', 'error');
            return false;
          }
          if (newPassword !== confirm) {
            toast('两次输入的新密码不一致', 'error');
            return false;
          }
          try {
            await api('/api/auth/password', { method: 'POST', body: { oldPassword, newPassword } });
            toast('密码已修改，请使用新密码登录', 'success');
            return true;
          } catch (err) {
            toast(err.message, 'error');
            return false;
          }
        }
      }
    ],
    onMount: (dialog) => dialog.querySelector('#pwdOld').focus()
  });
}

function studentDialog(student = null) {
  const isEdit = Boolean(student);
  if (!state.classes.length) {
    toast('请先创建班级', 'error');
    return;
  }
  const classOptions = state.classes
    .map(
      (cls) =>
        `<option value="${cls.id}" ${String(cls.id) === String(student?.class_id ?? state.classId) ? 'selected' : ''}>${escapeHtml(cls.name)}</option>`
    )
    .join('');
  const body = `
    <label class="field"><span>所属班级 *</span>
      <select class="input" id="stuClass" ${isEdit ? 'disabled' : ''}>${classOptions}</select>
    </label>
    <div class="grid-2">
      <label class="field"><span>学号 *</span>
        <input class="input" id="stuNo" value="${escapeHtml(student?.student_no || '')}" placeholder="例如 20250101">
      </label>
      <label class="field"><span>姓名 *</span>
        <input class="input" id="stuName" value="${escapeHtml(student?.name || '')}" placeholder="例如 张三">
      </label>
    </div>
    <div class="grid-2">
      <label class="field"><span>登录账号</span>
        <input class="input" id="stuUser" value="${escapeHtml(student?.username || '')}" placeholder="留空则使用学号">
      </label>
      <label class="field"><span>${isEdit ? '状态' : '初始密码'}</span>
        ${
          isEdit
            ? `<select class="input" id="stuStatus">
                 <option value="active" ${student.status === 'active' ? 'selected' : ''}>正常</option>
                 <option value="disabled" ${student.status === 'disabled' ? 'selected' : ''}>停用</option>
               </select>`
            : `<input class="input" id="stuPwd" value="123456" placeholder="默认 123456">`
        }
      </label>
    </div>
    <p class="hint">${isEdit ? '学号、姓名变更不会重命名已有空间文件夹，避免文件丢失。' : '创建后会自动生成 www / ftp / homework / design 四个子目录。'}</p>`;

  openDialog({
    title: isEdit ? '编辑学生' : '新增学生',
    body,
    width: 560,
    buttons: [
      { text: '取消', variant: 'ghost' },
      {
        text: '保存',
        variant: 'primary',
        onClick: async (dialog) => {
          const studentNo = dialog.querySelector('#stuNo').value.trim();
          const name = dialog.querySelector('#stuName').value.trim();
          const username = dialog.querySelector('#stuUser').value.trim() || studentNo;
          if (!studentNo || !name) {
            toast('学号和姓名不能为空', 'error');
            return false;
          }
          try {
            if (isEdit) {
              await api(`/api/students/${student.id}`, {
                method: 'PUT',
                body: {
                  studentNo,
                  name,
                  username,
                  status: dialog.querySelector('#stuStatus').value
                }
              });
              toast('学生信息已更新', 'success');
            } else {
              await api('/api/students', {
                method: 'POST',
                body: {
                  classId: Number(dialog.querySelector('#stuClass').value),
                  studentNo,
                  name,
                  username,
                  password: dialog.querySelector('#stuPwd').value.trim() || '123456'
                }
              });
              toast('学生已创建，空间目录已生成', 'success');
            }
            await loadStudents();
            await loadClasses();
            return true;
          } catch (err) {
            toast(err.message, 'error');
            return false;
          }
        }
      }
    ],
    onMount: (dialog) => dialog.querySelector('#stuNo').focus()
  });
}

async function resetPassword(student) {
  const password = await promptDialog({
    title: '重置密码',
    label: `为「${student.name}」设置新密码`,
    value: '123456',
    okText: '重置'
  });
  if (!password) return;
  try {
    await api(`/api/students/${student.id}/reset-password`, {
      method: 'POST',
      body: { password }
    });
    toast(`密码已重置为 ${password}`, 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteStudent(student) {
  const ok = await confirmDialog({
    title: '删除学生',
    message: `确定删除学生「${escapeHtml(student.name)}」吗？账号将被删除，其空间文件夹会移入回收站。`,
    okText: '删除',
    danger: true
  });
  if (!ok) return;
  try {
    await api(`/api/students/${student.id}`, { method: 'DELETE' });
    toast('学生已删除', 'success');
    await loadStudents();
    await loadClasses();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function spaceDialog(student) {
  const dlg = openDialog({
    title: `${student.name} 的站点空间`,
    body: '<div class="loading">正在加载空间文件…</div>',
    width: 820
  });
  try {
    const [{ files, spacePath }, { url }] = await Promise.all([
      api(`/api/students/${student.id}/files`),
      api(`/api/students/${student.id}/preview-token`)
    ]);
    const fileRows = files
      .filter((file) => file.type === 'file')
      .map((file) => {
        const depth = file.path.split('/').length - 1;
        return `
          <div class="space-file" data-path="${escapeHtml(file.path)}" style="padding-left:${12 + depth * 16}px">
            <span class="space-file-name">${escapeHtml(file.name)}</span>
            <span class="space-file-size">${formatSize(file.size)}</span>
            <a class="space-file-dl" href="/api/students/${student.id}/file?path=${encodeURIComponent(file.path)}&download=1">下载</a>
          </div>`;
      })
      .join('');
    dlg.body.innerHTML = `
      <div class="space-head">
        <span class="badge">www</span>
        <code>${escapeHtml(spacePath)}/www</code>
        <div class="space-actions">
          <a class="btn btn-ghost btn-sm" href="/api/students/${student.id}/download-zip">打包下载</a>
          <a class="btn btn-primary btn-sm" href="${url}" target="_blank" rel="noopener">打开站点预览</a>
        </div>
      </div>
      <div class="space-layout">
        <div class="space-list">${fileRows || '<div class="empty">暂无文件</div>'}</div>
        <div class="space-preview"><pre id="spacePreview">点击左侧文件查看内容</pre></div>
      </div>`;
    const preview = dlg.body.querySelector('#spacePreview');
    dlg.body.querySelectorAll('.space-file').forEach((row) => {
      row.addEventListener('click', async () => {
        preview.textContent = '加载中…';
        try {
          const data = await api(
            `/api/students/${student.id}/file?path=${encodeURIComponent(row.dataset.path)}`
          );
          preview.textContent = data.content;
        } catch (err) {
          preview.textContent = `无法预览：${err.message}`;
        }
      });
    });
  } catch (err) {
    dlg.body.innerHTML = `<p class="dialog-text">加载失败：${escapeHtml(err.message)}</p>`;
  }
}

async function ftpSpaceDialog(student) {
  const dlg = openDialog({
    title: `${student.name} 的 FTP 空间`,
    body: '<div class="loading">正在加载空间文件…</div>',
    width: 820
  });
  try {
    const { files, spacePath } = await api(`/api/students/${student.id}/ftp/files`);
    const fileRows = files
      .filter((file) => file.type === 'file')
      .map((file) => {
        const depth = file.path.split('/').length - 1;
        return `
          <div class="space-file" data-path="${escapeHtml(file.path)}" style="padding-left:${12 + depth * 16}px">
            <span class="space-file-name">${escapeHtml(file.name)}</span>
            <span class="space-file-size">${formatSize(file.size)}</span>
            <a class="space-file-dl" href="/api/students/${student.id}/ftp/file?path=${encodeURIComponent(file.path)}&download=1">下载</a>
          </div>`;
      })
      .join('');
    dlg.body.innerHTML = `
      <div class="space-head">
        <span class="badge">ftp</span>
        <code>${escapeHtml(spacePath)}/ftp</code>
        <div class="space-actions">
          <a class="btn btn-ghost btn-sm" href="/api/students/${student.id}/ftp/download-zip">打包下载</a>
        </div>
      </div>
      <div class="space-layout">
        <div class="space-list">${fileRows || '<div class="empty">暂无文件</div>'}</div>
        <div class="space-preview"><pre id="ftpSpacePreview">点击左侧文件查看内容</pre></div>
      </div>`;
    const preview = dlg.body.querySelector('#ftpSpacePreview');
    dlg.body.querySelectorAll('.space-file').forEach((row) => {
      row.addEventListener('click', async () => {
        preview.textContent = '加载中…';
        try {
          const data = await api(
            `/api/students/${student.id}/ftp/file?path=${encodeURIComponent(row.dataset.path)}`
          );
          preview.textContent = data.content;
        } catch (err) {
          preview.textContent = `无法预览：${err.message}`;
        }
      });
    });
  } catch (err) {
    dlg.body.innerHTML = `<p class="dialog-text">加载失败：${escapeHtml(err.message)}</p>`;
  }
}

function importDialog() {
  if (!state.classes.length) {
    toast('请先创建班级', 'error');
    return;
  }
  const options = state.classes
    .map(
      (cls) =>
        `<option value="${cls.id}" ${String(cls.id) === String(state.classId) ? 'selected' : ''}>${escapeHtml(cls.name)}</option>`
    )
    .join('');
  const body = document.createElement('div');
  body.innerHTML = `
    <label class="field"><span>导入到班级 *</span>
      <select class="input" id="imClass">${options}</select>
    </label>
    <label class="field"><span>名单文件（.xlsx / .xls / .csv）*</span>
      <input class="input" id="imFile" type="file" accept=".xlsx,.xls,.csv">
    </label>
    <label class="field"><span>初始密码（文件中未填密码时使用）</span>
      <input class="input" id="imPwd" value="123456">
    </label>
    <div class="import-hint">表头需包含“学号”“姓名”，“账号”“密码”可选。可先<a href="/api/students/template?format=xlsx">下载模板</a>。</div>
    <div class="import-result" id="imResult" hidden></div>`;

  openDialog({
    title: '导入学生名单',
    body,
    width: 580,
    buttons: [
      {
        text: '开始导入',
        variant: 'primary',
        onClick: async (dialog) => {
          await doImport(dialog);
          return false;
        }
      },
      { text: '关闭', variant: 'ghost' }
    ]
  });
}

async function doImport(dialog) {
  const fileInput = dialog.querySelector('#imFile');
  const resultBox = dialog.querySelector('#imResult');
  const classId = dialog.querySelector('#imClass').value;
  const defaultPassword = dialog.querySelector('#imPwd').value.trim() || '123456';
  const file = fileInput.files?.[0];
  if (!file) {
    toast('请选择名单文件', 'error');
    return;
  }
  const form = new FormData();
  form.append('classId', classId);
  form.append('defaultPassword', defaultPassword);
  form.append('file', file);

  resultBox.hidden = false;
  resultBox.innerHTML = '<div class="loading">正在导入，请稍候…</div>';
  try {
    const result = await api('/api/students/import', { method: 'POST', body: form });
    const skippedRows = (result.skipped || [])
      .map(
        (item) =>
          `<tr><td>${item.row ?? ''}</td><td>${escapeHtml(item.studentNo || '')}</td><td>${escapeHtml(item.name || '')}</td><td>${escapeHtml(item.reason || '')}</td></tr>`
      )
      .join('');
    resultBox.innerHTML = `
      <div class="import-summary">
        成功导入 <b>${result.created}</b> 名学生，初始密码 <code>${escapeHtml(result.defaultPassword)}</code>，
        跳过 <b>${result.skipped?.length || 0}</b> 条。
      </div>
      ${
        skippedRows
          ? `<div class="table-scroll"><table class="table table-compact"><thead><tr><th>行号</th><th>学号</th><th>姓名</th><th>原因</th></tr></thead><tbody>${skippedRows}</tbody></table></div>`
          : ''
      }`;
    toast(`导入完成：成功 ${result.created} 人`, 'success');
    await loadStudents();
    await loadClasses();
  } catch (err) {
    resultBox.innerHTML = `<div class="import-error">导入失败：${escapeHtml(err.message)}</div>`;
    toast(err.message, 'error');
  }
}
