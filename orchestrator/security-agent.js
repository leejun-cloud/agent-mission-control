/**
 * Security AI Agent — v5.0
 * AI 기반 보안 코드 리뷰 + Semgrep 정적 분석
 * RULE 3: Secure Coding Enforcement
 */

const { execFile } = require('child_process');
const path         = require('path');
const fs           = require('fs');
const { callAgent } = require('./openrouter-client');
const logger        = require('./logger');

const SEMGREP_CONFIG = path.join(__dirname, '..', 'security', 'semgrep-config.yml');

async function runSecurityScan(files, projectRoot) {
  const timer = logger.stage('security-agent', { role: 'security', model: process.env.AGENT_SECURITY });

  if (!files || files.length === 0) {
    timer.done({ data: { skipped: true } });
    return { passed: true, riskLevel: 'LOW', issues: [], aiReport: null };
  }

  const [semgrepResult, aiResult] = await Promise.allSettled([
    runSemgrep(files, projectRoot),
    runAISecurityReview(files),
  ]);

  const semgrepIssues = semgrepResult.status === 'fulfilled' ? semgrepResult.value.issues : [];
  const aiIssues      = aiResult.status === 'fulfilled'      ? aiResult.value.issues      : [];
  const allIssues     = deduplicateIssues([...semgrepIssues, ...aiIssues]);
  const riskLevel     = calcRiskLevel(allIssues);
  const passed        = riskLevel !== 'HIGH';

  timer.done({ data: { riskLevel, issues: allIssues.length, passed } });
  return { passed, riskLevel, issues: allIssues, aiReport: aiResult.status === 'fulfilled' ? aiResult.value : null };
}

function runSemgrep(files, projectRoot) {
  return new Promise((resolve) => {
    const tmpDir = path.join(projectRoot, '.agents', 'tmp-semgrep');
    fs.mkdirSync(tmpDir, { recursive: true });
    for (const f of files.filter(f => /\.(js|ts|jsx|tsx)$/.test(f.path))) {
      fs.writeFileSync(path.join(tmpDir, path.basename(f.path)), f.content || '', 'utf8');
    }
    execFile('semgrep', ['--config', SEMGREP_CONFIG, '--json', '--quiet', tmpDir], { timeout: 60000 }, (err, stdout) => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      if (err && !stdout) { resolve({ issues: [] }); return; }
      try {
        const results = (JSON.parse(stdout || '{}').results || []);
        resolve({ issues: results.map(r => ({ source: 'semgrep', severity: r.extra?.severity || 'WARNING', file: path.basename(r.path || ''), line: r.start?.line || 0, ruleId: r.check_id || '', message: r.extra?.message || '' })) });
      } catch { resolve({ issues: [] }); }
    });
  });
}

async function runAISecurityReview(files) {
  const preview = files.slice(0, 8).map(f => `=== ${f.path} ===\n${(f.content || '').slice(0, 600)}`).join('\n\n');
  const result = await callAgent('security', [
    { role: 'system', content: '당신은 보안 전문가입니다. SQL injection, XSS, command injection, 하드코딩 시크릿, 경로 탈출을 찾아 JSON으로 보고하세요. {"riskLevel":"LOW|MEDIUM|HIGH","issues":[{"severity":"high|medium|low","type":"...","file":"...","line":0,"message":"...","fix":"..."}]}' },
    { role: 'user',   content: `보안 분석:\n\n${preview}` },
  ], { temperature: 0.1, max_tokens: 4096 });

  logger.log({ stage: 'security-agent', role: 'security', model: process.env.AGENT_SECURITY, tokens: result.usage.total_tokens, costUSD: result.costUSD });

  try {
    const text   = String(result.content);
    const match  = text.match(/```json\n?([\s\S]*?)\n?```/) || text.match(/(\{[\s\S]*\})/);
    const parsed = JSON.parse(match ? (match[1] || match[0]) : text);
    return { riskLevel: parsed.riskLevel || 'LOW', issues: (parsed.issues || []).map(i => ({ source: 'ai', ...i })) };
  } catch { return { riskLevel: 'LOW', issues: [] }; }
}

function calcRiskLevel(issues) {
  if (issues.some(i => ['high', 'ERROR'].includes((i.severity||'').toLowerCase()))) return 'HIGH';
  if (issues.some(i => ['medium', 'WARNING'].includes((i.severity||'').toLowerCase()))) return 'MEDIUM';
  return 'LOW';
}

function deduplicateIssues(issues) {
  const seen = new Set();
  return issues.filter(i => { const k = `${i.file}:${i.line}:${i.ruleId||i.type}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

module.exports = { runSecurityScan };
