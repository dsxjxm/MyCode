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
}

function bindNav() {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach((item) => item.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.view').forEach((view) => view.classList.remove('active'));
      document.getElementById(`view-${btn.dataset.view}`).classList.add('active');
      if (btn.dataset.view === 'students') loadStudents();
    });
  });
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
    if (act === 'del-student') deleteStudent(student);
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
