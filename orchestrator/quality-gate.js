/**
 * Quality Gate Module — v5.0
 * ESLint + Prettier 검사 후 실패 시 Fix AI로 자동 수정합니다.
 * RULE 2: Mandatory Static Analysis
 */

const { execFile } = require('child_process');
const path         = require('path');
const fs           = require('fs');
const { callAgent } = require('./openrouter-client');
const logger        = require('./logger');

async function runQualityGate(files, projectRoot, opts = {}) {
  const autoFix = opts.autoFix !== false;
  const timer   = logger.stage('quality-gate');

  const jsFiles = files.filter(f => /\.(js|ts|jsx|tsx)$/.test(f.path));
  if (jsFiles.length === 0) {
    timer.done({ data: { skipped: 'No JS/TS files' } });
    return { passed: true, issues: [], files };
  }

  const tmpDir = path.join(projectRoot, '.agents', 'tmp-lint');
  fs.mkdirSync(tmpDir, { recursive: true });

  const tmpPaths = jsFiles.map(f => {
    const p = path.join(tmpDir, path.basename(f.path));
    fs.writeFileSync(p, f.content || '', 'utf8');
    return { original: f.path, tmp: p };
  });

  try {
    const lintResult = await runEslint(tmpPaths.map(f => f.tmp), projectRoot);
    const allIssues  = lintResult.issues;
    const passed     = allIssues.length === 0;

    if (!passed && autoFix) {
      logger.log({ stage: 'quality-gate', status: 'warn', data: { issues: allIssues.length } });
      const fixedFiles = await autoFixWithAI(files, allIssues);
      timer.done({ data: { passed: true, issuesFixed: allIssues.length } });
      return { passed: true, issues: allIssues, files: fixedFiles, autoFixed: true };
    }

    timer.done({ data: { passed, issues: allIssues.length } });
    return { passed, issues: allIssues, files };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

function runEslint(filePaths, cwd) {
  return new Promise((resolve) => {
    const bin = findBin('eslint', cwd);
    if (!bin) { resolve({ issues: [] }); return; }
    execFile(bin, ['--format=json', ...filePaths], { cwd, timeout: 30000 }, (err, stdout) => {
      const issues = [];
      try {
        for (const r of JSON.parse(stdout || '[]')) {
          for (const m of (r.messages || [])) {
            issues.push({ type: 'lint', severity: m.severity === 2 ? 'error' : 'warning', file: r.filePath, line: m.line, message: `${m.ruleId}: ${m.message}` });
          }
        }
      } catch {}
      resolve({ issues });
    });
  });
}

async function autoFixWithAI(files, issues) {
  const issueText = issues.slice(0, 20).map(i => `[${i.type}] ${path.basename(i.file || '')}: ${i.message}`).join('\n');
  const result = await callAgent('fixer', [
    { role: 'system', content: '당신은 코드 품질 전문가입니다. lint 오류를 수정하세요. JSON: {"files": [{"path":"...","content":"..."}]}' },
    { role: 'user',   content: `오류:\n${issueText}\n\n파일:\n${files.slice(0,5).map(f=>`=== ${f.path} ===\n${(f.content||'').slice(0,800)}`).join('\n\n')}` },
  ], { temperature: 0.1, max_tokens: 8192 });

  logger.log({ stage: 'quality-gate', role: 'fixer', tokens: result.usage.total_tokens, costUSD: result.costUSD });

  try {
    const text   = String(result.content);
    const match  = text.match(/```json\n?([\s\S]*?)\n?```/) || text.match(/(\{[\s\S]*\})/);
    const parsed = JSON.parse(match ? (match[1] || match[0]) : text);
    if (Array.isArray(parsed?.files)) {
      const fixedMap = new Map(parsed.files.map(f => [f.path, f.content]));
      return files.map(f => fixedMap.has(f.path) ? { ...f, content: fixedMap.get(f.path) } : f);
    }
  } catch {}
  return files;
}

function findBin(name, cwd) {
  const local = path.join(cwd, 'node_modules', '.bin', name);
  return fs.existsSync(local) ? local : null;
}

module.exports = { runQualityGate };
