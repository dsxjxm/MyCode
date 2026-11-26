// DNS / DHCP 核心逻辑 + 命令模拟器
import { db } from '../db.js';

// ============== IP 工具 ==============
export function parseIp(ip) {
  const m = String(ip || '').match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const octs = m.slice(1, 5).map(Number);
  if (octs.some((o) => o < 0 || o > 255)) return null;
  return octs;
}
export function ipToInt(ip) {
  const a = parseIp(ip);
  if (!a) return 0;
  return ((a[0] << 24) | (a[1] << 16) | (a[2] << 8) | a[3]) >>> 0;
}
export function intToIp(n) {
  n = n >>> 0;
  return `${(n >> 24) & 255}.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}
export function ipInRange(ip, start, end) {
  const i = ipToInt(ip), s = ipToInt(start), e = ipToInt(end);
  return i && s && e && i >= Math.min(s, e) && i <= Math.max(s, e);
}
export function sameSubnet(a, b, mask) {
  if (!a || !b || !mask) return false;
  const m = ipToInt(mask);
  return (ipToInt(a) & m) === (ipToInt(b) & m);
}

// ============== DHCP ==============
export function getDhcpConfig() {
  return db.prepare('SELECT * FROM dhcp_config ORDER BY id LIMIT 1').get();
}

export function getUsedIps(excludePcId = null) {
  const rows = db.prepare('SELECT current_ip FROM network_pcs WHERE current_ip IS NOT NULL AND current_ip <> ""').all();
  const set = new Set();
  for (const r of rows) set.add(r.current_ip);
  // 排除 DHCP server 自己的 IP
  const cfg = getDhcpConfig();
  if (cfg) set.add(cfg.server_ip);
  return set;
}

export function dhcpDiscover(pcId) {
  const cfg = getDhcpConfig();
  if (!cfg) return { ok: false, reason: 'no-dhcp-server' };

  // 1. 如果 PC 已经有有效租约，直接续期（模拟简化：总是重新分配下一个空闲）
  // 2. 找下一个空闲 IP
  const used = getUsedIps(pcId);
  let start = ipToInt(cfg.pool_start), end = ipToInt(cfg.pool_end);
  const sorted = [start, end].sort((a, b) => a - b);
  let assigned = null;
  for (let i = sorted[0]; i <= sorted[1]; i++) {
    const cand = intToIp(i);
    if (!used.has(cand)) { assigned = cand; break; }
  }
  if (!assigned) return { ok: false, reason: 'pool-exhausted' };

  const nowMs = Date.now();
  const expiresAt = nowMs + cfg.lease_seconds * 1000;
  // 更新 PC 状态
  db.prepare(
    `UPDATE network_pcs SET current_ip=?, subnet_mask=?, gateway=?, dns_servers=?,
     lease_expires_at=?, dhcp_enabled=1, status='online' WHERE id=?`
  ).run(assigned, cfg.subnet_mask, cfg.gateway, cfg.dns_servers, expiresAt, pcId);
  return { ok: true, ip: assigned, subnet: cfg.subnet_mask, gateway: cfg.gateway, dns: cfg.dns_servers, expiresAt };
}

export function dhcpRelease(pcId) {
  db.prepare(
    `UPDATE network_pcs SET current_ip=NULL, subnet_mask=NULL, gateway=NULL,
     dns_servers=NULL, lease_expires_at=NULL, status='offline' WHERE id=?`
  ).run(pcId);
  return { ok: true };
}

// ============== DNS 解析 ==============
export function resolveHost(host, dnsRecords = null, maxDepth = 5) {
  host = String(host || '').trim().toLowerCase().replace(/\.$/, '');
  if (!host) return { ip: null, cname: null, chain: [], error: 'empty-host' };

  // 先看是不是 IP
  if (parseIp(host)) return { ip: host, cname: null, chain: [host], error: null };

  if (!dnsRecords) dnsRecords = db.prepare('SELECT * FROM dns_records ORDER BY id').all();
  const byName = new Map();
  for (const r of dnsRecords) {
    const k = r.name.toLowerCase();
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(r);
  }

  let chain = [], visited = new Set();
  let current = host, lastCname = null;
  for (let d = 0; d < maxDepth; d++) {
    if (visited.has(current)) return { ip: null, cname: lastCname, chain, error: 'cname-loop' };
    visited.add(current);
    const recs = byName.get(current);
    if (!recs) break;
    const a = recs.find((r) => r.type.toUpperCase() === 'A');
    const c = recs.find((r) => r.type.toUpperCase() === 'CNAME');
    if (a) return { ip: a.value, cname: lastCname, chain: [...chain, current], error: null };
    if (c) {
      lastCname = c.value;
      chain.push(current);
      current = c.value.toLowerCase().replace(/\.$/, '');
      continue;
    }
    break;
  }
  return { ip: null, cname: lastCname, chain, error: 'nxdomain' };
}

// ============== 命令模拟器 ==============
function now() { return Date.now(); }
function randomMs(min = 1, max = 50) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function ttlFromIp(ip) {
  const n = ipToInt(ip) || 1;
  return (n % 128) + 64; // 模拟一个稳定 TTL
}

export function execCommand(pc, rawCmd) {
  if (!pc) return { output: 'PC 不存在' };
  const args = String(rawCmd || '').trim().split(/\s+/);
  const cmd = args[0]?.toLowerCase();
  if (!cmd) return { output: '' };

  switch (cmd) {
    case 'ipconfig':
      return cmdIpconfig(pc, args.slice(1));
    case 'ping':
      return cmdPing(pc, args.slice(1));
    case 'nslookup':
      return cmdNslookup(pc, args.slice(1));
    case 'tracert':
    case 'tracert.exe':
      return cmdTracert(pc, args.slice(1));
    case 'arp':
      return cmdArp(pc, args.slice(1));
    case 'net':
    case 'netsh':
      return cmdNet(pc, args.slice(1));
    case 'help':
    case '?':
      return { output: '可用命令：ipconfig, ping, nslookup, tracert, tracert.exe, arp, net, netsh, help, clear, exit' };
    case 'clear':
    case 'cls':
      return { output: '__CLEAR__' };
    case 'exit':
      return { output: '再见！当前 PC 已保持网络状态。' };
    default:
      return { output: `'${cmd}' 不是内部或外部命令，也不是可运行的程序或批处理文件。输入 help 查看可用命令。` };
  }
}

function cmdIpconfig(pc, opts) {
  const full = opts.includes('/all');
  const ip = pc.current_ip;
  const lines = [];
  lines.push('');
  lines.push('Windows IP 配置');
  lines.push('');
  if (!ip) {
    lines.push('本地连接');
    lines.push('   媒体状态 . . . . . . . . . . . : 媒体已断开');
    lines.push('   连接特定 DNS 后缀 . . . . . . :');
  } else {
    lines.push('本地连接');
    lines.push('   媒体状态 . . . . . . . . . . . : 已连接');
    lines.push('   连接特定 DNS 后缀 . . . . . . :');
    if (full) {
      lines.push(`   描述 . . . . . . . . . . . . . : Intel(R) PRO/1000 MT Network Connection`);
      lines.push(`   物理地址 . . . . . . . . . . . : ${pc.mac_address}`);
      lines.push(`   DHCP 已启用 . . . . . . . . .  : ${pc.dhcp_enabled ? '是' : '否'}`);
    }
    lines.push(`   IPv4 地址 . . . . . . . . . . : ${ip}`);
    lines.push(`   子网掩码  . . . . . . . . . . : ${pc.subnet_mask ?? ''}`);
    const leaseExp = pc.lease_expires_at ? new Date(pc.lease_expires_at).toLocaleString('zh-CN') : null;
    if (leaseExp) lines.push(`   租约过期时间 . . . . . . . . . : ${leaseExp}`);
    lines.push(`   默认网关 . . . . . . . . . . . : ${pc.gateway ?? ''}`);
    const dns = (pc.dns_servers || '').split(',').filter(Boolean);
    if (dns.length) {
      lines.push('');
      lines.push('DNS 服务器');
      dns.forEach((d, i) => lines.push(`   ${i + 1}. ${d.trim()}`));
    }
  }
  lines.push('');
  return { output: lines.join('\n') };
}

function cmdPing(pc, args) {
  if (!args.length) return { output: '请指定要 ping 的主机或 IP。\n用法：ping <host> | ping -n <count> <host>' };

  let count = 4, hostArg = args[0];
  if (args[0] === '-n' && args[1]) { count = Math.min(Math.max(Number(args[1]) || 4, 1), 100); hostArg = args[2]; }
  if (!hostArg) return { output: '请指定要 ping 的主机。' };

  // 离线时 ping 任何东西都不通
  if (!pc.current_ip) {
    return { output: `\n正在 Ping ${hostArg} 具有 32 字节的数据:\n\n    无法访问目标主机。\n\nPing 统计信息:\n    数据包: 已发送 = ${count}，已接收 = 0，丢失 = ${count} (${(count / count * 100)}% 丢失)，` };
  }

  const dns = resolveHost(hostArg);
  if (!dns.ip) {
    return { output: `Ping 请求找不到主机 ${hostArg}。请检查该名称，然后重试。` };
  }

  // 检查目标是否可达：同子网内的已分配 IP 视为可达，否则视为不可达（模拟真实）
  const cfg = getDhcpConfig();
  const lines = [`\n正在 Ping ${dns.ip} 具有 32 字节的数据:`];
  let ok = 0;
  // 网关和已在线 PC 视为可达；子网外视为丢失（10% 包随机丢）
  const reachableIps = new Set([cfg?.gateway, cfg?.server_ip, cfg?.pool_start, cfg?.pool_end].filter(Boolean));
  const onlinePcs = db.prepare('SELECT current_ip FROM network_pcs WHERE current_ip IS NOT NULL AND status="online"').all();
  for (const r of onlinePcs) reachableIps.add(r.current_ip);
  reachableIps.add(dns.ip); // DNS 解析到的主机默认可达（模拟）

  const sameNet = sameSubnet(dns.ip, pc.current_ip, pc.subnet_mask || cfg?.subnet_mask || '255.255.255.0');
  const reachable = reachableIps.has(dns.ip) || sameNet;

  for (let i = 0; i < count; i++) {
    if (reachable && Math.random() > 0.1) {
      ok++;
      lines.push(`来自 ${dns.ip} 的回复: 字节=32 时间=${randomMs(1, 50)}ms TTL=${ttlFromIp(dns.ip)}`);
      // 更新 ARP 缓存
      cacheArp(pc.id, dns.ip, targetMac(dns.ip));
    } else {
      lines.push('请求超时。');
    }
  }
  const loss = ((count - ok) / count * 100).toFixed(0);
  const min = ok ? randomMs(1, 10) + 5 : 0;
  const max = ok ? randomMs(30, 80) + 30 : 0;
  const avg = ok ? Math.round((min + max) / 2) : 0;
  lines.push('');
  lines.push(`Ping 统计信息:`);
  lines.push(`    数据包: 已发送 = ${count}，已接收 = ${ok}，丢失 = ${count - ok} (${loss}% 丢失)，`);
  if (ok) {
    lines.push('近似的往返时间(以毫秒为单位)：');
    lines.push(`    最短 = ${min}ms，最长 = ${max}ms，平均 = ${avg}ms`);
  }
  lines.push('');
  return { output: lines.join('\n') };
}

function cmdNslookup(pc, args) {
  const host = args[0];
  if (!host) return { output: '用法：nslookup <host>' };
  const dnsServer = (pc.dns_servers || '').split(',').filter(Boolean)[0] || '192.168.1.1';
  const dns = resolveHost(host);
  const lines = [''];
  lines.push('服务器:  ' + dnsServer);
  lines.push('Address: ' + dnsServer + '#' + 53);
  lines.push('');
  if (dns.ip) {
    lines.push('名称:    ' + host);
    if (dns.cname) lines.push('Address: ' + dns.ip);
    else lines.push('Address: ' + dns.ip);
    if (dns.chain.length) {
      lines.push('Aliases: ' + dns.chain.join(' -> '));
    }
  } else {
    lines.push(`*** ${dnsServer} 找不到 ${host}: Non-existent domain`);
  }
  lines.push('');
  return { output: lines.join('\n') };
}

function cmdTracert(pc, args) {
  if (!args.length) return { output: '用法：tracert <host>' };
  const hostArg = args[0];
  const lines = [`\nTracing route to ${hostArg} over a maximum of 5 hops:\n`];
  const dns = resolveHost(hostArg);
  if (!dns.ip) {
    lines.push('Unable to resolve target system name ' + hostArg);
    lines.push('');
    return { output: lines.join('\n') };
  }
  if (!pc.current_ip) {
    lines.push('无法访问目标主机（本地网络未连接）');
    lines.push('');
    return { output: lines.join('\n') };
  }

  const cfg = getDhcpConfig();
  const hops = [];
  // 1: gateway
  if (pc.gateway) hops.push({ ip: pc.gateway, name: 'gateway.local' });
  // 2: server
  if (cfg?.server_ip && cfg.server_ip !== pc.gateway) hops.push({ ip: cfg.server_ip, name: 'server.local' });
  // 3-n: 模拟额外跳数（最多 5 跳含终点）
  const remaining = Math.max(0, 5 - hops.length - 1);
  for (let i = 1; i <= remaining; i++) {
    const third = ipToInt(dns.ip) - i;
    if (third > ipToInt(cfg?.server_ip || '192.168.1.1')) {
      hops.push({ ip: intToIp(third), name: `hop-${i}` });
    }
  }
  // 终点
  hops.push({ ip: dns.ip, name: hostArg });

  lines.push('  1       *        *        *     请求超时。');
  for (let i = 0; i < hops.length; i++) {
    const h = hops[i];
    if (i === 0) continue; // 上面打印了一个 timeout
    const ms1 = randomMs(1, 30), ms2 = randomMs(1, 30), ms3 = randomMs(1, 30);
    lines.push(`${(i + 1).toString().padStart(3)}   ${ms1.toString().padStart(3)} ms   ${ms2.toString().padStart(3)} ms   ${ms3.toString().padStart(3)} ms   ${h.name ?? h.ip}`);
  }
  lines.push('');
  lines.push('Trace complete.');
  lines.push('');
  return { output: lines.join('\n') };
}

function cmdArp(pc, args) {
  const opt = args[0] || '';
  if (opt === '-a' || opt === '-g' || opt === '') {
    const cache = db.prepare('SELECT remote_ip, remote_mac FROM pc_arp_cache WHERE pc_id=? ORDER BY resolved_at DESC').all(pc.id);
    const lines = ['', '接口: ' + (pc.current_ip || '0.0.0.0') + ' --- ' + (pc.mac_address || '')];
    if (!cache.length) {
      lines.push('  没有 ARP 条目。');
    } else {
      lines.push('  Internet 地址         物理地址              类型');
      for (const c of cache) {
        const type = sameSubnet(c.remote_ip, pc.current_ip || '0.0.0.0', pc.subnet_mask || '255.255.255.0') ? '动态' : '动态';
        lines.push(`  ${c.remote_ip.padEnd(18)} ${c.remote_mac.padEnd(20)} ${type}`);
      }
    }
    lines.push('');
    return { output: lines.join('\n') };
  }
  if (opt === '-d') {
    db.prepare('DELETE FROM pc_arp_cache WHERE pc_id=?').run(pc.id);
    return { output: '已清除 ARP 缓存。\n' };
  }
  return { output: '用法：arp -a (查看缓存)  arp -d (清除缓存)' };
}

function cmdNet(pc, args) {
  const sub = args[0]?.toLowerCase();
  if (sub === 'view') {
    const cfg = getDhcpConfig();
    const pcs = db.prepare('SELECT * FROM network_pcs').all();
    let out = 'Server Name                    Remark\n------------------------------  ----------\n';
    for (const p of pcs) out += `${p.name.padEnd(32)} ${p.status === 'online' ? '[online]' : '[offline]'}\n`;
    out += '\n这个命令的作用是查询共享资源。\n';
    return { output: out };
  }
  return { output: '用法：net view\n' };
}

function cmdNetsh(pc, args) {
  const sub = args[0]?.toLowerCase();
  if (sub === 'interface' && args[1] === 'ip' && args[2] === 'config' && args[3] === 'dhcp') {
    // netsh interface ip set address name="Local Area Connection" source=dhcp
    const r = dhcpDiscover(pc.id);
    if (r.ok) {
      db.prepare('UPDATE network_pcs SET dhcp_enabled=1 WHERE id=?').run(pc.id);
      return { output: '成功地从 DHCP 服务器获取地址。\n\nIP Address . . . . : ' + r.ip + '\nSubnet Mask . . . . : ' + r.subnet + '\nDefault Gateway . . : ' + r.gateway + '\n' };
    }
    return { output: 'DHCP 服务器无响应，无法获取地址。\n' };
  }
  if (sub === 'interface' && args[1] === 'ip' && args[2] === 'set') {
    if (args[3] === 'address') {
      const ip = args[5]; // name="Local Area Connection" static <ip> <mask> <gw>
      const m = args.findIndex((a) => a === 'static');
      if (m >= 0 && args[m + 1]) {
        const ip2 = args[m + 1], mask = args[m + 2] || '255.255.255.0', gw = args[m + 3] || '';
        db.prepare(
          `UPDATE network_pcs SET dhcp_enabled=0, current_ip=?, subnet_mask=?, gateway=?,
           lease_expires_at=NULL, status='online' WHERE id=?`
        ).run(ip2, mask, gw, pc.id);
        return { output: '已应用静态 IP 配置。\n' };
      }
    }
    if (args[3] === 'dns') {
      const dns = args.findIndex((a) => a === 'static');
      if (dns >= 0 && args[dns + 1]) {
        db.prepare('UPDATE network_pcs SET dns_servers=? WHERE id=?').run(args[dns + 1], pc.id);
        return { output: '已应用 DNS 配置。\n' };
      }
    }
  }
  if (sub === 'wins' || sub === 'adv' || sub === 'firewall') {
    return { output: '(该 netsh 子命令暂不支持)\n' };
  }
  return { output: '用法：netsh interface ip config dhcp\n     netsh interface ip set address name="Local Area Connection" static <ip> <mask> <gateway>\n     netsh interface ip set dns name="Local Area Connection" static <dns>\n' };
}

// ============== ARP 缓存 ==============
function targetMac(ip) {
  const cfg = getDhcpConfig();
  if (ip === cfg?.gateway) return '00:11:22:33:44:01';
  if (ip === cfg?.server_ip) return '00:11:22:33:44:02';
  const pcs = db.prepare('SELECT mac_address, current_ip FROM network_pcs WHERE current_ip=?').all(ip);
  if (pcs.length) return pcs[0].mac_address;
  // 否则用 IP 最后一段生成一个
  const last = ip.split('.').pop();
  return `00:11:22:33:44:${last.padStart(2, '0')}`;
}
function cacheArp(pcId, remoteIp, remoteMac) {
  db.prepare(
    `INSERT INTO pc_arp_cache (pc_id, remote_ip, remote_mac, resolved_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(pc_id, remote_ip) DO UPDATE SET remote_mac=excluded.remote_mac, resolved_at=excluded.resolved_at`
  ).run(pcId, remoteIp, remoteMac, now());
}
