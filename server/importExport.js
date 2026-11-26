import XLSX from 'xlsx';
import iconv from 'iconv-lite';

const ALIASES = {
  studentNo: ['学号', '学籍号', 'studentno', 'student_no', 'number', 'no', '编号'],
  name: ['姓名', '名字', 'name', 'studentname', '学生姓名'],
  username: ['账号', '用户名', '登录名', 'username', 'account', '账户'],
  password: ['密码', '初始密码', 'password', 'pwd', '口令'],
  status: ['状态', 'status']
};

function normalizeHeader(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s_\-()（）]/g, '');
}

function decodeBuffer(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return iconv.decode(buffer, 'gbk');
  }
}

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',' || ch === '\t') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((cell) => String(cell).trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((cell) => String(cell).trim() !== '')) rows.push(row);
  return rows;
}

export function readRows(filename, buffer) {
  const lower = String(filename || '').toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
  }
  return parseCsv(decodeBuffer(buffer));
}

export function rowsToStudents(rows) {
  const cleaned = rows.map((row) => row.map((cell) => String(cell ?? '').trim()));
  let headerIndex = -1;
  let columnMap = null;

  for (let i = 0; i < Math.min(cleaned.length, 5); i += 1) {
    const normalized = cleaned[i].map(normalizeHeader);
    const map = {};
    for (const [key, aliases] of Object.entries(ALIASES)) {
      const idx = normalized.findIndex((h) => aliases.includes(h));
      if (idx >= 0) map[key] = idx;
    }
    if (map.studentNo !== undefined && map.name !== undefined) {
      headerIndex = i;
      columnMap = map;
      break;
    }
  }

  if (headerIndex < 0) {
    columnMap = { studentNo: 0, name: 1, username: 2, password: 3 };
    headerIndex = -1;
  }

  const records = [];
  const warnings = [];
  const seenNo = new Set();
  const seenUser = new Set();

  for (let i = headerIndex + 1; i < cleaned.length; i += 1) {
    const row = cleaned[i];
    const studentNo = row[columnMap.studentNo] || '';
    const name = row[columnMap.name] || '';
    if (!studentNo && !name) continue;
    if (!studentNo || !name) {
      warnings.push({ row: i + 1, reason: '缺少学号或姓名，已跳过' });
      continue;
    }
    const username = (columnMap.username !== undefined && row[columnMap.username]) || studentNo;
    const password = (columnMap.password !== undefined && row[columnMap.password]) || '';
    const statusRaw = (columnMap.status !== undefined && row[columnMap.status]) || '';
    const status = /停用|禁用|inactive|disabled/i.test(statusRaw) ? 'disabled' : 'active';
    if (seenNo.has(studentNo)) {
      warnings.push({ row: i + 1, reason: `学号 ${studentNo} 在文件中重复，已跳过` });
      continue;
    }
    if (seenUser.has(username)) {
      warnings.push({ row: i + 1, reason: `账号 ${username} 在文件中重复，已跳过` });
      continue;
    }
    seenNo.add(studentNo);
    seenUser.add(username);
    records.push({ studentNo, name, username, password, status });
  }

  return { records, warnings };
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function buildExport(filenameFormat, students, { classLabel = '' } = {}) {
  const header = ['学号', '姓名', '账号', '状态', '班级'];
  const rows = students.map((s) => [
    s.student_no,
    s.name,
    s.username,
    s.status === 'active' ? '正常' : '停用',
    s.class_name || classLabel
  ]);

  if (filenameFormat === 'csv') {
    const content =
      '\uFEFF' +
      [header, ...rows].map((row) => row.map(csvEscape).join(',')).join('\r\n');
    return { buffer: Buffer.from(content, 'utf8'), contentType: 'text/csv; charset=utf-8', ext: 'csv' };
  }

  const sheet = XLSX.utils.aoa_to_sheet([header, ...rows]);
  sheet['!cols'] = [{ wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 8 }, { wch: 20 }];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, '学生名单');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  return {
    buffer,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ext: 'xlsx'
  };
}

export function buildTemplate(format) {
  const header = ['学号', '姓名', '账号（可选）', '密码（可选）'];
  const sample = [
    ['20250101', '张三', '20250101', '123456'],
    ['20250102', '李四', '', '123456']
  ];
  if (format === 'csv') {
    const content = '\uFEFF' + [header, ...sample].map((r) => r.map(csvEscape).join(',')).join('\r\n');
    return { buffer: Buffer.from(content, 'utf8'), contentType: 'text/csv; charset=utf-8', ext: 'csv' };
  }
  const sheet = XLSX.utils.aoa_to_sheet([header, ...sample]);
  sheet['!cols'] = [{ wch: 14 }, { wch: 12 }, { wch: 16 }, { wch: 16 }];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, '导入模板');
  return {
    buffer: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }),
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ext: 'xlsx'
  };
}

export function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
