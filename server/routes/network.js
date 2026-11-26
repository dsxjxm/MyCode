// DNS / DHCP / 拓扑 API
import { Router } from 'express';
import { db } from '../db.js';
import { requireTeacher } from '../auth.js';
import {
  getDhcpConfig, dhcpDiscover, dhcpRelease,
  execCommand, resolveHost, ipInRange,
} from '../services/networkSim.js';

const router = new Router();

function requireLogin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '未登录' });
  next();
}

// 学生是否允许修改网络配置（教师可在控制台开关）
function studentEditAllowed() {
  const row = db.prepare("SELECT value FROM app_settings WHERE key='student_can_edit_network'").get();
  return !row || row.value !== '0';
}

// 教师始终可改；学生需设置允许
function canModifyNetwork(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '未登录' });
  if (req.user.role === 'teacher') return next();
  if (studentEditAllowed()) return next();
  return res.status(403).json({ error: '教师已禁止学生修改网络配置' });
}

// ====== 平台设置 ======
router.get('/settings', requireLogin, (_req, res) => {
  res.json({ student_can_edit_network: studentEditAllowed() });
});

router.put('/settings', requireTeacher, (req, res) => {
  const val = req.body && req.body.student_can_edit_network ? '1' : '0';
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES ('student_can_edit_network', ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  ).run(val);
  res.json({ student_can_edit_network: val === '1' });
});

function contextPc(pcId) {
  return db.prepare('SELECT * FROM network_pcs WHERE id = ?').get(pcId);
}

// ====== 拓扑 & PC ======
router.get('/topology', requireLogin, (req, res) => {
  const dhcp = getDhcpConfig();
  let pcs = db.prepare('SELECT * FROM network_pcs ORDER BY pos_y, pos_x').all();
  // 学生只能看到自己班级（简化：看到全部 PC，但状态可能不同）
  if (req.user.role === 'student') {
    pcs = pcs.map((p) => ({
      ...p,
      // 学生端只暴露必要字段
      mac_address: p.mac_address,
    }));
  }
  res.json({ dhcp, pcs });
});

// 保存 PC 画布坐标（所有登录用户可改，简单）
router.put('/pcs/:id/pos', canModifyNetwork, (req, res) => {
  const { pos_x, pos_y } = req.body || {};
  if (typeof pos_x !== 'number' || typeof pos_y !== 'number') {
    return res.status(400).json({ error: 'pos_x 和 pos_y 必须是数字' });
  }
  db.prepare('UPDATE network_pcs SET pos_x=?, pos_y=? WHERE id=?').run(pos_x, pos_y, req.params.id);
  res.json({ ok: true });
});

// PC 上线（触发 DHCP discover）
router.post('/pcs/:id/online', requireLogin, (req, res) => {
  const pc = contextPc(req.params.id);
  if (!pc) return res.status(404).json({ error: 'PC 不存在' });
  let r;
  if (pc.dhcp_enabled) {
    r = dhcpDiscover(pc.id);
  } else {
    // 静态 IP：直接上线
    db.prepare('UPDATE network_pcs SET status="online" WHERE id=?').run(pc.id);
    r = { ok: true, ip: pc.static_ip };
  }
  if (!r.ok) return res.status(500).json({ error: 'DHCP 分配失败: ' + r.reason });
  const fresh = contextPc(pc.id);
  res.json({ pc: fresh, dhcp: getDhcpConfig() });
});

// PC 下线（释放 DHCP）
router.post('/pcs/:id/offline', requireLogin, (req, res) => {
  dhcpRelease(req.params.id);
  const fresh = contextPc(req.params.id);
  res.json({ pc: fresh });
});

// ====== PC CRUD (教师) ======
router.post('/pcs', canModifyNetwork, (req, res) => {
  const { name, mac_address, dhcp_enabled = 1, static_ip, pos_x = 100, pos_y = 100 } = req.body || {};
  if (!name || !mac_address) return res.status(400).json({ error: 'name 和 mac_address 必填' });
  const r = db.prepare(
    `INSERT INTO network_pcs (name, mac_address, dhcp_enabled, static_ip, pos_x, pos_y, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'offline', datetime('now'))`
  ).run(name, mac_address, dhcp_enabled ? 1 : 0, static_ip || null, pos_x, pos_y);
  res.json({ pc: contextPc(r.lastInsertRowid) });
});

router.put('/pcs/:id', canModifyNetwork, (req, res) => {
  const { name, mac_address, dhcp_enabled, static_ip, dns_servers } = req.body || {};
  db.prepare(
    `UPDATE network_pcs SET name=COALESCE(?, name), mac_address=COALESCE(?, mac_address),
     dhcp_enabled=COALESCE(?, dhcp_enabled), static_ip=COALESCE(?, static_ip),
     dns_servers=COALESCE(?, dns_servers) WHERE id=?`
  ).run(name || null, mac_address || null, dhcp_enabled == null ? null : (dhcp_enabled ? 1 : 0), static_ip == null ? null : static_ip, dns_servers || null, req.params.id);
  res.json({ pc: contextPc(req.params.id) });
});

router.delete('/pcs/:id', canModifyNetwork, (req, res) => {
  db.prepare('DELETE FROM network_pcs WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ====== DHCP 配置 (教师) ======
router.get('/dhcp', requireLogin, (_req, res) => res.json(getDhcpConfig()));

router.put('/dhcp', canModifyNetwork, (req, res) => {
  const { server_ip, subnet_mask, gateway, dns_servers, pool_start, pool_end, lease_seconds } = req.body || {};
  const cfg = getDhcpConfig();
  if (!server_ip || !subnet_mask || !pool_start || !pool_end) {
    return res.status(400).json({ error: '必填：server_ip, subnet_mask, pool_start, pool_end' });
  }
  if (!ipInRange(pool_start, pool_start, pool_end) || !ipInRange(pool_end, pool_start, pool_end)) {
    // 简单范围检查
  }
  if (cfg) {
    db.prepare(
      `UPDATE dhcp_config SET server_ip=?, subnet_mask=?, gateway=?, dns_servers=?, pool_start=?, pool_end=?, lease_seconds=?, updated_at=datetime('now') WHERE id=?`
    ).run(server_ip, subnet_mask, gateway || server_ip, dns_servers || server_ip, pool_start, pool_end, lease_seconds || 86400, cfg.id);
  } else {
    db.prepare(
      `INSERT INTO dhcp_config (server_ip, subnet_mask, gateway, dns_servers, pool_start, pool_end, lease_seconds, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).run(server_ip, subnet_mask, gateway || server_ip, dns_servers || server_ip, pool_start, pool_end, lease_seconds || 86400);
  }
  res.json(getDhcpConfig());
});

// ====== DNS 记录 (教师可改，全部可看) ======
router.get('/dns', requireLogin, (_req, res) => {
  const records = db.prepare('SELECT * FROM dns_records ORDER BY type, name').all();
  res.json({ records });
});

router.post('/dns', canModifyNetwork, (req, res) => {
  const { type, name, value, ttl = 300 } = req.body || {};
  const validTypes = ['A', 'AAAA', 'CNAME', 'NS', 'MX', 'PTR', 'TXT', 'SRV'];
  if (!type || !validTypes.includes(type.toUpperCase())) {
    return res.status(400).json({ error: 'type 必须是 ' + validTypes.join('/') });
  }
  if (!name || !value) return res.status(400).json({ error: 'name 和 value 必填' });
  const r = db.prepare(
    `INSERT INTO dns_records (type, name, value, ttl, created_at) VALUES (?, ?, ?, ?, datetime('now'))`
  ).run(type.toUpperCase(), name, value, ttl);
  res.json({ record: db.prepare('SELECT * FROM dns_records WHERE id=?').get(r.lastInsertRowid) });
});

router.put('/dns/:id', canModifyNetwork, (req, res) => {
  const { type, name, value, ttl } = req.body || {};
  db.prepare(
    `UPDATE dns_records SET type=COALESCE(?, type), name=COALESCE(?, name),
     value=COALESCE(?, value), ttl=COALESCE(?, ttl) WHERE id=?`
  ).run(type || null, name || null, value || null, ttl == null ? null : ttl, req.params.id);
  res.json({ record: db.prepare('SELECT * FROM dns_records WHERE id=?').get(req.params.id) });
});

router.delete('/dns/:id', canModifyNetwork, (req, res) => {
  db.prepare('DELETE FROM dns_records WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// DNS 解析测试（前端联调用）
router.get('/dns/resolve', requireLogin, (req, res) => {
  const { host } = req.query;
  if (!host) return res.status(400).json({ error: 'host 必填' });
  res.json(resolveHost(String(host)));
});

// ====== 命令模拟器 ======
router.post('/exec', requireLogin, (req, res) => {
  const { pc_id, command } = req.body || {};
  if (!pc_id || !command) return res.status(400).json({ error: 'pc_id 和 command 必填' });
  const pc = contextPc(pc_id);
  if (!pc) return res.status(404).json({ error: 'PC 不存在' });
  const result = execCommand(pc, command);
  res.json(result);
});

export default router;
