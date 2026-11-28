import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lanplat-test-'));

const { resolveInside, sanitizeName, createClassFolder, createStudentFolder, listTree } = await import(
  '../server/storage.js'
);
const { parseCsv, rowsToStudents, buildExport, buildTemplate } = await import('../server/importExport.js');
const { hashPassword, verifyPassword } = await import('../server/password.js');
const {
  getAllowedExtensions,
  getUploadFileSizeBytes,
  getUploadFileSizeConfig,
  saveAllowedExtensions,
  saveUploadFileSizeConfig
} = await import('../server/services/uploadRules.js');
const { db, dbReady } = await import('../server/db.js');
await dbReady;

test('sanitizeName 过滤非法字符并保留中文', () => {
  assert.equal(sanitizeName('张三'), '张三');
  assert.equal(sanitizeName('a/b:c*d'), 'a_b_c_d');
  assert.equal(sanitizeName('   '), '未命名');
});

test('resolveInside 阻止路径穿越', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'base-'));
  assert.ok(resolveInside(base, 'index.html'));
  assert.ok(resolveInside(base, 'css/style.css'));
  assert.equal(resolveInside(base, '../secret.txt'), null);
  assert.equal(resolveInside(base, '..%2fsecret.txt'), null);
  assert.equal(resolveInside(base, '/etc/passwd'), path.join(path.resolve(base), 'etc', 'passwd'));
});

test('班级与学生目录自动创建', () => {
  const classFolder = createClassFolder('测试班');
  const studentFolder = createStudentFolder(classFolder, '001', '张三');
  const base = path.join(process.env.DATA_DIR, 'classes', classFolder, studentFolder);
  for (const sub of ['www', 'ftp', 'homework', 'design']) {
    assert.ok(fs.existsSync(path.join(base, sub)), `${sub} 应存在`);
  }
  assert.ok(fs.existsSync(path.join(base, 'www', 'index.html')));
  assert.ok(fs.existsSync(path.join(base, 'www', 'css', 'style.css')));
  const tree = listTree(path.join(base, 'www'));
  assert.ok(tree.some((item) => item.path === 'index.html' && item.type === 'file'));
});

test('CSV 解析支持引号与逗号', () => {
  const rows = parseCsv('学号,姓名\r\n001,"张,三"\r\n002,李四\n');
  assert.deepEqual(rows, [
    ['学号', '姓名'],
    ['001', '张,三'],
    ['002', '李四']
  ]);
});

test('名单解析支持别名表头、默认账号与去重', () => {
  const { records, warnings } = rowsToStudents([
    ['学生姓名', '学籍号', '用户名'],
    ['张三', '001', ''],
    ['李四', '002', 'lisi'],
    ['张三重复', '001', '']
  ]);
  assert.equal(records.length, 2);
  assert.equal(records[0].username, '001');
  assert.equal(records[1].username, 'lisi');
  assert.equal(warnings.length, 1);
});

test('无表头名单按位置解析', () => {
  const { records } = rowsToStudents([
    ['001', '张三', 'zhangsan', 'pw123'],
    ['002', '李四', '', '']
  ]);
  assert.equal(records.length, 2);
  assert.equal(records[0].username, 'zhangsan');
  assert.equal(records[1].username, '002');
});

test('导出 CSV 含 BOM 与表头', () => {
  const { buffer, ext } = buildExport('csv', [
    { student_no: '001', name: '张三', username: '001', status: 'active' }
  ], { classLabel: '测试班' });
  assert.equal(ext, 'csv');
  const text = buffer.toString('utf8');
  assert.ok(text.startsWith('\uFEFF'));
  assert.ok(text.includes('学号,姓名,账号,状态,班级'));
  assert.ok(text.includes('测试班'));
});

test('模板导出为 xlsx 时包含表头', () => {
  const file = buildTemplate('xlsx');
  assert.equal(file.ext, 'xlsx');
  assert.ok(file.buffer.length > 1000);
});

test('密码哈希可校验且不同盐值结果不同', () => {
  const a = hashPassword('123456');
  const b = hashPassword('123456');
  assert.notEqual(a, b);
  assert.ok(verifyPassword('123456', a));
  assert.ok(!verifyPassword('654321', a));
});

test('上传大小默认限制与旧版本一致', () => {
  assert.deepEqual(getUploadFileSizeConfig(), {
    enabled: true,
    valuesMiB: { www: 20, terminal: 10, mail: 10, students: 10 }
  });
  assert.equal(getUploadFileSizeBytes('www'), 20 * 1024 * 1024);
  assert.equal(getUploadFileSizeBytes('terminal'), 10 * 1024 * 1024);
});

test('上传大小配置可保存、关闭并保留数值，且不影响扩展名', () => {
  const original = getUploadFileSizeConfig();
  const originalExt = getAllowedExtensions();
  try {
    saveAllowedExtensions('txt,html');
    saveUploadFileSizeConfig({
      enabled: true,
      valuesMiB: { www: 1, terminal: 2, mail: 3, students: 4 }
    });
    assert.equal(getUploadFileSizeBytes('mail'), 3 * 1024 * 1024);
    assert.deepEqual(getAllowedExtensions(), ['txt', 'html']);

    saveUploadFileSizeConfig({
      enabled: false,
      valuesMiB: { www: 1, terminal: 2, mail: 3, students: 4 }
    });
    assert.equal(getUploadFileSizeBytes('www'), Infinity);
    assert.deepEqual(getAllowedExtensions(), ['txt', 'html']);
    assert.deepEqual(getUploadFileSizeConfig().valuesMiB, { www: 1, terminal: 2, mail: 3, students: 4 });
  } finally {
    saveUploadFileSizeConfig(original);
    saveAllowedExtensions(originalExt);
  }
});

test('上传大小拒绝非法配置，损坏存储安全回退默认值', () => {
  const original = getUploadFileSizeConfig();
  const validValues = { www: 20, terminal: 10, mail: 10, students: 10 };
  assert.throws(
    () => saveUploadFileSizeConfig({ enabled: true, valuesMiB: { ...validValues, www: 0 } }),
    /1～1024/
  );
  assert.throws(
    () => saveUploadFileSizeConfig({ enabled: true, valuesMiB: { ...validValues, mail: 1.5 } }),
    /1～1024/
  );
  assert.throws(
    () => saveUploadFileSizeConfig({ enabled: 'yes', valuesMiB: validValues }),
    /开关格式/
  );
  try {
    db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(
      'upload_file_size_limit',
      '{broken'
    );
    assert.deepEqual(getUploadFileSizeConfig(), { enabled: true, valuesMiB: validValues });
  } finally {
    saveUploadFileSizeConfig(original);
  }
});
