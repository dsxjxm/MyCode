// ========== 全局状态 ==========
const state = {
  me: null,
  dhcp: null,
  dns: [],
  pcs: [],
  selectedPcId: null,
  history: [],
  historyIdx: -1,
};

const API = '/api/network';

async function api(method, path, body) {
  const opts = { method, headers: { 'content-type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(API + path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

// ========== 登录 & 权限 ==========
async function initAuth() {
  const r = await fetch('/api/auth/me');
  if (!r.ok) { location.href = '/login.html'; return; }
  const data = await r.json();
  state.me = data.user || null;
  if (!state.me) { location.href = '/login.html'; return; }
  const u = state.me;
  const cls = u.className || u.class_name || '';
  document.getElementById('userChip').textContent =
    `${cls ? cls + ' · ' : ''}${u.name}（${u.username}）`;

  // 是否允许编辑：教师始终可改，学生取决于控制台开关
  let allowStudent = true;
  try {
    const st = await (await fetch('/api/network/settings')).json();
    allowStudent = !!st.student_can_edit_network;
  } catch (_) { /* 忽略，默认允许 */ }
  state.canEdit = u.role === 'teacher' || allowStudent;
  document.body.classList.toggle('net-readonly', !state.canEdit);

  document.getElementById('logoutBtn').addEventListener('click', async (e) => {
    e.preventDefault();
    await fetch('/api/auth/logout', { method: 'POST' });
    location.href = '/login.html';
  });
}

// ========== 数据加载 ==========
async function loadAll() {
  const topo = await api('GET', '/topology');
  state.dhcp = topo.dhcp;
  state.pcs = topo.pcs;
  state.dns = (await api('GET', '/dns')).records;
  renderSidebar();
  renderTopology();
  renderPcCards();
  renderTermPcSelect();
}

// ========== 拓扑 SVG ==========
const SERVER_POS = { x: 400, y: 80 };
const SVG_W = 900, SVG_H = 420;

function renderTopology() {
  const svg = document.getElementById('topoSvg');
  const ns = 'http://www.w3.org/2000/svg';
  svg.setAttribute('viewBox', `0 0 ${SVG_W} ${SVG_H}`);
  // 保留 <defs>（渐变、滤镜定义），只清除旧的节点与连线
  const defsEl = svg.querySelector('defs');
  svg.innerHTML = defsEl ? defsEl.outerHTML : '';

  // Server 节点（固定）
  const serverG = document.createElementNS(ns, 'g');
  serverG.setAttribute('class', 'node-group server');
  serverG.setAttribute('transform', `translate(${SERVER_POS.x - 80}, ${SERVER_POS.y})`);
  serverG.innerHTML = `
    <rect class="node-body" x="0" y="0" width="160" height="70" rx="8" fill="url(#serverGrad)" stroke="#1e40af" stroke-width="1" filter="url(#softShadow)"/>
    <text x="80" y="30" text-anchor="middle" fill="#ffffff" font-size="13" font-weight="600">DNS / DHCP 服务器</text>
    <text x="80" y="50" text-anchor="middle" fill="#dbeafe" font-size="11">${state.dhcp?.server_ip || '...'}</text>
    <circle class="node-status-dot online" cx="14" cy="13" r="6"/>
  `;
  svg.appendChild(serverG);

  // PC 节点
  const links = document.createElementNS(ns, 'g');
  const nodes = document.createElementNS(ns, 'g');

  state.pcs.forEach((pc) => {
    const pos = { x: pc.pos_x || 100, y: pc.pos_y || 200 };
    // 确保 PC 位置在画布内
    if (pos.x < 50) pos.x = 100;
    if (pos.y < 100) pos.y = 220;

    // 连线
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', SERVER_POS.x);
    line.setAttribute('y1', SERVER_POS.y + 70);
    line.setAttribute('x2', pos.x + 60);
    line.setAttribute('y2', pos.y);
    line.setAttribute('class', 'link-line' + (pc.status === 'online' ? ' active' : ''));
    links.appendChild(line);

    // PC 节点
    const g = document.createElementNS(ns, 'g');
    g.setAttribute('class', 'node-group ' + (pc.status === 'online' ? 'online' : 'offline'));
    g.setAttribute('transform', `translate(${pos.x}, ${pos.y})`);
    g.dataset.id = pc.id;
    g.innerHTML = `
      <rect class="node-body" x="0" y="0" width="120" height="60" rx="6" fill="url(#pcGrad)" stroke="#334155" stroke-width="1" filter="url(#softShadow)"/>
      <text x="60" y="24" text-anchor="middle" fill="#ffffff" font-size="12" font-weight="500">${pc.name}</text>
      <text x="60" y="43" text-anchor="middle" fill="#e2e8f0" font-size="10">${pc.current_ip || '未连接'}</text>
      <circle class="node-status-dot ${pc.status}" cx="108" cy="12" r="6"/>
    `;

    // 拖放 + 点击
    attachNodeInteraction(g, pc);
    nodes.appendChild(g);
  });

  svg.appendChild(links);
  svg.appendChild(nodes);
}

// ========== 节点交互（拖放 + 点击） ==========
function attachNodeInteraction(g, pc) {
  let dragging = false, offsetX = 0, offsetY = 0, downX = 0, downY = 0, moved = false;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svg = document.getElementById('topoSvg');

  function svgPoint(evt) {
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX; pt.y = evt.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: evt.clientX, y: evt.clientY };
    const loc = pt.matrixTransform(ctm.inverse());
    return { x: loc.x, y: loc.y };
  }

  g.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (!state.canEdit) return;
    e.stopPropagation();
    const p = svgPoint(e);
    const cur = g.transform.baseVal.getItem(0);
    offsetX = cur.matrix.a === 1 ? cur.matrix.e : posFromTransform(g).x;
    offsetY = cur.matrix.a === 1 ? cur.matrix.f : posFromTransform(g).y;
    downX = p.x; downY = p.y;
    dragging = true; moved = false;
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const p = svgPoint(e);
    const dx = p.x - downX, dy = p.y - downY;
    if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
    const newX = Math.max(20, Math.min(SVG_W - 140, offsetX + dx));
    const newY = Math.max(90, Math.min(SVG_H - 80, offsetY + dy));
    g.setAttribute('transform', `translate(${newX}, ${newY})`);

    // 更新连线末端
    const pcId = g.dataset.id;
    const link = svg.querySelector(`.link-line`); // 简单更新全部
    const linkIndex = state.pcs.findIndex((p) => String(p.id) === pcId);
    const allLinks = svg.querySelectorAll('.link-line');
    if (allLinks[linkIndex]) {
      allLinks[linkIndex].setAttribute('x2', newX + 60);
      allLinks[linkIndex].setAttribute('y2', newY);
    }
  });

  window.addEventListener('mouseup', async (e) => {
    if (!dragging) return;
    dragging = false;
    if (moved) {
      const p = svgPoint(e);
      const newX = Math.max(20, Math.min(SVG_W - 140, offsetX + (p.x - downX)));
      const newY = Math.max(90, Math.min(SVG_H - 80, offsetY + (p.y - downY)));
      try {
        await api('PUT', `/pcs/${pc.id}/pos`, { pos_x: Math.round(newX), pos_y: Math.round(newY) });
        const pcObj = state.pcs.find((x) => x.id === pc.id);
        pcObj.pos_x = Math.round(newX); pcObj.pos_y = Math.round(newY);
      } catch (err) { console.error(err); }
    } else {
      // 点击：切换在线状态
      await togglePcOnline(pc.id);
    }
  });
}

function posFromTransform(g) {
  const m = g.transform.baseVal.getItem(0).matrix;
  return { x: m.e, y: m.f };
}

async function togglePcOnline(id) {
  const pc = state.pcs.find((p) => p.id === id);
  const next = pc.status === 'online' ? 'offline' : 'online';
  try {
    const path = next === 'online' ? `/pcs/${id}/online` : `/pcs/${id}/offline`;
    await api('POST', path);
    await loadAll();
    // 如果终端选了这台 PC，也更新
    if (state.selectedPcId === id && next === 'offline') {
      state.selectedPcId = null;
      document.getElementById('termPrompt').textContent = '请先选择一台 PC > ';
    }
  } catch (err) {
    alert('操作失败：' + err.message);
  }
}

// ========== 左侧面板 ==========
function renderSidebar() {
  // DHCP
  const d = state.dhcp || {};
  document.getElementById('dhcp_server_ip').value = d.server_ip || '';
  document.getElementById('dhcp_subnet').value = d.subnet_mask || '';
  document.getElementById('dhcp_gateway').value = d.gateway || '';
  document.getElementById('dhcp_dns').value = d.dns_servers || '';
  document.getElementById('dhcp_pool_start').value = d.pool_start || '';
  document.getElementById('dhcp_pool_end').value = d.pool_end || '';
  document.getElementById('dhcp_lease').value = d.lease_seconds || 86400;

  // DNS
  const dnsBox = document.getElementById('dnsRecords');
  if (!state.dns.length) {
    dnsBox.innerHTML = '<div style="color:#9ca3af;font-size:12px;padding:6px;">暂无 DNS 记录</div>';
  } else {
    dnsBox.innerHTML = state.dns.map((r) => {
      const cls = r.type.toLowerCase();
      return `<div class="dns-list-item">
        <span class="dns-tag ${cls}">${r.type}</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
          <b>${r.name}</b> → ${r.value}
        </span>
        <button class="btn btn-danger btn-sm" data-del-dns="${r.id}">×</button>
      </div>`;
    }).join('');
  }

  dnsBox.querySelectorAll('[data-del-dns]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('确定删除此 DNS 记录？')) return;
      await api('DELETE', `/dns/${btn.dataset.delDns}`);
      await loadAll();
    });
  });
}

function renderPcCards() {
  const list = document.getElementById('pcList');
  list.innerHTML = state.pcs.map((pc) => {
    const cls = pc.status === 'online' ? 'online' : 'offline';
    return `<div class="pc-card ${cls}" data-id="${pc.id}">
      <div class="pc-info">
        <div><b>${pc.name}</b></div>
        <div style="color:#6b7280">${pc.current_ip || '未连接'} · ${pc.mac_address}</div>
      </div>
      <span class="pc-status">${pc.status === 'online' ? '🟢 在线' : '⚪ 离线'}</span>
    </div>`;
  }).join('');

  list.querySelectorAll('.pc-card').forEach((card) => {
    card.addEventListener('click', async () => {
      const id = Number(card.dataset.id);
      await togglePcOnline(id);
    });
  });
}

// DHCP 保存
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('dhcpSave')?.addEventListener('click', async () => {
    const body = {
      server_ip: document.getElementById('dhcp_server_ip').value.trim(),
      subnet_mask: document.getElementById('dhcp_subnet').value.trim(),
      gateway: document.getElementById('dhcp_gateway').value.trim(),
      dns_servers: document.getElementById('dhcp_dns').value.trim(),
      pool_start: document.getElementById('dhcp_pool_start').value.trim(),
      pool_end: document.getElementById('dhcp_pool_end').value.trim(),
      lease_seconds: Number(document.getElementById('dhcp_lease').value) || 86400,
    };
    try {
      await api('PUT', '/dhcp', body);
      alert('✅ DHCP 配置已保存');
      await loadAll();
    } catch (err) {
      alert('保存失败：' + err.message);
    }
  });

  document.getElementById('dnsAddBtn')?.addEventListener('click', async () => {
    const html = `
      <div id="dnsAddForm" style="padding:8px;background:#eff6ff;border-radius:4px;margin-bottom:8px;">
        <div class="row2">
          <div class="field"><label>类型</label>
            <select id="dnsType"><option>A</option><option>AAAA</option><option>CNAME</option><option>NS</option><option>MX</option></select>
          </div>
          <div class="field"><label>TTL(秒)</label><input id="dnsTTL" value="300" type="number"></div>
        </div>
        <div class="field"><label>主机名</label><input id="dnsName" placeholder="www"></div>
        <div class="field"><label>值</label><input id="dnsValue" placeholder="192.168.1.100"></div>
        <div style="display:flex;gap:6px;margin-top:6px;">
          <button class="btn btn-primary" id="dnsConfirm">添加</button>
          <button class="btn" id="dnsCancel">取消</button>
        </div>
      </div>`;
    const host = document.getElementById('dnsRecords');
    host.insertAdjacentHTML('afterbegin', html);
    document.getElementById('dnsCancel').onclick = () => document.getElementById('dnsAddForm').remove();
    document.getElementById('dnsConfirm').onclick = async () => {
      try {
        await api('POST', '/dns', {
          type: document.getElementById('dnsType').value,
          name: document.getElementById('dnsName').value.trim(),
          value: document.getElementById('dnsValue').value.trim(),
          ttl: Number(document.getElementById('dnsTTL').value) || 300,
        });
        await loadAll();
      } catch (err) { alert('添加失败：' + err.message); }
    };
  });

  document.getElementById('pcAddBtn')?.addEventListener('click', async () => {
    const name = prompt('PC 名称（如 PC-李四）:');
    if (!name) return;
    const mac = prompt('MAC 地址（如 00:1A:2B:3C:4D:05）:');
    if (!mac) return;
    try {
      await api('POST', '/pcs', { name, mac_address: mac });
      await loadAll();
    } catch (err) { alert('添加失败：' + err.message); }
  });
});

// ========== 命令终端 ==========
function renderTermPcSelect() {
  const sel = document.getElementById('termPcSelect');
  const onlinePcs = state.pcs.filter((p) => p.status === 'online');
  if (!onlinePcs.length) {
    sel.innerHTML = '<option value="">请先让 PC 上线</option>';
  } else {
    sel.innerHTML = onlinePcs.map((p) =>
      `<option value="${p.id}">${p.name}  (${p.current_ip})</option>`
    ).join('');
    if (state.selectedPcId && onlinePcs.find((p) => p.id === state.selectedPcId)) {
      sel.value = state.selectedPcId;
    } else {
      state.selectedPcId = Number(sel.value);
      updatePrompt();
    }
  }
}

function updatePrompt() {
  const pc = state.pcs.find((p) => p.id === state.selectedPcId);
  document.getElementById('termPrompt').textContent = pc ?
    `${pc.name}> ` : '请先选择一台 PC > ';
}

function logTerm(text, opts = {}) {
  const body = document.getElementById('termBody');
  if (opts.cmd) body.innerHTML += `<div class="cmd-line">${opts.cmd}</div>`;
  const div = document.createElement('div');
  if (opts.err) div.className = 'err';
  div.textContent = text;
  body.appendChild(div);
  body.scrollTop = body.scrollHeight;
}

async function runCommand(cmd) {
  const trimmed = cmd.trim();
  if (!trimmed) return;
  logTerm(trimmed, { cmd: true });

  if (trimmed === 'cls' || trimmed === 'clear') {
    document.getElementById('termBody').innerHTML = '';
    return;
  }
  if (trimmed === 'exit') {
    logTerm('👋 再见！');
    return;
  }
  if (!state.selectedPcId) {
    logTerm('⚠️ 请先在右侧下拉框选择一台已上线的 PC，或点击拓扑中的 PC 节点让它上线。', { err: true });
    return;
  }
  try {
    const r = await api('POST', '/exec', { pc_id: state.selectedPcId, command: trimmed });
    logTerm(r.output || '');
    // 状态类命令可能改变 PC 状态（netsh 让 DHCP 上线/下线等）
    if (['online', 'offline'].includes(trimmed.toLowerCase().split(' ')[0])) {
      await loadAll();
    }
  } catch (err) {
    logTerm('错误：' + err.message, { err: true });
  }
}

function setupTerminal() {
  const input = document.getElementById('termInput');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const v = input.value.trim();
      if (v) {
        state.history.push(v);
        state.historyIdx = state.history.length;
        runCommand(v);
      }
      input.value = '';
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (state.historyIdx > 0) {
        state.historyIdx--;
        input.value = state.history[state.historyIdx];
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (state.historyIdx < state.history.length - 1) {
        state.historyIdx++;
        input.value = state.history[state.historyIdx];
      } else {
        state.historyIdx = state.history.length;
        input.value = '';
      }
    }
  });

  document.getElementById('termPcSelect').addEventListener('change', (e) => {
    state.selectedPcId = Number(e.target.value) || null;
    updatePrompt();
  });
}

// ========== 启动 ==========
(async () => {
  await initAuth();
  await loadAll();
  setupTerminal();
  updatePrompt();
  document.getElementById('termInput').focus();

  // 自动让 PC1 上线（演示体验更好）
  const firstOnline = state.pcs.find((p) => p.status === 'online');
  if (!firstOnline) {
    try {
      await api('POST', `/pcs/${state.pcs[0].id}/online`);
      await loadAll();
      logTerm(`✨ 已自动让 "${state.pcs[0].name}" 上线（DHCP 分配 ${state.pcs[0].current_ip}）`);
      logTerm('输入 help 查看可用命令，或试试：ipconfig /all、ping www、nslookup www、tracert 192.168.1.1、arp -a');
    } catch (e) { /* ignore */ }
  } else {
    logTerm(`✅ "${firstOnline.name}" 已在线（${firstOnline.current_ip}）`);
    logTerm('输入 help 查看可用命令');
  }
})();
