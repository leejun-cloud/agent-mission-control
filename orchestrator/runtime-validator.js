/**
 * Runtime Validator — v5.0
 * 샌드박스에서 생성된 코드를 실행하고 결과를 검증합니다.
 * RULE 5: Controlled Execution Sandbox
 */

const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');
const { runTestsInSandbox, isDockerAvailable } = require('./sandbox-runner');

async function validateRuntime(files, testFiles, projectRoot) {
  const timer = logger.stage('runtime-validator');

  if (!isDockerAvailable()) {
    timer.done({ data: { skipped: 'Docker unavailable' } });
    return { ok: true, skipped: true, output: '', errors: [] };
  }

  const runDir = path.join(projectRoot, '.agents', `runtime-${Date.now()}`);
  fs.mkdirSync(runDir, { recursive: true });

  try {
    for (const file of [...files, ...testFiles]) {
      if (!file.path || !file.content) continue;
      const dest = path.join(runDir, file.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, file.content, 'utf8');
    }

    const pkgPath = path.join(runDir, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      fs.writeFileSync(pkgPath, JSON.stringify({ name: 'sandbox-test', version: '1.0.0', scripts: { test: 'jest --passWithNoTests' }, devDependencies: { jest: '^29.7.0' } }, null, 2), 'utf8');
    }

    const testResult = await runTestsInSandbox(runDir);
    const errors = [];
    if (!testResult.ok) {
      errors.push(...(testResult.stderr || testResult.stdout || '').split('\n').filter(l => l.includes('Error') || l.includes('FAIL')).slice(0, 10));
    }

    const result = { ok: testResult.ok || testResult.skipped, output: testResult.stdout || '', exitCode: testResult.ok ? 0 : 1, crashed: !testResult.ok, errors, skipped: testResult.skipped || false };
    result.ok ? timer.done({ data: result }) : timer.fail(new Error(errors[0] || 'Runtime failed'), { data: result });
    return result;
  } finally {
    try { fs.rmSync(runDir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { validateRuntime };
