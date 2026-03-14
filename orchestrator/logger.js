/**
 * Central Structured Logger — v5.0
 * 모든 파이프라인 단계의 AI 호출, 비용, 결과를 JSON Lines 형식으로 기록합니다.
 */

const fs   = require('fs');
const path = require('path');

const LOG_DIR  = process.env.LOG_DIR || path.join(process.cwd(), '.agents', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'audit.jsonl');

let _sessionId = null;

function ensureLogDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function log(entry) {
  ensureLogDir();
  const record = {
    ts: new Date().toISOString(),
    sessionId: _sessionId,
    stage: entry.stage || 'unknown',
    role:  entry.role  || null,
    model: entry.model || null,
    prompt: entry.prompt ? String(entry.prompt).slice(0, 200) : null,
    tokens: entry.tokens || null,
    costUSD: entry.costUSD || null,
    duration: entry.duration || null,
    status: entry.status || 'ok',
    data: entry.data || null,
  };
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(record) + '\n', 'utf8');
  } catch (e) {
    console.error('[Logger] 로그 기록 실패:', e.message);
  }
}

function stage(stageName, meta = {}) {
  const startMs = Date.now();
  log({ stage: stageName, status: 'start', ...meta });
  return {
    done(entry = {}) {
      log({ stage: stageName, status: 'ok', duration: Date.now() - startMs, ...meta, ...entry });
    },
    fail(err, entry = {}) {
      log({ stage: stageName, status: 'error', duration: Date.now() - startMs, data: { error: err?.message || String(err) }, ...meta, ...entry });
    },
  };
}

function setSession(sessionId) { _sessionId = sessionId; }

function readRecent(n = 100) {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-n).map(line => { try { return JSON.parse(line); } catch { return { raw: line }; } });
  } catch { return []; }
}

module.exports = { log, stage, setSession, readRecent };
