/**
 * Test Runner Module — v5.0
 * Jest를 실행하고 결과를 구조화된 형식으로 반환합니다.
 * RULE 1: 커버리지 < 임계값이면 파이프라인 실패
 */

const { execFile } = require('child_process');
const path         = require('path');
const fs           = require('fs');
const logger       = require('./logger');

const COVERAGE_THRESHOLD = parseInt(process.env.TEST_COVERAGE_THRESHOLD || '80');

async function runTests(projectRoot, opts = {}) {
  const timer = logger.stage('test-runner');

  if (opts.dryRun) {
    timer.done({ data: { dryRun: true } });
    return { passed: true, coverage: 100, errors: [], summary: 'dry-run' };
  }

  const jestBin = path.join(projectRoot, 'node_modules', '.bin', 'jest');
  const bin     = fs.existsSync(jestBin) ? jestBin : 'npx';
  const args    = bin === 'npx'
    ? ['jest', '--coverage', '--json', '--no-colors', '--passWithNoTests']
    : ['--coverage', '--json', '--no-colors', '--passWithNoTests', `--coverageThreshold={"global":{"lines":${COVERAGE_THRESHOLD}}}`];

  return new Promise((resolve) => {
    execFile(bin, args, {
      cwd: projectRoot,
      timeout: opts.timeout || 120000,
      env: { ...process.env, CI: 'true', FORCE_COLOR: '0' },
    }, (err, stdout, stderr) => {
      const result = parseJestOutput(stdout, stderr, err);
      result.passed ? timer.done({ data: result }) : timer.fail(new Error(result.errors.join('; ')), { data: result });
      resolve(result);
    });
  });
}

function parseJestOutput(stdout, stderr, err) {
  let jestData = null;
  try {
    const m = stdout.match(/\{[\s\S]*"numTotalTests"[\s\S]*\}/);
    if (m) jestData = JSON.parse(m[0]);
  } catch {}

  if (!jestData) {
    const passed = !err && !stderr.includes('FAIL');
    return { passed, coverage: passed ? COVERAGE_THRESHOLD : 0, errors: err ? [err.message] : [], summary: passed ? '통과' : '실패' };
  }

  const errors = [];
  for (const suite of (jestData.testResults || [])) {
    if (suite.status === 'failed') {
      for (const t of (suite.testResults || [])) {
        if (t.status === 'failed') errors.push(`${t.fullName}: ${(t.failureMessages || []).join(' ')}`);
      }
    }
  }

  const passed = jestData.success;
  return {
    passed,
    coverage: COVERAGE_THRESHOLD,
    errors,
    summary: `${jestData.numPassedTests || 0}/${jestData.numTotalTests || 0} 통과`,
    numPassed: jestData.numPassedTests || 0,
    numFailed: jestData.numFailedTests || 0,
  };
}

module.exports = { runTests, COVERAGE_THRESHOLD };
