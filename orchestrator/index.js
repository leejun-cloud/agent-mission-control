/**
 * Orchestrator Entry Point
 * plan.md의 세션을 읽고 에이전트 파이프라인을 실행합니다.
 *
 * 사용법: node orchestrator/index.js --plan ./plan.md --session 3
 */

const { callAgent } = require('./openrouter-client');
const CostTracker   = require('./cost-tracker');
const notifier      = require('./notifier');

async function run(planPath, sessionNumber) {
  console.log('🛰 Agent Mission Control — Orchestrator v3.0');
  console.log(`📄 Plan: ${planPath}`);
  console.log(`📋 Session: ${sessionNumber}`);
  console.log('─'.repeat(50));

  const tracker = new CostTracker({
    warningRatio: 0.8,
    onWarning: (msg) => notifier.notifyBudgetWarning(tracker.totalUSD, tracker.limitUSD),
    onExceeded: (msg) => {
      notifier.notifyEmergency(msg);
      process.exit(1);
    },
  });

  // TODO: Phase 2 구현 예정
  // 1. plan-parser.js로 plan.md 파싱
  // 2. AGENT_ARCHITECT (o3.2)에게 구조 설계 요청
  // 3. AGENT_ORCHESTRATOR에게 태스크 분해 요청
  // 4. worker-pool.js로 AGENT_WORKER × N 병렬 실행
  // 5. AGENT_DESIGNER로 UI 검토
  // 6. AGENT_REVIEWER로 보안 전수 검사
  // 7. AGENT_INTEGRATOR로 통합 + 빌드
  // 8. git-deploy.js로 자동 배포
  // 9. notifier.js로 Slack 알림

  console.log('\n⚠️  오케스트레이터 엔진은 Phase 2에서 구현 예정입니다.');
  console.log('   현재는 server.js (대시보드)만 사용할 수 있습니다.\n');
}

// CLI 실행
if (require.main === module) {
  const args = process.argv.slice(2);
  const planIdx = args.indexOf('--plan');
  const sessIdx = args.indexOf('--session');

  const planPath = planIdx >= 0 ? args[planIdx + 1] : './plan.md';
  const session  = sessIdx >= 0 ? parseInt(args[sessIdx + 1]) : 1;

  run(planPath, session).catch(err => {
    console.error('❌ 오케스트레이터 오류:', err.message);
    process.exit(1);
  });
}

module.exports = { run };
