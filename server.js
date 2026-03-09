/**
 * Agent Mission Control Server (v4.0)
 * 자율형 AI 오케스트라 플랫폼 — 독립 프로젝트
 *
 * v3.0 → v4.0 변경사항:
 *   - 실시간 OpenRouter 모델 목록 조회 (회사별 그룹화, 가격 포함) (/api/models)
 *   - 다중 세션 동시 오케스트레이션 (/api/orchestrate — sessions[] 배열 지원)
 *   - 직접 프롬프트 실행 (plan.md 없이 명령만으로) (/api/orchestrate/direct)
 *   - 교육용 코드 리뷰 에이전트 (detailed_review)
 *
 * 실행: node server.js
 * 접속: http://YOUR_SERVER_IP:4000
 */

require('dotenv').config();
const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const jwt        = require('jsonwebtoken');
const path       = require('path');
const fs         = require('fs');
const https      = require('https');
const { spawn, execFile, exec } = require('child_process');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const PORT         = process.env.PORT || 4000;
const PASSWORD     = process.env.DASHBOARD_PASSWORD || 'changeme';
const SECRET       = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const DEFAULT_ROOT = process.env.PROJECT_ROOT || process.cwd();
const EXPIRY       = process.env.TOKEN_EXPIRY || '24h';

// ── 다중 프로젝트 설정 ────────────────────────────────
let projects = [];
let currentProject = { id: 'default', label: path.basename(DEFAULT_ROOT), root: DEFAULT_ROOT };

const projectsFile = path.join(__dirname, 'projects.json');
if (fs.existsSync(projectsFile)) {
  try {
    const data = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
    projects = data.projects || [];
    if (projects.length > 0) currentProject = projects[0];
  } catch (e) {
    console.error('projects.json 파싱 오류:', e.message);
  }
}
if (projects.length === 0) projects = [currentProject];

// ── 사용자 정의 미션 로드 ──────────────────────────────
const customMissionsFile = path.join(__dirname, 'custom-missions.json');
let customMissions = {};
if (fs.existsSync(customMissionsFile)) {
  try {
    customMissions = JSON.parse(fs.readFileSync(customMissionsFile, 'utf8'));
  } catch (e) {
    console.error('custom-missions.json 파싱 오류:', e.message);
  }
}

function saveCustomMissions() {
  fs.writeFileSync(customMissionsFile, JSON.stringify(customMissions, null, 2), 'utf8');
}

// ── 기본 허용 미션 + 사용자 정의 미션 합치기 ───────────
const DEFAULT_MISSIONS = {
  'build':         { label: 'pnpm 빌드', cmd: 'pnpm', args: ['run', 'build'] },
  'git-status':    { label: 'Git 상태', cmd: 'git', args: ['status', '--short'] },
  'git-log':       { label: '최근 커밋 10개', cmd: 'git', args: ['log', '--oneline', '-10'] },
  'git-pull':      { label: 'Git Pull', cmd: 'git', args: ['pull'] },
  'pnpm-install':  { label: 'pnpm install', cmd: 'pnpm', args: ['install'] },
};

function getAllMissions() {
  return { ...DEFAULT_MISSIONS, ...customMissions };
}

// ── 로그인 시도 제한 (brute-force 방지) ────────────────
const loginAttempts = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const data = loginAttempts.get(ip) || { count: 0, resetAt: now + 60000 };
  if (now > data.resetAt) { data.count = 0; data.resetAt = now + 60000; }
  data.count++;
  loginAttempts.set(ip, data);
  return data.count <= 10;
}

// ── 위험 명령어 감지 (경고는 하되 차단하진 않음) ────────
const DANGEROUS_PATTERNS = [
  /\brm\s+-rf\s+\//,
  /\bdd\s+if=/,
  /\bmkfs\b/,
  /\b:(){ :|:& };:/,
  /\bchmod\s+-R\s+777\s+\//,
  /\bshutdown\b/,
  /\breboot\b/,
];

function isDangerous(command) {
  return DANGEROUS_PATTERNS.some(p => p.test(command));
}

// ── 쉘 명령 실행 이력 ──────────────────────────────────
const shellHistory = [];
const MAX_SHELL_HISTORY = 50;

// ── AI 에이전트 상태 (in-memory) ───────────────────────
const agentStates = {};
function getAgentConfig() {
  return {
    architect:    process.env.AGENT_ARCHITECT || 'openai/o3-mini',
    orchestrator: process.env.AGENT_ORCHESTRATOR || 'anthropic/claude-3.5-sonnet',
    worker:       process.env.AGENT_WORKER || 'moonshot/kimi-v1-8k',
    designer:     process.env.AGENT_DESIGNER || 'google/gemini-2.5-pro',
    reviewer:     process.env.AGENT_REVIEWER || 'qwen/qwen-2.5-coder-32b-instruct',
    integrator:   process.env.AGENT_INTEGRATOR || 'anthropic/claude-3.5-sonnet',
  };
}

// ── 비용 추적 (in-memory, 세션별 저장) ─────────────────
let costData = {
  totalUSD: 0,
  limitUSD: parseFloat(process.env.BUDGET_LIMIT_USD || '10'),
  sessions: [],
};

// ── 미들웨어 ──────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  const origin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── API: 로그인 ───────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress;
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: '너무 많은 시도. 1분 후 재시도하세요.' });
  }
  const { password } = req.body;
  if (password !== PASSWORD) {
    return res.status(401).json({ error: '비밀번호가 틀렸습니다.' });
  }
  const token = jwt.sign({ role: 'commander' }, SECRET, { expiresIn: EXPIRY });
  res.json({ token, expiresIn: EXPIRY });
});

// ── API: 프로젝트 관리 ────────────────────────────────
app.get('/api/projects', auth, (req, res) => {
  res.json({ projects, current: currentProject });
});

app.post('/api/projects/switch', auth, (req, res) => {
  const { projectId } = req.body;
  const project = projects.find(p => p.id === projectId);
  if (!project) return res.status(400).json({ error: '알 수 없는 프로젝트' });
  currentProject = project;
  console.log(`[프로젝트 전환] ${project.label} → ${project.root}`);
  res.json({ ok: true, current: currentProject });
});

// ── API: pm2 에이전트 상태 ────────────────────────────
app.get('/api/agents', auth, (req, res) => {
  execFile('pm2', ['jlist'], (err, stdout) => {
    if (err) return res.json({ agents: [] });
    try {
      const list = JSON.parse(stdout);
      const agents = list.map(p => ({
        id: p.pm_id,
        name: p.name,
        status: p.pm2_env?.status || 'unknown',
        memory: Math.round((p.monit?.memory || 0) / 1024 / 1024),
        cpu: p.monit?.cpu || 0,
        uptime: p.pm2_env?.pm_uptime || null,
        restarts: p.pm2_env?.restart_time || 0,
      }));
      res.json({ agents });
    } catch {
      res.json({ agents: [] });
    }
  });
});

// ── API: AI 에이전트 상태 (역할별) ─────────────────────
app.get('/api/agents/ai', auth, (req, res) => {
  const config = getAgentConfig();
  const agents = Object.entries(config).map(([role, modelId]) => ({
    role,
    modelId,
    status: agentStates[role]?.status || 'idle',
    task: agentStates[role]?.task || null,
    progress: agentStates[role]?.progress || 0,
    tokensUsed: agentStates[role]?.tokensUsed || 0,
    costUSD: agentStates[role]?.costUSD || 0,
  }));
  res.json({ agents, budget: costData });
});

// ── API: 전체 상태 ────────────────────────────────────
app.get('/api/status', auth, (req, res) => {
  const PROJ = currentProject.root;
  const status = {
    serverTime: new Date().toISOString(),
    projectRoot: PROJ,
    currentProject,
    build: null, todo: null, logs: [],
    missions: Object.entries(getAllMissions()).map(([id, m]) => ({ id, label: m.label })),
    budget: costData,
  };

  try {
    const buildFile = path.join(PROJ, '.agents', 'logs', 'last-build-status.json');
    if (fs.existsSync(buildFile)) status.build = JSON.parse(fs.readFileSync(buildFile, 'utf8'));
  } catch {}

  try {
    const todoFile = path.join(PROJ, 'todo.md');
    if (fs.existsSync(todoFile)) {
      const content = fs.readFileSync(todoFile, 'utf8');
      const total   = (content.match(/^- \[[ x~]\]/gm) || []).length;
      const done    = (content.match(/^- \[x\]/gm) || []).length;
      const partial = (content.match(/^- \[~\]/gm) || []).length;
      status.todo = { total, done, partial, progress: total > 0 ? Math.round(done / total * 100) : 0 };
    }
  } catch {}

  try {
    const logDir = path.join(PROJ, '.agents', 'logs');
    if (fs.existsSync(logDir)) {
      status.logs = fs.readdirSync(logDir).filter(f => f.endsWith('.log') || f.endsWith('.json')).slice(0, 8);
    }
  } catch {}

  res.json(status);
});

// ── API: 미션 관리 및 실행 ────────────────────────────
const runningJobs = new Map();

app.post('/api/mission/run', auth, (req, res) => {
  const { missionId } = req.body;
  const MISSIONS = getAllMissions();
  const mission = MISSIONS[missionId];
  if (!mission) return res.status(400).json({ error: `알 수 없는 미션: ${missionId}` });
  if (runningJobs.has(missionId)) return res.status(409).json({ error: '이미 실행 중입니다.' });

  const jobId = `${missionId}-${Date.now()}`;
  res.json({ jobId, missionId, label: mission.label, status: 'started' });

  const proc = spawn(mission.cmd, mission.args, {
    cwd: currentProject.root,
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  runningJobs.set(missionId, proc);

  const broadcast = (data, type = 'log') => {
    const msg = JSON.stringify({ jobId, missionId, type, data: String(data) });
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    });
  };

  broadcast(`🚀 [${mission.label}] 시작 — ${currentProject.label}`, 'start');
  proc.stdout.on('data', d => broadcast(d));
  proc.stderr.on('data', d => broadcast(d, 'stderr'));
  proc.on('close', code => {
    runningJobs.delete(missionId);
    broadcast(code === 0 ? `✅ [${mission.label}] 완료` : `❌ [${mission.label}] 실패 (exit ${code})`,
      code === 0 ? 'success' : 'error');
  });
  proc.on('error', err => {
    runningJobs.delete(missionId);
    broadcast(`❌ 실행 오류: ${err.message}`, 'error');
  });
});

app.post('/api/mission/kill', auth, (req, res) => {
  const { missionId } = req.body;
  const proc = runningJobs.get(missionId);
  if (!proc) return res.status(404).json({ error: '실행 중인 미션 없음' });
  proc.kill('SIGTERM');
  runningJobs.delete(missionId);
  res.json({ ok: true });
});

// ── API: 사용자 정의 미션 CRUD ────────────────────────
app.get('/api/missions/custom', auth, (req, res) => {
  res.json({ missions: customMissions });
});

app.post('/api/missions/custom', auth, (req, res) => {
  const { id, label, command } = req.body;
  if (!id || !label || !command) return res.status(400).json({ error: 'id, label, command 필수' });
  const parts = command.split(' ');
  customMissions[id] = { label, cmd: parts[0], args: parts.slice(1) };
  saveCustomMissions();
  res.json({ ok: true, missions: customMissions });
});

app.delete('/api/missions/custom/:id', auth, (req, res) => {
  delete customMissions[req.params.id];
  saveCustomMissions();
  res.json({ ok: true, missions: customMissions });
});

// ── API: 임의 쉘 명령 실행 (v3.0 신규) ────────────────
app.post('/api/shell', auth, (req, res) => {
  const { command, cwd } = req.body;
  if (!command) return res.status(400).json({ error: 'command 필수' });

  const dangerous = isDangerous(command);
  const execDir = cwd || currentProject.root;
  const jobId = `shell-${Date.now()}`;

  // 이력 저장
  shellHistory.unshift({ id: jobId, command, cwd: execDir, dangerous, timestamp: new Date().toISOString() });
  if (shellHistory.length > MAX_SHELL_HISTORY) shellHistory.pop();

  res.json({ jobId, command, dangerous, status: 'started' });

  const proc = exec(command, { cwd: execDir, env: { ...process.env, FORCE_COLOR: '0' }, timeout: 120000 });

  const broadcast = (data, type = 'log') => {
    const msg = JSON.stringify({ jobId, type, data: String(data), source: 'shell' });
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    });
  };

  if (dangerous) broadcast(`⚠️ 위험한 명령어 감지: ${command}`, 'warning');
  broadcast(`$ ${command}`, 'start');

  proc.stdout.on('data', d => broadcast(d));
  proc.stderr.on('data', d => broadcast(d, 'stderr'));
  proc.on('close', code => {
    broadcast(code === 0 ? `✅ 완료 (exit 0)` : `❌ 실패 (exit ${code})`, code === 0 ? 'success' : 'error');
  });
  proc.on('error', err => {
    broadcast(`❌ 실행 오류: ${err.message}`, 'error');
  });
});

app.get('/api/shell/history', auth, (req, res) => {
  res.json({ history: shellHistory });
});

// ── API: 비용 추적 ────────────────────────────────────
app.get('/api/cost', auth, (req, res) => {
  res.json(costData);
});

app.post('/api/cost/update', auth, (req, res) => {
  const { amount, session, model } = req.body;
  if (typeof amount !== 'number') return res.status(400).json({ error: 'amount(number) 필수' });
  costData.totalUSD += amount;
  costData.sessions.push({ amount, model, session, timestamp: new Date().toISOString() });

  // 예산 초과 체크
  if (costData.totalUSD >= costData.limitUSD) {
    const msg = JSON.stringify({ type: 'budget_exceeded', data: `🛑 예산 한도 $${costData.limitUSD} 초과! 전체 비용: $${costData.totalUSD.toFixed(2)}` });
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    });
  }

  res.json({ ok: true, costData });
});

app.post('/api/cost/reset', auth, (req, res) => {
  const newLimit = req.body.limitUSD;
  costData = {
    totalUSD: 0,
    limitUSD: newLimit || costData.limitUSD,
    sessions: [],
  };
  res.json({ ok: true, costData });
});

// ── API: 로그 파일 ────────────────────────────────────
app.get('/api/logs/:filename', auth, (req, res) => {
  const PROJ = currentProject.root;
  const filename = path.basename(req.params.filename);
  const logPath  = path.join(PROJ, '.agents', 'logs', filename);
  if (!fs.existsSync(logPath)) return res.status(404).json({ error: '파일 없음' });
  const content = fs.readFileSync(logPath, 'utf8');
  res.json({ filename, content: content.slice(-5000) });
});

// ── API: 긴급 정지 (Kill Switch) ──────────────────────
app.post('/api/emergency-stop', auth, (req, res) => {
  // 실행 중인 모든 작업 중지
  for (const [id, proc] of runningJobs.entries()) {
    proc.kill('SIGTERM');
    runningJobs.delete(id);
  }

  // 모든 AI 에이전트 상태를 stopped으로
  for (const role of Object.keys(agentStates)) {
    agentStates[role] = { status: 'stopped', task: null, progress: 0 };
  }

  const msg = JSON.stringify({ type: 'emergency_stop', data: '🛑 긴급 정지! 모든 작업이 중단되었습니다.' });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });

  console.log('🛑 [긴급 정지] 모든 작업 중단됨');
  res.json({ ok: true, message: '모든 작업이 중단되었습니다.' });
});

// ── WebSocket: 실시간 로그 스트림 ─────────────────────
wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  try {
    jwt.verify(token, SECRET);
  } catch {
    ws.send(JSON.stringify({ type: 'error', data: 'Unauthorized' }));
    ws.close(4001, 'Unauthorized');
    return;
  }

  ws.send(JSON.stringify({ type: 'connected', data: '✅ Mission Control v3.0 연결됨' }));

  const logFile = path.join(currentProject.root, '.agents', 'logs', 'build-sentinel.log');
  if (fs.existsSync(logFile)) {
    const recent = fs.readFileSync(logFile, 'utf8').split('\n').slice(-20).join('\n');
    ws.send(JSON.stringify({ type: 'history', data: recent }));
  }
});

// ── API: plan.md 관리 ──────────────────────────────────
app.get('/api/plan', auth, (req, res) => {
  const planPath = path.join(currentProject.root, 'plan.md');
  if (!fs.existsSync(planPath)) {
    return res.json({ exists: false, content: '', sessions: [] });
  }
  try {
    const content = fs.readFileSync(planPath, 'utf8');
    // 세션 목록 파싱 (간단한 ## 헤더 추출)
    const sessions = [];
    const lines = content.split('\n');
    lines.forEach((line, i) => {
      const m = line.match(/^## (.+)/);
      if (m) {
        const numMatch = m[1].match(/^Session\s+(\d+)/i) || m[1].match(/^(\d+)/);
        sessions.push({
          number: numMatch ? parseInt(numMatch[1]) : sessions.length + 1,
          title: m[1].trim(),
          line: i + 1,
        });
      }
    });
    res.json({ exists: true, content, sessions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/plan', auth, (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'content 필수' });
  const planPath = path.join(currentProject.root, 'plan.md');
  fs.writeFileSync(planPath, content, 'utf8');
  res.json({ ok: true, path: planPath });
});

// ── API: AI 에이전트 설정 변경 ─────────────────────────
app.get('/api/agents/config', auth, (req, res) => {
  res.json({ config: getAgentConfig() });
});

app.post('/api/agents/config', auth, (req, res) => {
  const { role, modelId } = req.body;
  if (!role || !modelId) return res.status(400).json({ error: 'role, modelId 필수' });
  const envKey = `AGENT_${role.toUpperCase()}`;
  process.env[envKey] = modelId;
  agentStates[role] = { ...(agentStates[role] || {}), modelId };
  res.json({ ok: true, config: getAgentConfig() });
});

const MODEL_PRIORITY = {
  'openai':      { label: 'OpenAI',          emoji: '🤖', keys: ['openai/gpt-', 'openai/o1', 'openai/o3'] },
  'anthropic':   { label: 'Anthropic',       emoji: '🧠', keys: ['anthropic/claude'] },
  'google':      { label: 'Google',          emoji: '✨', keys: ['google/gemini'] },
  'deepseek':    { label: 'DeepSeek',        emoji: '🔬', keys: ['deepseek/'] },
  'qwen':        { label: 'Qwen (Alibaba)',  emoji: '🐉', keys: ['qwen/'] },
  'moonshot':    { label: 'Moonshot (Kimi)', emoji: '🌙', keys: ['moonshot/'] },
  'meta-llama':  { label: 'Meta Llama',      emoji: '🦙', keys: ['meta-llama/'] },
  'mistralai':   { label: 'Mistral',         emoji: '💨', keys: ['mistralai/'] },
};

// 실시간 모델 목록 캐시
let cachedModels = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5분

async function fetchAndCacheModels() {
  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return null;
    const data = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'openrouter.ai',
        path: '/api/v1/models',
        method: 'GET',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      };
      const reqH = https.request(options, (resp) => {
        let body = '';
        resp.on('data', chunk => body += chunk);
        resp.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
      });
      reqH.on('error', reject);
      reqH.end();
    });

    const allModels = data.data || [];
    const grouped = {};
    for (const [groupKey, groupInfo] of Object.entries(MODEL_PRIORITY)) {
      const matching = allModels
        .filter(m => groupInfo.keys.some(k => m.id.startsWith(k)))
        .map(m => ({
          id: m.id,
          name: m.name,
          inputPrice:  ((m.pricing?.prompt  || 0) * 1_000_000).toFixed(3),
          outputPrice: ((m.pricing?.completion || 0) * 1_000_000).toFixed(3),
          contextLength: m.context_length || 0,
        }))
        .sort((a, b) => parseFloat(b.outputPrice) - parseFloat(a.outputPrice))
        .slice(0, 5); // 상위 5개

      if (matching.length > 0) {
        grouped[groupKey] = { label: `${groupInfo.emoji} ${groupInfo.label}`, models: matching };
      }
    }

    cachedModels = { grouped, totalModels: allModels.length, cachedAt: new Date().toISOString() };
    cacheTime = Date.now();
    console.log(`[models] ✅ OpenRouter 모델 캐시 갱신 — 총 ${allModels.length}개`);
    return cachedModels;
  } catch (err) {
    console.warn('[models] ⚠️ OpenRouter 조회 실패, 폴백 사용:', err.message);
    return null;
  }
}

// 서버 시작 시 즉시 모델 캐시 프리워밍
setTimeout(fetchAndCacheModels, 3000);
// 5분마다 갱신
setInterval(fetchAndCacheModels, CACHE_TTL);

// 폴백 모델 목록 (실제 유효한 OpenRouter ID 사용)
const FALLBACK_MODELS = {
  grouped: {
    openai: { label: '🤖 OpenAI', models: [
      { id: 'openai/gpt-4o',              name: 'GPT-4o',          inputPrice: '2.500', outputPrice: '10.000' },
      { id: 'openai/gpt-4o-mini',         name: 'GPT-4o mini',     inputPrice: '0.150', outputPrice: '0.600' },
      { id: 'openai/o3-mini',             name: 'o3 mini',         inputPrice: '1.100', outputPrice: '4.400' },
      { id: 'openai/o1',                  name: 'o1',              inputPrice: '15.000', outputPrice: '60.000' },
      { id: 'openai/gpt-4.1',             name: 'GPT-4.1',         inputPrice: '2.000', outputPrice: '8.000' },
    ]},
    anthropic: { label: '🧠 Anthropic', models: [
      { id: 'anthropic/claude-opus-4',       name: 'Claude Opus 4',     inputPrice: '15.000', outputPrice: '75.000' },
      { id: 'anthropic/claude-sonnet-4',     name: 'Claude Sonnet 4',   inputPrice: '3.000', outputPrice: '15.000' },
      { id: 'anthropic/claude-3.5-haiku',    name: 'Claude 3.5 Haiku',  inputPrice: '0.800', outputPrice: '4.000' },
      { id: 'anthropic/claude-3.5-sonnet',   name: 'Claude 3.5 Sonnet', inputPrice: '3.000', outputPrice: '15.000' },
      { id: 'anthropic/claude-3.7-sonnet',   name: 'Claude 3.7 Sonnet', inputPrice: '3.000', outputPrice: '15.000' },
    ]},
    google: { label: '✨ Google', models: [
      { id: 'google/gemini-2.5-pro-preview', name: 'Gemini 2.5 Pro Preview', inputPrice: '1.250', outputPrice: '10.000' },
      { id: 'google/gemini-2.0-flash-001',   name: 'Gemini 2.0 Flash',       inputPrice: '0.100', outputPrice: '0.400' },
      { id: 'google/gemini-2.5-flash-preview', name: 'Gemini 2.5 Flash',     inputPrice: '0.150', outputPrice: '0.600' },
      { id: 'google/gemini-pro-1.5',          name: 'Gemini 1.5 Pro',        inputPrice: '1.250', outputPrice: '5.000' },
      { id: 'google/gemini-flash-1.5',        name: 'Gemini 1.5 Flash',      inputPrice: '0.075', outputPrice: '0.300' },
    ]},
    deepseek: { label: '🔬 DeepSeek', models: [
      { id: 'deepseek/deepseek-r1',          name: 'DeepSeek R1',       inputPrice: '0.550', outputPrice: '2.190' },
      { id: 'deepseek/deepseek-chat',        name: 'DeepSeek V3',       inputPrice: '0.270', outputPrice: '1.100' },
      { id: 'deepseek/deepseek-r1-zero',     name: 'DeepSeek R1 Zero',  inputPrice: '0.550', outputPrice: '2.190' },
      { id: 'deepseek/deepseek-prover-v2',   name: 'DeepSeek Prover V2', inputPrice: '0.550', outputPrice: '2.190' },
      { id: 'deepseek/deepseek-r1-distill-qwen-32b', name: 'R1 Distill Qwen 32B', inputPrice: '0.120', outputPrice: '0.180' },
    ]},
    qwen: { label: '🐉 Qwen', models: [
      { id: 'qwen/qwen3-235b-a22b',          name: 'Qwen3 235B A22B',    inputPrice: '0.140', outputPrice: '0.600' },
      { id: 'qwen/qwq-32b',                  name: 'QwQ 32B',           inputPrice: '0.100', outputPrice: '0.400' },
      { id: 'qwen/qwen-2.5-coder-32b-instruct', name: 'Qwen2.5 Coder 32B', inputPrice: '0.070', outputPrice: '0.160' },
      { id: 'qwen/qwen-max',                 name: 'Qwen Max',          inputPrice: '1.600', outputPrice: '6.400' },
      { id: 'qwen/qwen-2.5-72b-instruct',    name: 'Qwen2.5 72B',       inputPrice: '0.130', outputPrice: '0.400' },
    ]},
    moonshot: { label: '🌙 Moonshot (Kimi)', models: [
      { id: 'moonshot/kimi-k2',              name: 'Kimi K2',           inputPrice: '0.600', outputPrice: '2.500' },
      { id: 'moonshot/kimi-v1-5-8k',         name: 'Kimi v1.5 8K',      inputPrice: '0.100', outputPrice: '0.300' },
      { id: 'moonshot/kimi-v1-5-32k',        name: 'Kimi v1.5 32K',     inputPrice: '0.150', outputPrice: '0.450' },
      { id: 'moonshot/kimi-v1-8k',           name: 'Kimi v1 8K',        inputPrice: '0.140', outputPrice: '0.590' },
      { id: 'moonshot/kimi-v1-128k',         name: 'Kimi v1 128K',      inputPrice: '0.500', outputPrice: '1.500' },
    ]},
  },
  totalModels: 0,
  cachedAt: new Date().toISOString(),
  fallback: true,
};

app.get('/api/models', auth, async (req, res) => {
  const forceRefresh = req.query.refresh === '1';
  const now = Date.now();
  if (!forceRefresh && cachedModels && (now - cacheTime < CACHE_TTL)) {
    return res.json(cachedModels);
  }
  const result = await fetchAndCacheModels();
  res.json(result || FALLBACK_MODELS);
});

// ── API: 오케스트레이터 실행 (v4.0 — 다중 세션 지원) ────
let activeOrchestration = null;

app.post('/api/orchestrate', auth, async (req, res) => {
  // v4.0: sessions 배열 또는 단일 sessionNumber 모두 지원
  const { sessionNumber, sessions, planPath: customPlanPath } = req.body;
  const sessionList = sessions
    ? (Array.isArray(sessions) ? sessions : [sessions]).map(Number)
    : sessionNumber ? [parseInt(sessionNumber)] : null;

  if (!sessionList || sessionList.length === 0) {
    return res.status(400).json({ error: 'sessions[] 또는 sessionNumber 필수' });
  }
  if (activeOrchestration) return res.status(409).json({ error: '이미 오케스트레이션이 실행 중입니다.' });

  const planPath = customPlanPath || path.join(currentProject.root, 'plan.md');
  if (!fs.existsSync(planPath)) {
    return res.status(404).json({ error: `plan.md 없음: ${planPath}` });
  }

  res.json({ ok: true, sessions: sessionList, planPath, status: 'started', message: `📋 ${sessionList.length}개 세션 오케스트레이터가 시작되었습니다.` });

  const broadcast = (msg, type = 'log') => {
    const payload = JSON.stringify({ type, data: String(msg), source: 'orchestrator' });
    wss.clients.forEach(c => {
      if (c.readyState === WebSocket.OPEN) c.send(payload);
    });
  };

  const setAgentState = (role, state) => {
    agentStates[role] = { ...(agentStates[role] || {}), ...state };
  };

  activeOrchestration = { sessions: sessionList, startedAt: Date.now() };

  try {
    for (const role of ['architect', 'orchestrator', 'worker', 'designer', 'reviewer', 'integrator']) {
      setAgentState(role, { status: 'idle', task: null, progress: 0 });
    }
    broadcast(`🛰 오케스트레이터 v4.0 시작 — ${sessionList.length}개 세션: [${sessionList.join(', ')}]`, 'start');

    const { run } = require('./orchestrator/index');
    let totalCost = 0;

    // 다중 세션을 순차 실행
    for (const sNum of sessionList) {
      broadcast(`\n${'━'.repeat(30)}\n📋 Session ${sNum} 시작...\n${'━'.repeat(30)}`, 'system');
      setAgentState('architect', { status: 'running', task: `Session ${sNum} 구조 설계 중...`, progress: 10 });

      const result = await run({
        planPath,
        sessionNumber: sNum,
        projectRoot: currentProject.root,
        broadcast,
        onAgentStart: (role, task) => setAgentState(role, { status: 'running', task, progress: 20 }),
        onAgentDone:  (role, cost) => setAgentState(role, { status: 'idle', task: '완료', progress: 100, costUSD: (agentStates[role]?.costUSD || 0) + cost }),
      });

      if (result.cost) {
        totalCost += result.cost.totalUSD || 0;
        costData.totalUSD += result.cost.totalUSD || 0;
        costData.sessions.push({ session: sNum, cost: result.cost.totalUSD, timestamp: new Date().toISOString() });
      }
      broadcast(`✅ Session ${sNum} 완료!`, 'success');
    }
    broadcast(`\n🎉 전체 ${sessionList.length}개 세션 완료! 총 비용: $${totalCost.toFixed(4)}`, 'success');
  } catch (err) {
    broadcast(`❌ 오케스트레이터 오류: ${err.message}`, 'error');
  } finally {
    activeOrchestration = null;
    for (const role of Object.keys(agentStates)) {
      if (agentStates[role]?.status === 'running') setAgentState(role, { status: 'idle', task: null });
    }
  }
});

// ── API: 직접 프롬프트 실행 (v4.0 신규) ────────────────
app.post('/api/orchestrate/direct', auth, async (req, res) => {
  const { prompt, taskTitle } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt 필수' });
  if (activeOrchestration) return res.status(409).json({ error: '이미 오케스트레이션이 실행 중입니다.' });

  res.json({ ok: true, status: 'started', message: '🚀 직접 프롬프트 모드로 오케스트레이터가 시작되었습니다.' });

  const broadcast = (msg, type = 'log') => {
    const payload = JSON.stringify({ type, data: String(msg), source: 'orchestrator' });
    wss.clients.forEach(c => {
      if (c.readyState === WebSocket.OPEN) c.send(payload);
    });
  };

  const setAgentState = (role, state) => {
    agentStates[role] = { ...(agentStates[role] || {}), ...state };
  };

  activeOrchestration = { directPrompt: true, startedAt: Date.now() };

  try {
    for (const role of ['architect', 'orchestrator', 'worker', 'designer', 'reviewer', 'integrator']) {
      setAgentState(role, { status: 'idle', task: null, progress: 0 });
    }
    broadcast(`🚀 직접 프롬프트 실행 시작`, 'start');
    broadcast(`📝 명령: ${prompt}`, 'system');

    // 가상 세션 객체를 직접 생성하여 오케스트레이터에 주입
    const { runDirect } = require('./orchestrator/index');
    const result = await runDirect({
      prompt,
      taskTitle: taskTitle || '직접 명령 태스크',
      projectRoot: currentProject.root,
      broadcast,
      onAgentStart: (role, task) => setAgentState(role, { status: 'running', task, progress: 20 }),
      onAgentDone:  (role, cost) => setAgentState(role, { status: 'idle', task: '완료', progress: 100, costUSD: (agentStates[role]?.costUSD || 0) + cost }),
    });

    if (result?.cost) {
      costData.totalUSD += result.cost.totalUSD || 0;
      costData.sessions.push({ session: 'direct', prompt: prompt.slice(0, 80), cost: result.cost.totalUSD, timestamp: new Date().toISOString() });
    }
    broadcast(`✅ 직접 프롬프트 실행 완료! 비용: $${result?.cost?.totalUSD?.toFixed(4) || '0.0000'}`, 'success');
  } catch (err) {
    broadcast(`❌ 직접 프롬프트 실행 오류: ${err.message}`, 'error');
  } finally {
    activeOrchestration = null;
    for (const role of Object.keys(agentStates)) {
      if (agentStates[role]?.status === 'running') setAgentState(role, { status: 'idle', task: null });
    }
  }
});

app.get('/api/orchestrate/status', auth, (req, res) => {
  res.json({
    active: !!activeOrchestration,
    ...activeOrchestration,
    agents: Object.entries(agentStates).map(([role, s]) => ({ role, ...s })),
    cost: costData,
  });
});

// ── 루트: 대시보드 HTML ───────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ── 서버 시작 ─────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🛰  Agent Mission Control Server v4.0`);
  console.log(`   접속 주소: http://0.0.0.0:${PORT}`);
  console.log(`   현재 프로젝트: ${currentProject.label} (${currentProject.root}`);
  console.log(`   ✅ v4.0: 실시간 모델 동기화, 다중 세션, 직접 프롬프트 지원`);
  console.log(`   전체 프로젝트: ${projects.map(p => p.label).join(', ')}`);
  console.log(`   기본 미션: ${Object.keys(DEFAULT_MISSIONS).join(', ')}`);
  console.log(`   사용자 정의 미션: ${Object.keys(customMissions).length}개`);
  console.log(`   예산 한도: $${costData.limitUSD}`);
  console.log(`   AI 에이전트 구성:`);
  const config = getAgentConfig();
  for (const [role, model] of Object.entries(config)) {
    console.log(`     ${role}: ${model}`);
  }
  console.log(`\n   ⚠️  .env 파일에서 DASHBOARD_PASSWORD 반드시 변경하세요!\n`);
});
