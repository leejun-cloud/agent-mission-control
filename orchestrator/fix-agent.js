/**
 * Fix AI Agent — Autonomous Code Repair Loop — v5.0
 * 테스트/lint/보안 실패를 분석하고 자동으로 코드를 수정합니다.
 * RULE 10: Autonomous Code Repair (최대 5회)
 */

const { callAgent } = require('./openrouter-client');
const logger        = require('./logger');

const MAX_RETRIES = parseInt(process.env.MAX_FIX_RETRIES || '5');

async function repairCode({ files, errors, type = 'test', attempt = 1 }) {
  if (attempt > MAX_RETRIES) {
    logger.log({ stage: 'fix-agent', status: 'error', data: { escalate: true, attempts: attempt } });
    return { ok: false, files, escalate: true, message: `🚨 ${MAX_RETRIES}회 수정 실패 — 인간 검토 필요\n${errors.slice(0,3).join('\n')}` };
  }

  const timer = logger.stage('fix-agent', { role: 'fixer', model: process.env.AGENT_FIXER, data: { attempt, type } });

  const systemPrompts = {
    test:     '당신은 테스트 디버깅 전문가입니다. 실패한 테스트를 수정하세요.',
    lint:     '당신은 코드 품질 전문가입니다. ESLint/Prettier 오류를 수정하세요.',
    security: '당신은 보안 전문가입니다. SQL injection, XSS, hardcoded secrets를 제거하세요.',
    runtime:  '당신은 Node.js 전문가입니다. 런타임 오류를 수정하세요.',
  };

  try {
    const result = await callAgent('fixer', [
      { role: 'system', content: `${systemPrompts[type] || systemPrompts.test}\n응답 JSON: {"files":[{"path":"...","content":"수정된전체코드"}]}` },
      { role: 'user',   content: `[시도 ${attempt}/${MAX_RETRIES}] ${type.toUpperCase()} 오류:\n\`\`\`\n${errors.slice(0,10).join('\n')}\n\`\`\`\n\n파일:\n${files.slice(0,5).map(f=>`=== ${f.path} ===\n${(f.content||'').slice(0,1500)}`).join('\n\n')}` },
    ], { temperature: 0.15, max_tokens: 8192 });

    logger.log({ stage: 'fix-agent', role: 'fixer', model: process.env.AGENT_FIXER, tokens: result.usage.total_tokens, costUSD: result.costUSD, data: { attempt, type } });

    const text   = String(result.content);
    const match  = text.match(/```json\n?([\s\S]*?)\n?```/) || text.match(/(\{[\s\S]*\})/);
    const parsed = JSON.parse(match ? (match[1] || match[0]) : text);

    if (!Array.isArray(parsed?.files) || parsed.files.length === 0) {
      timer.fail(new Error('수정된 파일 없음'));
      return { ok: false, files, escalate: attempt >= MAX_RETRIES, message: `파싱 실패 (시도 ${attempt}/${MAX_RETRIES})` };
    }

    const fixedMap   = new Map(parsed.files.map(f => [f.path, f.content]));
    const fixedFiles = files.map(f => fixedMap.has(f.path) ? { ...f, content: fixedMap.get(f.path) } : f);
    timer.done({ data: { fixed: parsed.files.length, attempt } });
    return { ok: true, files: fixedFiles, attempt, message: `✅ ${parsed.files.length}개 파일 수정 (시도 ${attempt}/${MAX_RETRIES})` };

  } catch (err) {
    timer.fail(err);
    return { ok: false, files, escalate: attempt >= MAX_RETRIES, message: `수정 오류: ${err.message}` };
  }
}

module.exports = { repairCode, MAX_RETRIES };
