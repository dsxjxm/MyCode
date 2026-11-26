// 演示数据种子脚本：创建一个演示班级 + 3 名学生（含个人空间与初始 WWW 站点）
// 用法：先 `npm start` 确保数据库已初始化，再执行 `node scripts/seed-demo.mjs`
// 幂等：已存在的班级/学生会自动跳过，可重复运行。
import { db, now } from '../server/db.js';
import { createClassFolder, createStudentFolder } from '../server/storage.js';
import { hashPassword } from '../server/password.js';

const className = '计算机应用25-1班';
const grade = '2025级';
const defaultPassword = '123456';
const students = [
  { no: '20250101', name: '张三' },
  { no: '20250102', name: '李四' },
  { no: '20250103', name: '王五' },
];

let cls = db.prepare('SELECT * FROM classes WHERE name = ?').get(className);
if (!cls) {
  const folder = createClassFolder(className);
  const r = db
    .prepare(
      'INSERT INTO classes (name, grade, description, folder, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(className, grade, '演示班级，可随时删除', folder, now());
  cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(Number(r.lastInsertRowid));
  console.log(`✓ 创建班级：${className}`);
} else {
  console.log(`- 班级已存在：${className}`);
}

let created = 0;
for (const s of students) {
  const exists = db
    .prepare('SELECT id FROM students WHERE class_id = ? AND student_no = ?')
    .get(cls.id, s.no);
  if (exists) {
    console.log(`- 跳过（已存在）：${s.no} ${s.name}`);
    continue;
  }
  const r = db
    .prepare(
      `INSERT INTO students (class_id, student_no, name, username, password_hash, folder, status, created_at)
       VALUES (?, ?, ?, ?, ?, '', 'active', ?)`
    )
    .run(cls.id, s.no, s.name, s.no, hashPassword(defaultPassword), now());
  const id = Number(r.lastInsertRowid);
  const folder = createStudentFolder(cls.folder, s.no, s.name);
  db.prepare('UPDATE students SET folder = ? WHERE id = ?').run(folder, id);
  console.log(`✓ 创建学生：${s.no} ${s.name}（账号 ${s.no}）`);
  created += 1;
}

console.log('');
console.log(`完成，新增 ${created} 名学生。`);
console.log('教师账号：admin / admin123');
console.log(`学生账号：${students.map((s) => s.no).join('、')}，密码统一为 ${defaultPassword}`);
