/**
 * Test AI Agent — v5.0
 * Worker가 생성한 코드에 대한 단위 테스트를 AI로 자동 생성합니다.
 * RULE 1: No code without tests
 */

const { callAgent } = require('./openrouter-client');
const logger        = require('./logger');

async function generateTests(files, opts = {}) {
  const framework      = opts.framework || 'jest';
  const coverageTarget = opts.coverageTarget || parseInt(process.env.TEST_COVERAGE_THRESHOLD || '80');

  if (!files || files.length === 0) return [];

  const timer = logger.stage('test-agent', { role: 'tester', model: process.env.AGENT_TESTER });
  const testableFiles = files.filter(f =>
    f.path && !f.path.includes('.test.') && !f.path.includes('.spec.') &&
    /\.(js|ts|jsx|tsx)$/.test(f.path)
  );

  if (testableFiles.length === 0) {
    timer.done({ data: { skipped: 'No testable files' } });
    return [];
  }

  const testFiles = [];
  for (const file of testableFiles) {
    try {
      const tf = await generateTestForFile(file, framework, coverageTarget);
      if (tf) testFiles.push(tf);
    } catch (err) {
      logger.log({ stage: 'test-agent', status: 'warn', data: { file: file.path, error: err.message } });
    }
  }

  timer.done({ data: { generated: testFiles.length, total: testableFiles.length } });
  return testFiles;
}

async function generateTestForFile(file, framework, coverageTarget) {
  const result = await callAgent('tester', [
    { role: 'system', content: `당신은 ${framework} 전문가입니다. 주어진 코드에 대해 완전한 단위 테스트를 작성하세요. 목표 커버리지: ${coverageTarget}%. 응답: JSON {"path":"테스트파일경로","content":"테스트코드전체"}` },
    { role: 'user',   content: `파일: ${file.path}\n\`\`\`\n${(file.content || '').slice(0, 3000)}\n\`\`\`` },
  ], { temperature: 0.2, max_tokens: 4096 });

  logger.log({ stage: 'test-agent', role: 'tester', model: process.env.AGENT_TESTER, tokens: result.usage.total_tokens, costUSD: result.costUSD });

  const parsed = parseJsonSafe(result.content);
  if (!parsed.path || !parsed.content) return null;
  return { path: parsed.path, content: parsed.content };
}

function parseJsonSafe(text) {
  try {
    const match = String(text).match(/```json\n?([\s\S]*?)\n?```/) || String(text).match(/(\{[\s\S]*\})/);
    return JSON.parse(match ? (match[1] || match[0]) : text);
  } catch { return {}; }
}

module.exports = { generateTests };
