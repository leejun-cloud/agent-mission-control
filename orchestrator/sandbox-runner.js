/**
 * Sandbox Runner — v5.0
 * AI 생성 코드를 Docker 격리 컨테이너에서 실행합니다.
 * RULE 5: Generated code must NEVER execute directly in the main environment.
 */

const { execFile, execSync } = require('child_process');
const path   = require('path');
const logger = require('./logger');

const SANDBOX_IMAGE   = process.env.SANDBOX_IMAGE   || 'amc-sandbox:latest';
const SANDBOX_ENABLED = process.env.SANDBOX_ENABLED !== 'false';
const SANDBOX_TIMEOUT = parseInt(process.env.SANDBOX_TIMEOUT_MS || '30000');

function isDockerAvailable() {
  try { execSync('docker info', { timeout: 5000, stdio: 'pipe' }); return true; } catch { return false; }
}

async function runTestsInSandbox(codeDir) {
  const timer = logger.stage('sandbox-tests');

  if (!SANDBOX_ENABLED || !isDockerAvailable()) {
    timer.done({ data: { skipped: true } });
    return { ok: true, skipped: true };
  }

  return new Promise((resolve) => {
    execFile('docker', [
      'run', '--rm',
      '--name', `amc-test-${Date.now()}`,
      '--network', 'none',
      '--memory', '1g', '--cpus', '1.0',
      '-v', `${require('path').resolve(codeDir)}:/sandbox`,
      '--workdir', '/sandbox',
      'node:20-alpine',
      'sh', '-c', 'npm ci --silent && npm test -- --json --no-coverage 2>&1',
    ], { timeout: SANDBOX_TIMEOUT * 3 }, (err, stdout, stderr) => {
      const ok = !err;
      ok ? timer.done({ data: { ok } }) : timer.fail(err, { data: { stderr: stderr?.slice(0, 300) } });
      resolve({ ok, stdout, stderr });
    });
  });
}

module.exports = { runTestsInSandbox, isDockerAvailable };
