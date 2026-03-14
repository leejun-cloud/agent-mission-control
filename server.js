/**
 * Agent Mission Control Server (v5.0)
 * 자율형 AI 오케스트라 플랫폼 — 독립 프로젝트
 *
 * v3.0 → v4.1 변경사항:
 *   - 실시간 OpenRouter 모델 목록 조회 (회사별 그룹화, 가격 포함) (/api/models)
 *   - 다중 세션 동시 오케스트레이션 (/api/orchestrate — sessions[] 배열 지원)
 *   - 직접 프롬프트 실행 (plan.md 없이 명령만으로) (/api/orchestrate/direct)
 *   - 교육용 코드 리뷰 에이전트 (detailed_review)
 *   - 각 회사별 상위 10개 모델 확장 (v4.1)
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
const { spawn, execFile, exec, execSync } = require('child_process');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const PORT         = process.env.PORT || 4000;
const PASSWORD     = process.env.DASHBOARD_PASSWORD || 'changeme';
const DEFAULT_ROOT = process.env.PROJECT_ROOT || process.cwd();
const EXPIRY       = process.env.TOKEN_EXPIRY || '24h';

if (!process.env.JWT_SECRET) {
  console.error('⚠️  [SECURITY] JWT_SECRET 미설정 — .env에 강한 값을 반드시 설정하세요!');
}
const SECRET = process.env.JWT_SECRET || 'dev-secret-CHANGE-THIS-IN-PRODUCTION';

// ── 다중 프로젝트 설정 ────────────────────────────────
let projects = [];
let currentProject = { id: 'default', label: path.basename(DEFAULT_ROOT), root: DEFAULT_ROOT };

const projectsFile = path.join(__dirname, 'projects.json');
if (fs.existsSync(projectsFile)) {
  try {
    const data = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
    projects = data.projects || [];
    if (projects.length > 0) currentProject = projects[projects.length - 1];
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

// ── 위험 명령어 패턴 (SHELL_BLOCK_DANGEROUS=true 시 차단) ────
const DANGEROUS_PATTERNS = [
  /\brm\s+-rf\s+\//,
  /\bdd\s+if=/,
  /\bmkfs\b/,
  /\b:\(\)\s*\{/,
  /\bchmod\s+-R\s+777\s+\//,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bcurl\b.*\|\s*(ba)?sh/,
  /\bwget\b.*-O\s*-\s*\|/,
];

const BLOCK_DANGEROUS = process.env.SHELL_BLOCK_DANGEROUS !== 'false'; // 기본 ON

function isDangerous(command) {
  return DANGEROUS_PATTERNS.some(p => p.test(command));
}

// 커스텀 미션 명령어 허용 문자 검증
const SAFE_CMD_PATTERN = /^[a-zA-Z0-9_.\/\-]+$/;
function isSafeCommand(cmd) {
  return SAFE_CMD_PATTERN.test(cmd);
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
  if (origin === '*' && process.env.NODE_ENV === 'production') {
    console.warn('⚠️  [SECURITY] ALLOWED_ORIGIN=* in production. Set a specific origin in .env');
  }
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

app.post('/api/projects/import', auth, (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url 필수' });

  try {
    const rawUrl = url.trim();
    const repoMatch = rawUrl.match(/\/([^\/]+)(?:\.git)?$/);
    if (!repoMatch) return res.status(400).json({ error: '유효하지 않은 GitHub URL입니다.' });

    const repoName = repoMatch[1].replace('.git', '');
    const parentDir = path.dirname(DEFAULT_ROOT); // Workspace 기본 디렉토리
    const targetDir = path.join(parentDir, repoName);

    if (fs.existsSync(targetDir)) {
      return res.status(409).json({ error: `디렉토리가 이미 존재합니다: ${targetDir}` });
    }

    // Git Clone 실행
    console.log(`[프로젝트 가져오기] git clone ${rawUrl} -> ${targetDir}`);
    execSync(`git clone ${rawUrl} "${targetDir}"`, { stdio: 'inherit' });

    // 새 프로젝트 등록
    const newProject = {
      id: repoName.toLowerCase(),
      label: repoName,
      root: targetDir
    };

    // 중복 ID 방지 (만약 같은 이름 저장소를 또 임포트 시도할 경우, 이미 위에서 차단됨)
    projects.push(newProject);
    fs.writeFileSync(projectsFile, JSON.stringify({ projects }, null, 2), 'utf8');

    // 새로 임포트한 프로젝트로 바로 전환
    currentProject = newProject;
    console.log(`[프로젝트 가져오기 완료] ${newProject.label} 자동 전환됨`);

    res.json({ ok: true, project: newProject });
  } catch (err) {
    console.error('[프로젝트 가져오기 오류]', err);
    res.status(500).json({ error: err.message });
  }
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
  const parts = command.trim().split(/\s+/);
  if (!isSafeCommand(parts[0])) {
    return res.status(400).json({ error: `허용되지 않는 명령어: ${parts[0]}` });
  }
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

  // 위험 명령어 차단 (기본 ON)
  if (dangerous && BLOCK_DANGEROUS) {
    shellHistory.unshift({ id: jobId, command, cwd: execDir, dangerous, blocked: true, timestamp: new Date().toISOString() });
    if (shellHistory.length > MAX_SHELL_HISTORY) shellHistory.pop();
    return res.status(403).json({ error: `🛑 위험한 명령어가 차단되었습니다: ${command}` });
  }

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

// ── API: 감사 로그 (구조화된 JSONL) ──────────────────
app.get('/api/logs/audit/entries', auth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '200'), 500);
  const stage = req.query.stage || null;
  const logger = require('./orchestrator/logger');
  let entries = logger.readRecent(limit);
  if (stage) entries = entries.filter(e => e.stage === stage);
  res.json({ entries, total: entries.length });
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

  ws.send(JSON.stringify({ type: 'connected', data: '✅ Mission Control v5.0 연결됨' }));

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

// ── API: AI 세션 블록 생성 (미리보기, append 안 함) ────
app.post('/api/plan/generate', auth, async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt 필수' });
  const planPath = path.join(currentProject.root, 'plan.md');
  try {
    const { generateSessionBlock } = require('./orchestrator/plan-generator');
    const result = await generateSessionBlock(prompt, planPath);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[plan/generate]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── API: 생성된 세션 블록 plan.md에 append ─────────────
app.post('/api/plan/append', auth, (req, res) => {
  const { sessionBlock } = req.body;
  if (!sessionBlock) return res.status(400).json({ error: 'sessionBlock 필수' });
  const planPath = path.join(currentProject.root, 'plan.md');
  try {
    const { appendSessionToPlan } = require('./orchestrator/plan-generator');
    appendSessionToPlan(planPath, sessionBlock);
    // 추가 후 세션 목록 반환 (UI 자동 갱신용)
    const content = fs.readFileSync(planPath, 'utf8');
    const sessions = [];
    content.split('\n').forEach((line, i) => {
      const m = line.match(/^## (.+)/);
      if (m) {
        const numMatch = m[1].match(/^Session\s+(\d+)/i) || m[1].match(/^(\d+)/);
        sessions.push({ number: numMatch ? parseInt(numMatch[1]) : sessions.length + 1, title: m[1].trim(), line: i + 1 });
      }
    });
    res.json({ ok: true, sessions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
  'openai':      { label: 'OpenAI',          emoji: '🤖', preferred: [
    'openai/o3-mini', 'openai/o1', 'openai/gpt-4o', 'openai/gpt-4o-mini', 'openai/gpt-4-turbo', 'openai/o1-mini', 'openai/o1-preview', 'openai/gpt-4', 'openai/gpt-4-0314', 'openai/gpt-3.5-turbo'
  ] },
  'anthropic':   { label: 'Anthropic',       emoji: '🧠', preferred: [
    'anthropic/claude-3.7-sonnet', 'anthropic/claude-3.5-sonnet', 'anthropic/claude-3.5-haiku', 'anthropic/claude-3-opus', 'anthropic/claude-3-sonnet', 'anthropic/claude-3-haiku', 'anthropic/claude-2.1', 'anthropic/claude-2.0', 'anthropic/claude-instant-1.2', 'anthropic/claude-3-opus:beta'
  ] },
  'google':      { label: 'Google',          emoji: '✨', preferred: [
    'google/gemini-2.0-pro-exp-02-05', 'google/gemini-2.0-flash-001', 'google/gemini-pro-1.5', 'google/gemini-flash-1.5', 'google/gemini-2.0-flash-lite-preview-02-05', 'google/gemini-pro', 'google/gemini-flash', 'google/gemini-1.0-pro', 'google/palm-2-chat-bison', 'google/palm-2-code-chat-bison'
  ] },
  'deepseek':    { label: 'DeepSeek',        emoji: '🔬', preferred: [
    'deepseek/deepseek-r1', 'deepseek/deepseek-chat', 'deepseek/deepseek-v3', 'deepseek/deepseek-r1-distill-llama-70b', 'deepseek/deepseek-r1-distill-qwen-32b', 'deepseek/deepseek-r1-distill-llama-8b', 'deepseek/deepseek-coder'
  ] },
  'qwen':        { label: 'Qwen (Alibaba)',  emoji: '🐉', preferred: [
    'qwen/qwen-max', 'qwen/qwen-plus', 'qwen/qwen-2.5-coder-32b-instruct', 'qwen/qwen-2.5-72b-instruct', 'qwen/qwq-32b', 'qwen/qwen-2.5-coder-7b-instruct', 'qwen/qwen-2-72b-instruct'
  ] },
  'moonshot':    { label: 'Moonshot (Kimi)', emoji: '🌙', preferred: [
    'moonshot/kimi-2.5', 'moonshot/kimi-v1-128k', 'moonshot/kimi-v1-32k', 'moonshot/kimi-v1-8k'
  ] },
  'meta':        { label: 'Meta (Llama)',    emoji: '🦙', preferred: [
    'meta-llama/llama-3.3-70b-instruct', 'meta-llama/llama-3.1-405b-instruct', 'meta-llama/llama-3.1-70b-instruct', 'meta-llama/llama-3.1-8b-instruct', 'meta-llama/llama-3.2-3b-instruct', 'meta-llama/llama-3-70b-instruct', 'meta-llama/llama-guard-3-8b'
  ] },
  'mistral':     { label: 'Mistral',         emoji: '🌪', preferred: [
    'mistralai/mistral-large', 'mistralai/mixtral-8x22b-instruct', 'mistralai/mistral-nemo', 'mistralai/pixtral-12b', 'mistralai/mistral-7b-instruct'
  ] },
  'zhipu':       { label: 'Zhipu (GLM)',     emoji: '🐼', preferred: [
    'zhipu/glm-4-plus', 'zhipu/glm-4-flash', 'zhipu/glm-4-0520', 'zhipu/glm-4-9b'
  ] },
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
      // Create a specific matching array based purely on preferred list ordering
      const matched = [];
      for (const pref of groupInfo.preferred) {
        // Find exact or 'startswith' (to cover previews/betas if exactly named) within allModels
        const found = allModels.find(m => m.id === pref || m.id === `${pref}:free` || m.id.startsWith(pref));
        if (found && !matched.some(m => m.id === found.id)) {
          matched.push(found);
        }
      }
      
      const matching = matched
        .map(m => ({
          id: m.id,
          name: m.name,
          inputPrice:  ((m.pricing?.prompt  || 0) * 1_000_000).toFixed(3),
          outputPrice: ((m.pricing?.completion || 0) * 1_000_000).toFixed(3),
          contextLength: m.context_length || 0,
        }));

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
      { id: 'openai/o3-mini',             name: 'o3 mini',         inputPrice: '1.100', outputPrice: '4.400' },
      { id: 'openai/o1',                  name: 'o1',              inputPrice: '15.000', outputPrice: '60.000' },
      { id: 'openai/gpt-4o',              name: 'GPT-4o',          inputPrice: '2.500', outputPrice: '10.000' },
      { id: 'openai/gpt-4o-mini',         name: 'GPT-4o mini',     inputPrice: '0.150', outputPrice: '0.600' },
      { id: 'openai/gpt-4-turbo',         name: 'GPT-4 Turbo',     inputPrice: '10.000', outputPrice: '30.000' },
      { id: 'openai/o1-mini',             name: 'o1-mini',         inputPrice: '1.100', outputPrice: '4.400' },
      { id: 'openai/o1-preview',          name: 'o1-preview',      inputPrice: '15.000', outputPrice: '60.000' },
      { id: 'openai/gpt-4',               name: 'GPT-4',           inputPrice: '30.000', outputPrice: '60.000' },
      { id: 'openai/gpt-3.5-turbo',       name: 'GPT-3.5 Turbo',   inputPrice: '0.500', outputPrice: '1.500' },
    ]},
    anthropic: { label: '🧠 Anthropic', models: [
      { id: 'anthropic/claude-3.7-sonnet',   name: 'Claude 3.7 Sonnet', inputPrice: '3.000', outputPrice: '15.000' },
      { id: 'anthropic/claude-3.5-sonnet',   name: 'Claude 3.5 Sonnet', inputPrice: '3.000', outputPrice: '15.000' },
      { id: 'anthropic/claude-3.5-haiku',    name: 'Claude 3.5 Haiku',  inputPrice: '0.800', outputPrice: '4.000' },
      { id: 'anthropic/claude-3-opus',       name: 'Claude 3 Opus',     inputPrice: '15.000', outputPrice: '75.000' },
      { id: 'anthropic/claude-3-sonnet',     name: 'Claude 3 Sonnet',   inputPrice: '3.000', outputPrice: '15.000' },
      { id: 'anthropic/claude-3-haiku',      name: 'Claude 3 Haiku',    inputPrice: '0.250', outputPrice: '1.250' },
      { id: 'anthropic/claude-2.1',          name: 'Claude 2.1',        inputPrice: '8.000', outputPrice: '24.000' },
    ]},
    google: { label: '✨ Google', models: [
      { id: 'google/gemini-2.0-pro-exp-02-05', name: 'Gemini 2.0 Pro Exp', inputPrice: '0.000', outputPrice: '0.000' },
      { id: 'google/gemini-2.0-flash-001',   name: 'Gemini 2.0 Flash',       inputPrice: '0.100', outputPrice: '0.400' },
      { id: 'google/gemini-pro-1.5',          name: 'Gemini 1.5 Pro',        inputPrice: '1.250', outputPrice: '5.000' },
      { id: 'google/gemini-flash-1.5',        name: 'Gemini 1.5 Flash',      inputPrice: '0.075', outputPrice: '0.300' },
      { id: 'google/gemini-2.0-flash-lite-preview-02-05', name: 'Gemini 2.0 Flash Lite', inputPrice: '0.075', outputPrice: '0.300' },
    ]},
    moonshot: { label: '🌙 Moonshot (Kimi)', models: [
      { id: 'moonshot/kimi-2.5',             name: 'Kimi 2.5',          inputPrice: '0.600', outputPrice: '2.500' },
      { id: 'moonshot/kimi-v1-128k',         name: 'Kimi v1 128K',      inputPrice: '0.500', outputPrice: '1.500' },
      { id: 'moonshot/kimi-v1-32k',          name: 'Kimi v1 32K',       inputPrice: '0.150', outputPrice: '0.450' },
      { id: 'moonshot/kimi-v1-8k',           name: 'Kimi v1 8K',        inputPrice: '0.140', outputPrice: '0.590' },
    ]},
    deepseek: { label: '🔬 DeepSeek', models: [
      { id: 'deepseek/deepseek-r1',          name: 'DeepSeek R1',       inputPrice: '0.550', outputPrice: '2.190' },
      { id: 'deepseek/deepseek-chat',        name: 'DeepSeek V3',       inputPrice: '0.270', outputPrice: '1.100' },
      { id: 'deepseek/deepseek-r1-distill-llama-70b', name: 'R1 Distill Llama 70B', inputPrice: '0.120', outputPrice: '0.180' },
    ]},
    qwen: { label: '🐉 Qwen', models: [
      { id: 'qwen/qwen-max',                 name: 'Qwen Max',          inputPrice: '1.600', outputPrice: '6.400' },
      { id: 'qwen/qwen-2.5-coder-32b-instruct', name: 'Qwen2.5 Coder 32B', inputPrice: '0.070', outputPrice: '0.160' },
    ]},
    meta: { label: '🦙 Meta (Llama)', models: [
      { id: 'meta-llama/llama-3.3-70b-instruct',   name: 'Llama 3.3 70B',     inputPrice: '0.120', outputPrice: '0.300' },
      { id: 'meta-llama/llama-3.1-405b-instruct',  name: 'Llama 3.1 405B',    inputPrice: '1.000', outputPrice: '3.000' },
    ]},
    mistral: { label: '🌪 Mistral', models: [
      { id: 'mistralai/mistral-large',             name: 'Mistral Large',     inputPrice: '2.000', outputPrice: '6.000' },
      { id: 'mistralai/mixtral-8x22b-instruct',    name: 'Mixtral 8x22B',     inputPrice: '0.640', outputPrice: '0.640' },
    ]},
    zhipu: { label: '🐼 Zhipu (GLM)', models: [
      { id: 'zhipu/glm-4-plus',              name: 'GLM 4 Plus',        inputPrice: '0.700', outputPrice: '0.700' },
      { id: 'zhipu/glm-4-flash',             name: 'GLM 4 Flash',       inputPrice: '0.000', outputPrice: '0.000' },
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

// ── API: 오케스트레이터 실행 (v4.1 — 다중 세션 지원) ────
let activeOrchestration = null;

app.post('/api/orchestrate', auth, async (req, res) => {
  // v4.1: sessions 배열 또는 단일 sessionNumber 모두 지원
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
    broadcast(`🛰 오케스트레이터 v4.1 시작 — ${sessionList.length}개 세션: [${sessionList.join(', ')}]`, 'start');

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

// ── API: 직접 프롬프트 실행 (v4.1 신규) ────────────────
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
// ── QA TEST: Playwright 자동화 ────────────────────────
const qaResultsFile   = path.join(__dirname, 'qa-results.json');
const qaScreenshotDir = path.join(__dirname, 'public', 'qa-screenshots');
if (!fs.existsSync(qaScreenshotDir)) fs.mkdirSync(qaScreenshotDir, { recursive: true });

let qaResults = [];
if (fs.existsSync(qaResultsFile)) {
  try { qaResults = JSON.parse(fs.readFileSync(qaResultsFile, 'utf8')); } catch {}
}
function saveQaResults() {
  fs.writeFileSync(qaResultsFile, JSON.stringify(qaResults.slice(-50), null, 2));
}

// AI에서 Playwright 스크립트 생성
async function generatePlaywrightScript(testPrompt, targetUrl) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY 없음');

  const systemMsg = `You are a QA automation expert. Generate a complete, runnable Node.js Playwright script.
Rules:
- Use CommonJS require (not ESM import)
- Use playwright (not @playwright/test)
- Target URL: ${targetUrl || 'http://localhost:4000'}
- Take screenshots with page.screenshot({ path: '...' }) saving to these exact paths provided
- After each major step, add await page.waitForTimeout(500)
- Handle errors: wrap in try/catch, always close browser in finally
- Return ONLY the raw JS code, no markdown fences, no explanation`;

  const userMsg = `Generate a Playwright test for: ${testPrompt}

The script must:
1. Launch chromium (headless)
2. Navigate to the target URL
3. Perform the requested test steps
4. Take screenshots at key moments (SCREENSHOT_PATHS will be injected by the runner)
5. Log PASS or FAIL for each step to stdout
6. Exit with code 0 on pass, 1 on fail`;

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: process.env.QA_MODEL || 'openai/gpt-4o',
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user',   content: userMsg }
      ],
      temperature: 0.2,
      max_tokens: 3000,
    });
    const options = {
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://agent-mission-control',
        'X-Title': 'Agent Mission Control QA',
      }
    };
    let data = '';
    const req = https.request(options, (resp) => {
      resp.on('data', c => { data += c; });
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.message?.content || '';
          // Strip markdown fences if AI added them
          const clean = content.replace(/^```[^\n]*\n?/m, '').replace(/```$/m, '').trim();
          resolve(clean);
        } catch (e) { reject(new Error('AI 응답 파싱 실패: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// POST /api/qa/run
app.post('/api/qa/run', auth, async (req, res) => {
  const { prompt, targetUrl = 'http://localhost:4000', mode = 'direct', planSections = [] } = req.body;
  if (!prompt && planSections.length === 0) {
    return res.status(400).json({ error: '테스트 프롬프트 또는 섹션을 선택하세요' });
  }

  const testId  = `qa-${Date.now()}`;
  const tmpDir  = path.join(__dirname, 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const scriptPath = path.join(tmpDir, `${testId}.js`);
  const ssDir      = path.join(qaScreenshotDir, testId);
  fs.mkdirSync(ssDir, { recursive: true });

  const testPrompt = prompt || `Test plan sections: ${planSections.join(', ')}`;
  const result = {
    id: testId,
    timestamp: new Date().toISOString(),
    prompt: testPrompt,
    targetUrl,
    status: 'running',
    screenshots: [],
    log: [],
    passed: 0,
    failed: 0,
  };
  qaResults.push(result);
  saveQaResults();

  // 즉시 응답 (비동기 실행)
  res.json({ ok: true, testId, message: '테스트 시작됨' });

  // 브로드캐스트 헬퍼
  function broadcast(type, data) {
    const msg = JSON.stringify({ type, data, testId });
    wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
    result.log.push({ type, data });
  }

  try {
    broadcast('qa_start', `🧪 QA 테스트 시작: ${testPrompt}`);
    broadcast('qa_log', `🎯 대상 URL: ${targetUrl}`);
    broadcast('qa_log', `🤖 AI로 Playwright 스크립트 생성 중...`);

    // AI로 스크립트 생성
    let script = await generatePlaywrightScript(testPrompt, targetUrl);

    // 스크린샷 경로를 스크립트에 주입
    const ssPath1 = path.join(ssDir, 'step1.png');
    const ssPath2 = path.join(ssDir, 'step2.png');
    const ssPath3 = path.join(ssDir, 'final.png');
    script = script
      .replace(/SCREENSHOT_PATH_1/g, ssPath1)
      .replace(/SCREENSHOT_PATH_2/g, ssPath2)
      .replace(/SCREENSHOT_PATH_3/g, ssPath3);

    // playwright require 경로 보장 (지능적 중복 방지 및 절대 경로 치환)
    const playwrightPath = path.join(__dirname, 'node_modules', 'playwright');
    
    // 1. 모든 'playwright' require 선언을 절대 경로로 치환
    script = script.replace(/require\s*\(\s*['"]playwright['"]\s*\)/gi, `require('${playwrightPath}')`);

    // 2. 'chromium' 변수가 어떤 방식(destructuring, assignment 등)으로든 선언되었는지 확인
    // 예: const { chromium } = ..., let chromium = ..., var { chromium: ch } = ...
    const hasChromiumDeclaration = /\b(const|let|var)\s*\{?\s*chromium\b/i.test(script);

    if (!hasChromiumDeclaration) {
        // 선언이 발견되지 않았다면 최상단에 주입
        script = `const { chromium } = require('${playwrightPath}');\n` + script;
    }

    fs.writeFileSync(scriptPath, script, 'utf8');
    broadcast('qa_log', `✅ 스크립트 생성 완료 (${script.length} bytes)`);
    broadcast('qa_script', script);

    // Playwright 실행
    broadcast('qa_log', `▶ Playwright 실행 중...`);
    await new Promise((resolve) => {
      const child = spawn('node', [scriptPath], {
        cwd: __dirname,
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(__dirname, 'node_modules', 'playwright', '.local-browsers') },
      });

      child.stdout.on('data', d => {
        const line = d.toString().trim();
        if (line) {
          broadcast('qa_log', line);
          if (/PASS/i.test(line)) result.passed++;
          if (/FAIL/i.test(line)) result.failed++;
        }
      });
      child.stderr.on('data', d => {
        const line = d.toString().trim();
        if (line && !line.includes('DeprecationWarning')) broadcast('qa_err', line);
      });
      child.on('close', (code) => {
        result.status = code === 0 ? 'passed' : 'failed';
        resolve();
      });
    });

    // 스크린샷 목록 수집
    if (fs.existsSync(ssDir)) {
      result.screenshots = fs.readdirSync(ssDir)
        .filter(f => /\.(png|jpg)$/.test(f))
        .map(f => `/qa-screenshots/${testId}/${f}`);
    }

    broadcast('qa_done', JSON.stringify({
      status: result.status,
      passed: result.passed,
      failed: result.failed,
      screenshots: result.screenshots,
    }));
  } catch (e) {
    result.status = 'error';
    broadcast('qa_err', `❌ QA 실행 오류: ${e.message}`);
  } finally {
    saveQaResults();
    // 임시 스크립트 파일 정리
    try { fs.unlinkSync(scriptPath); } catch {}
  }
});

// GET /api/qa/results
app.get('/api/qa/results', auth, (req, res) => {
  res.json({ results: qaResults.slice(-20).reverse() });
});

// Screenshots 정적 서빙
app.use('/qa-screenshots', express.static(qaScreenshotDir));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});


// ── 서버 시작 ─────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🛰  Agent Mission Control Server v4.1`);
  console.log(`   접속 주소: http://0.0.0.0:${PORT}`);
  console.log(`   현재 프로젝트: ${currentProject.label} (${currentProject.root}`);
  console.log(`   ✅ v4.1: 실시간 모델 동기화, 다중 세션, 직접 프롬프트 지원`);
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
