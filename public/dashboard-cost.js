/**
 * Cost Monitoring Dashboard Module — v5.0
 * 실시간 토큰 사용량, 비용, 예산 경고 표시
 */
(function () {
  'use strict';
  const REFRESH_MS = 10000;
  let timer = null;

  function init(token) {
    if (!token) return;
    window.__costToken = token;
    fetchAndUpdate();
    timer = setInterval(fetchAndUpdate, REFRESH_MS);
  }

  function destroy() { if (timer) clearInterval(timer); }

  async function fetchAndUpdate() {
    try {
      const [cost, agents] = await Promise.all([
        fetch('/api/cost',       { headers: { Authorization: `Bearer ${window.__costToken}` } }).then(r => r.json()),
        fetch('/api/agents/ai',  { headers: { Authorization: `Bearer ${window.__costToken}` } }).then(r => r.json()),
      ]);
      updateCost(cost);
      updateAgents(agents);
    } catch (e) { console.warn('[CostDashboard]', e.message); }
  }

  function updateCost(data) {
    const total   = data.totalUSD || 0;
    const limit   = data.limitUSD || 10;
    const pct     = Math.min(100, Math.round((total / limit) * 100));
    const remain  = Math.max(0, limit - total);
    setText('cost-total',     `$${total.toFixed(4)}`);
    setText('cost-remaining', `$${remain.toFixed(4)}`);
    setText('cost-percent',   `${pct}%`);
    setText('budget-limit',   `한도: $${limit.toFixed(2)}`);
    const bar = document.getElementById('budget-bar');
    if (bar) { bar.style.width = `${pct}%`; bar.className = `budget-bar ${pct >= 100 ? 'danger' : pct >= 80 ? 'warn' : 'ok'}`; }
    show('cost-warn',   pct >= 80 && pct < 100);
    show('cost-danger', pct >= 100);
    const tbody = document.getElementById('cost-sessions-tbody');
    if (tbody && (data.sessions||[]).length > 0) {
      tbody.innerHTML = data.sessions.slice(-10).reverse().map(s => `<tr><td>${s.session??'—'}</td><td>${s.model?s.model.split('/').pop():'—'}</td><td>$${(s.amount||s.cost||0).toFixed(4)}</td></tr>`).join('');
    }
  }

  function updateAgents(data) {
    const list = document.getElementById('agent-status-list');
    if (!list || !data.agents) return;
    const icons = { architect:'🏗', orchestrator:'🎯', worker:'⚡', designer:'🎨', reviewer:'🔍', tester:'🧪', security:'🛡', fixer:'🔧', integrator:'💾' };
    list.innerHTML = data.agents.map(a => `<div class="agent-row"><span class="dot ${a.status||'idle'}"></span><span>${icons[a.role]||'🤖'} ${a.role}</span><span style="margin-left:auto;color:#475569">${a.modelId?a.modelId.split('/').pop():''}</span>${a.costUSD?`<span style="color:#a78bfa">$${a.costUSD.toFixed(4)}</span>`:''}</div>`).join('');
  }

  function setText(id, v) { const e = document.getElementById(id); if (e) e.textContent = v; }
  function show(id, v)    { const e = document.getElementById(id); if (e) e.style.display = v ? 'inline-block' : 'none'; }

  window.CostDashboard = { init, destroy, refresh: fetchAndUpdate };
})();
