/**
 * Orchestrator Main Pipeline (v5.0)
 *
 * 실행 흐름:
 *   [1.  ARCHITECT  o3.2]      plan.md → 프로젝트 구조 설계도
 *   [2.  ORCHESTRATOR Sonnet]  설계도 → N개 태스크 분해 & 워커 할당
 *   [3.  WORKERS Kimi×N]       태스크 병렬 코딩
 *   [4.  TEST AI]              AI가 단위 테스트 자동 생성
 *   [5.  DESIGNER Gemini]      UI 코드 디자인 검토
 *   [6.  REVIEWER Qwen]        전수 보안/품질 검토 + 교육용 상세 리뷰
 *   [7.  QUALITY GATE]         ESLint + Prettier 품질 게이트
 *   [8.  SECURITY AI]          Semgrep + AI 보안 스캔
 *   [9.  SANDBOX + TESTS]      Docker 샌드박스에서 테스트 실행
 *   [10. FIX AI LOOP]          실패 시 자동 수정 (최대 5회)
 *   [11. FILE WRITER]          코드 파일 시스템에 자동 적용
 *   [12. GITHUB PR]            자동 브랜치 생성 + PR 오픈
 *   [13. NOTIFIER]             Slack 완료 알림
 *
 * 사용법: node orchestrator/index.js --plan ./plan.md --session 1 [--project /root/my-project]
 * v4.1: runDirect() — plan.md 없이 직접 프롬프트로 실행
 * v5.0: 테스트·품질·보안·샌드박스·자동수정 파이프라인 추가
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path              = require('path');
const fs                = require('fs');
const { callAgent }     = require('./openrouter-client');
const CostTracker       = require('./cost-tracker');
const notifier          = require('./notifier');
const { getSession, partitionTasks } = require('./plan-parser');
const WorkerPool        = require('./worker-pool');
const CheckpointManager = require('./checkpoint');
const FileWriter        = require('./file-writer');
const GitHubIntegration = require('./github-integration');
const logger            = require('./logger');
const TestAgent         = require('./test-agent');
const TestRunner        = require('./test-runner');
const QualityGate       = require('./quality-gate');
const SecurityAgent     = require('./security-agent');
const FixAgent          = require('./fix-agent');
const RepoIndexer       = require('./repo-indexer');
const { buildContextString } = require('./context-engine');
const RuntimeValidator  = require('./runtime-validator');
const DeployAgent       = require('./deploy-agent');

/* ── KILL SWITCH ─────────────────────────────────── */
let killed = false;
process.on('SIGTERM', () => { killed = true; });
process.on('SIGINT',  () => { killed = true; });

function checkKilled() {
  if (killed) throw new Error('🛑 킬스위치 활성화 — 파이프라인 중단');
}

/* ── MAIN ─────────────────────────────────────────── */
async function run({ planPath, sessionNumber, projectRoot, broadcast, onAgentStart, onAgentDone }) {
  const log = (msg, type = 'system') => {
    console.log(`[Orchestrator] ${msg}`);
    if (broadcast) broadcast(msg, type);
  };

  const agentStart = (role, task) => { if (onAgentStart) onAgentStart(role, task); };
  const agentDone  = (role, cost) => { if (onAgentDone)  onAgentDone(role, cost); };

  const sessionId = `session-${sessionNumber}-${Date.now()}`;
  const startTime = Date.now();

  const tracker = new CostTracker({
    warningRatio: 0.8,
    onWarning: async (msg) => {
      log(msg, 'warn');
      await notifier.notifyBudgetWarning(tracker.totalUSD, tracker.limitUSD);
    },
    onExceeded: async (msg) => {
      log(msg, 'error');
      await notifier.notifyEmergency(msg);
      killed = true;
    },
  });

  const checkpoint = new CheckpointManager(sessionId);
  log(`🛰 오케스트레이터 v3.0 시작 — Session ${sessionNumber}`, 'start');

  try {
    // ── 0. 세션 로드 ────────────────────────────────
    checkKilled();
    log('📄 plan.md 로드 중...');
    const session = getSession(planPath, sessionNumber);
    log(`✅ 세션 "${session.title}" 로드 완료 (태스크 ${session.tasks.length}개)`);
    checkpoint.save({ stage: 'plan_loaded', session: { number: sessionNumber, title: session.title } });

    // ── 1. ARCHITECT — 프로젝트 구조 설계 ──────────
    checkKilled();
    let architectOutput = checkpoint.isCompleted('architect') ?
      JSON.parse(fs.readFileSync(checkpoint.filePath('architect.json'), 'utf8')) :
      null;

    if (!architectOutput) {
      log('🏗 [ARCHITECT / o3.2] 프로젝트 구조 설계 중...');
      agentStart('architect', '프로젝트 구조 설계 중...');
      const archPrompt = buildArchitectPrompt(session, projectRoot);
      const result = await callAgent('architect', [
        { role: 'system', content: '당신은 소프트웨어 아키텍처 전문가입니다. 코드 작성 전 프로젝트 구조, 파일 인터페이스, 의존성을 설계합니다. JSON으로만 응답하세요.' },
        { role: 'user', content: archPrompt },
      ], { temperature: 0.1, max_tokens: 2048 });

      const budgetOk = tracker.record({ model: process.env.AGENT_ARCHITECT, role: 'architect', costUSD: result.costUSD, tokens: result.usage.total_tokens });
      if (!budgetOk) throw new Error('예산 초과');
      log(`✅ 설계 완료 (${result.usage.total_tokens} tokens, $${result.costUSD.toFixed(4)})`);

      architectOutput = parseJsonSafe(result.content);
      fs.writeFileSync(checkpoint.filePath('architect.json'), JSON.stringify(architectOutput, null, 2));
      checkpoint.markCompleted('architect');
      agentDone('architect', result.costUSD);
    } else {
      log('♻️  [ARCHITECT] 체크포인트에서 복원됨');
    }

    // ── 2. ORCHESTRATOR — 태스크 분해 ──────────────
    checkKilled();
    let taskGroups = checkpoint.isCompleted('orchestrate') ?
      JSON.parse(fs.readFileSync(checkpoint.filePath('task-groups.json'), 'utf8')) :
      null;

    if (!taskGroups) {
      log('🎯 [ORCHESTRATOR] 병렬 태스크 분해 중...');
      const orchPrompt = buildOrchestratorPrompt(session, architectOutput);
      const result = await callAgent('orchestrator', [
        { role: 'system', content: '당신은 소프트웨어 팀 리드입니다. 주어진 세션을 파일 충돌 없는 독립적인 병렬 태스크로 분해합니다. JSON 배열로만 응답하세요.' },
        { role: 'user', content: orchPrompt },
      ], { temperature: 0.2, max_tokens: 2048 });

      tracker.record({ model: process.env.AGENT_ORCHESTRATOR, role: 'orchestrator', costUSD: result.costUSD, tokens: result.usage.total_tokens });
      log(`✅ 태스크 분해 완료 (${result.usage.total_tokens} tokens)`);

      const parsedTasks = parseJsonSafe(result.content);
      taskGroups = partitionTasks(Array.isArray(parsedTasks) ? parsedTasks : session.tasks);
      fs.writeFileSync(checkpoint.filePath('task-groups.json'), JSON.stringify(taskGroups, null, 2));
      checkpoint.markCompleted('orchestrate');
    } else {
      log(`♻️  [ORCHESTRATOR] 체크포인트 복원: ${taskGroups.length}개 그룹`);
    }

    log(`📦 ${taskGroups.length}개 워커 그룹 생성됨`);

    // ── 2.5. REPO INDEX — 레포지토리 색인 (워커에 컨텍스트 제공) ─
    checkKilled();
    if (projectRoot) {
      log('📂 [REPO INDEX] 레포지토리 색인 중...');
      try {
        const { indexRepository } = require('./repo-indexer');
        indexRepository(projectRoot);
        log('✅ [REPO INDEX] 색인 완료 — 워커 컨텍스트 준비됨', 'success');
      } catch (e) {
        log(`⚠️  [REPO INDEX] 색인 실패 (무시): ${e.message}`, 'warn');
      }
    }

    // ── 3. WORKERS — 병렬 코딩 ──────────────────────
    checkKilled();
    const workerResults = {};

    // 이미 완료된 워커는 스킵
    const pendingGroups = taskGroups.filter((_, idx) => !checkpoint.isCompleted(`worker-${idx + 1}`));
    const completedGroups = taskGroups.filter((_, idx) => checkpoint.isCompleted(`worker-${idx + 1}`)).length;
    if (completedGroups > 0) log(`♻️  ${completedGroups}개 워커 체크포인트 복원됨`);

    const pool = new WorkerPool({
      maxConcurrency: Math.min(3, pendingGroups.length),
      onWorkerStart: (wid, tasks) => log(`⚡ [WORKER ${wid}] 시작 — ${tasks.map(t => t.title || t.id).join(', ')}`, 'start'),
      onWorkerDone:  (wid, result) => log(`✅ [WORKER ${wid}] 완료`, 'success'),
      onWorkerError: (wid, err)   => log(`❌ [WORKER ${wid}] 오류: ${err.message}`, 'error'),
    });

    const poolResult = await pool.run(pendingGroups, async (tasks, workerId) => {
      checkKilled();
      const cacheKey = `worker-${workerId + completedGroups}-result.json`;
      const taskQuery = tasks.map(t => `${t.title || ''} ${t.description || ''} ${(t.files||[]).join(' ')}`).join(' ');
      const repoContext = projectRoot ? buildContextString(taskQuery, projectRoot) : '';
      const prompt = buildWorkerPrompt(tasks, architectOutput, repoContext);

      const result = await callAgent('worker', [
        { role: 'system', content: '당신은 시니어 풀스택 개발자입니다. 주어진 태스크의 코드를 정확히 구현하세요. 파일 경로(path)는 슬래시(/)나 점(.)으로 시작하지 않는 순수 상대경로(예: "src/app/page.tsx")만 사용하세요. 응답은 반드시 순수 JSON 형태만 출력하세요: {"files": [{"path": "...", "content": "..."}]}' },
        { role: 'user', content: prompt },
      ], { temperature: 0.2, max_tokens: 8192 });

      const ok = tracker.record({ model: process.env.AGENT_WORKER, role: 'worker', costUSD: result.costUSD, tokens: result.usage.total_tokens, sessionId: `w${workerId}` });
      if (!ok) throw new Error('예산 초과');

      const parsed = parseJsonSafe(result.content);
      fs.writeFileSync(checkpoint.filePath(cacheKey), JSON.stringify(parsed, null, 2));
      checkpoint.markCompleted(`worker-${workerId + completedGroups}`);
      workerResults[workerId] = parsed;
      return parsed;
    });

    if (!poolResult.success) {
      log(`⚠️  일부 워커 실패: ${poolResult.errors.map(e => e.error).join(', ')}`, 'warn');
    }

    // ── 4. TEST AI — 단위 테스트 자동 생성 ─────────
    checkKilled();
    const allWorkerFilesForTest = Object.values(workerResults).flatMap(r => r?.files || []);
    let testFiles = [];
    if (allWorkerFilesForTest.length > 0 && !checkpoint.isCompleted('test_ai')) {
      log('🧪 [TEST AI] 단위 테스트 자동 생성 중...');
      try {
        const testAgent = new TestAgent();
        testFiles = await testAgent.generateTests(allWorkerFilesForTest);
        fs.writeFileSync(checkpoint.filePath('test-files.json'), JSON.stringify(testFiles, null, 2));
        checkpoint.markCompleted('test_ai');
        log(`✅ [TEST AI] ${testFiles.length}개 테스트 파일 생성 완료`, 'success');
      } catch (e) {
        log(`⚠️  [TEST AI] 테스트 생성 실패: ${e.message}`, 'warn');
      }
    }

    // ── 5. DESIGNER — UI 디자인 검토 ────────────────
    checkKilled();
    const allFiles = Object.values(workerResults)
      .flatMap(r => r?.files || [])
      .filter(f => /\.(tsx?|jsx?|css|html)$/.test(f.path));

    if (allFiles.length > 0 && !checkpoint.isCompleted('designer')) {
      log('🎨 [DESIGNER / Gemini] UI 코드 디자인 검토 중...');
      const designPrompt = buildDesignerPrompt(allFiles);
      const result = await callAgent('designer', [
        { role: 'system', content: '당신은 UI/UX 전문가입니다. 제공된 프론트엔드 코드의 디자인 품질을 검토하고 개선 사항을 JSON으로 제안하세요.' },
        { role: 'user', content: designPrompt },
      ], { temperature: 0.3, max_tokens: 4096 });

      tracker.record({ model: process.env.AGENT_DESIGNER, role: 'designer', costUSD: result.costUSD, tokens: result.usage.total_tokens });
      const feedback = parseJsonSafe(result.content);
      fs.writeFileSync(checkpoint.filePath('designer-feedback.json'), JSON.stringify(feedback, null, 2));
      checkpoint.markCompleted('designer');
      log(`✅ [DESIGNER] 디자인 검토 완료 (제안 ${feedback?.suggestions?.length || 0}건)`, 'success');
    }

    // ── 6. REVIEWER — 보안/품질 전수 검토 ──────────
    checkKilled();
    let reviewResult = null;
    if (!checkpoint.isCompleted('reviewer')) {
      log('🔍 [REVIEWER / Qwen] 보안 및 품질 전수 검토 중...');
      const reviewPrompt = buildReviewerPrompt(Object.values(workerResults).flatMap(r => r?.files || []));
      const result = await callAgent('reviewer', [
        { role: 'system', content: '당신은 보안 및 코드 품질 전문가입니다. 취약점, 버그, 안티패턴을 찾아 JSON으로 보고하세요: {"issues": [...], "score": 0-100}' },
        { role: 'user', content: reviewPrompt },
      ], { temperature: 0.1, max_tokens: 4096 });

      tracker.record({ model: process.env.AGENT_REVIEWER, role: 'reviewer', costUSD: result.costUSD, tokens: result.usage.total_tokens });
      reviewResult = parseJsonSafe(result.content);
      fs.writeFileSync(checkpoint.filePath('review.json'), JSON.stringify(reviewResult, null, 2));
      checkpoint.markCompleted('reviewer');
      const score = reviewResult?.score || '?';
      const issues = reviewResult?.issues?.length || 0;
      log(`✅ [REVIEWER] 검토 완료 (점수: ${score}/100, 이슈: ${issues}건)`, 'success');
    }

    // ── 7. QUALITY GATE — ESLint + Prettier ─────────
    checkKilled();
    let allGeneratedFiles = Object.values(workerResults).flatMap(r => r?.files || []);
    if (!checkpoint.isCompleted('quality_gate')) {
      log('📐 [QUALITY GATE] 코드 품질 검사 중...');
      try {
        const gate = new QualityGate();
        const gateResult = await gate.run(allGeneratedFiles, { autoFix: true });
        if (!gateResult.passed) {
          log(`⚠️  [QUALITY GATE] ${gateResult.issues.length}개 이슈 발견`, 'warn');
          if (gateResult.autoFixed) {
            allGeneratedFiles = gateResult.files;
            log('✅ [QUALITY GATE] AI 자동 수정 완료', 'success');
          }
        } else {
          log('✅ [QUALITY GATE] 통과', 'success');
        }
        checkpoint.markCompleted('quality_gate');
      } catch (e) {
        log(`⚠️  [QUALITY GATE] 건너뜀: ${e.message}`, 'warn');
      }
    }

    // ── 8. SECURITY AI — Semgrep + AI 보안 스캔 ─────
    checkKilled();
    if (!checkpoint.isCompleted('security_ai')) {
      log('🛡 [SECURITY AI] 보안 스캔 중...');
      try {
        const secAgent = new SecurityAgent();
        const secResult = await secAgent.scan(allGeneratedFiles);
        fs.writeFileSync(checkpoint.filePath('security.json'), JSON.stringify(secResult, null, 2));
        checkpoint.markCompleted('security_ai');
        const level = secResult.riskLevel || 'UNKNOWN';
        log(`✅ [SECURITY AI] 완료 — 위험도: ${level}, 이슈: ${secResult.issues?.length || 0}건`, secResult.passed ? 'success' : 'warn');
        if (!secResult.passed) {
          log('⚠️  [SECURITY AI] 고위험 보안 이슈 발견 — 배포 전 검토 필요!', 'warn');
        }
      } catch (e) {
        log(`⚠️  [SECURITY AI] 건너뜀: ${e.message}`, 'warn');
      }
    }

    // ── 9. SANDBOX + TESTS — Docker 격리 테스트 ─────
    checkKilled();
    let sandboxOk = true;
    if (testFiles.length > 0 && !checkpoint.isCompleted('sandbox')) {
      log('🐳 [SANDBOX] 격리 환경에서 테스트 실행 중...');
      try {
        const validator = new RuntimeValidator();
        const sandboxResult = await validator.validate([...allGeneratedFiles, ...testFiles]);
        fs.writeFileSync(checkpoint.filePath('sandbox.json'), JSON.stringify(sandboxResult, null, 2));
        checkpoint.markCompleted('sandbox');
        if (sandboxResult.skipped) {
          log('ℹ️  [SANDBOX] Docker 미사용 — 건너뜀', 'system');
        } else if (sandboxResult.ok) {
          log('✅ [SANDBOX] 모든 테스트 통과', 'success');
        } else {
          sandboxOk = false;
          log(`❌ [SANDBOX] 테스트 실패: ${sandboxResult.errors?.join(', ')}`, 'error');
        }
      } catch (e) {
        log(`⚠️  [SANDBOX] 건너뜀: ${e.message}`, 'warn');
      }
    }

    // ── 10. FIX AI LOOP — 자동 수정 (최대 5회) ──────
    checkKilled();
    if (!sandboxOk && !checkpoint.isCompleted('fix_loop')) {
      log('🔧 [FIX AI] 자동 수정 루프 시작...', 'warn');
      const fixAgent = new FixAgent();
      let fixAttempt = 0;
      const maxRetries = parseInt(process.env.MAX_FIX_RETRIES || '5');

      while (!sandboxOk && fixAttempt < maxRetries) {
        fixAttempt++;
        log(`🔧 [FIX AI] 수정 시도 ${fixAttempt}/${maxRetries}...`);
        const fixResult = await fixAgent.repairCode({
          files: allGeneratedFiles,
          errors: [],
          type: 'runtime',
          attempt: fixAttempt,
        });
        if (fixResult.escalate) {
          log('⚠️  [FIX AI] 최대 시도 초과 — 수동 검토 필요', 'warn');
          break;
        }
        allGeneratedFiles = fixResult.files;
        const validator2 = new RuntimeValidator();
        const recheck = await validator2.validate([...allGeneratedFiles, ...testFiles]);
        if (recheck.ok || recheck.skipped) {
          sandboxOk = true;
          log(`✅ [FIX AI] ${fixAttempt}번 시도만에 수정 완료`, 'success');
        }
      }
      checkpoint.markCompleted('fix_loop');
    }

    // ── 11. FILE WRITER — 실제 파일시스템에 적용 ────
    checkKilled();
    let writeResult = { total: 0, success: false, errors: [] };
    let prResult = null;

    if (allGeneratedFiles.length > 0 && !checkpoint.isCompleted('file_writer')) {
      const applyFiles = process.env.AUTO_APPLY_FILES !== 'false'; // 기본 ON
      if (applyFiles && projectRoot) {
        log(`💾 [FILE WRITER] ${allGeneratedFiles.length}개 파일 적용 중...`);
        agentStart('integrator', `${allGeneratedFiles.length}개 파일 적용 중...`);
        const writer = new FileWriter(projectRoot, { backup: true, dryRun: false });
        writeResult = writer.writeAll(allGeneratedFiles);
        if (writeResult.errors.length > 0) {
          log(`⚠️  ${writeResult.errors.length}개 파일 쓰기 오류: ${writeResult.errors.map(e => e.path).join(', ')}`, 'warn');
        }
        if (writeResult.skipped && writeResult.skipped.length > 0) {
          log(`⚠️  ${writeResult.skipped.length}개 파일 쓰기 스킵(보안 차단 등): ${writeResult.skipped.map(s => s.path).join(', ')}`, 'warn');
        }
        log(`✅ [FILE WRITER] ${writeResult.total}개 파일 적용 완료`, 'success');
        checkpoint.markCompleted('file_writer');
        agentDone('integrator', 0);
      } else {
        log(`ℹ️  [FILE WRITER] AUTO_APPLY_FILES=false — 파일 적용 건너뜀 (확인 후 수동 적용)`);
      }
    }

    // ── 12. GITHUB PR — 자동 브랜치 + PR 생성 ────────
    if (process.env.GITHUB_TOKEN && projectRoot && !checkpoint.isCompleted('github_pr')) {
      checkKilled();
      log('🐙 [GITHUB PR] 브랜치 생성 및 PR 오픈 중...');
      const branchName = `agent/session-${sessionNumber}-${Date.now()}`;
      const gh = new GitHubIntegration({
        projectRoot,
        token: process.env.GITHUB_TOKEN,
        owner: process.env.GITHUB_OWNER,
        repo:  process.env.GITHUB_REPO,
        baseBranch: process.env.GITHUB_BASE_BRANCH || 'main',
      });

      const prBody = GitHubIntegration.buildPRBody({
        sessionNumber,
        sessionTitle: session.title,
        tasksCount: session.tasks.length,
        filesChanged: allGeneratedFiles.length,
        cost: tracker.summary().totalUSD,
        reviewScore: reviewResult?.score,
        summary: reviewResult?.issues?.slice(0, 3).map(i => `- **${i.severity}**: ${i.message}`).join('\n'),
      });

      prResult = await gh.commitAndPR({
        branchName,
        commitMessage: `feat(agent): Session ${sessionNumber} — ${session.title}`,
        title: `🤖 [Agent] Session ${sessionNumber}: ${session.title}`,
        body: prBody,
      });

      if (prResult?.ok) {
        log(`✅ [GITHUB PR] PR 생성됨: ${prResult.url}`, 'success');
        checkpoint.markCompleted('github_pr');
      } else {
        log(`⚠️  [GITHUB PR] PR 생성 실패: ${prResult?.error}`, 'warn');
      }
    }

    // ── 13. 최종 리포트 ──────────────────────────────
    checkKilled();
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const costSummary = tracker.summary();
    const filesChanged = allGeneratedFiles.length;

    const summary = [
      `Session ${sessionNumber} 완료`,
      `태스크: ${session.tasks.length}개`,
      `적용 파일: ${writeResult.total}개 / 생성: ${filesChanged}개`,
      `검토 점수: ${reviewResult?.score || '—'}/100`,
      `PR: ${prResult?.url || '없음'}`,
      `소요 시간: ${duration}초`,
      `총 비용: $${costSummary.totalUSD.toFixed(4)}`,
    ].join('\n');

    log(`\n${'━'.repeat(40)}\n${summary}\n${'━'.repeat(40)}`, 'success');
    checkpoint.save({ stage: 'completed', ...costSummary });

    // Slack 알림
    await notifier.notifySessionComplete({
      projectName: path.basename(projectRoot || 'project'),
      sessionName: `Session ${sessionNumber}: ${session.title}`,
      duration: `${duration}초`,
      costUSD: costSummary.totalUSD,
      filesChanged,
      deployURL: prResult?.url || null,
      summary,
    });

    return {
      ok: true,
      sessionNumber,
      session,
      workerResults,
      reviewResult,
      writeResult,
      prResult,
      cost: costSummary,
      duration,
    };

  } catch (err) {
    log(`❌ 오케스트레이터 오류: ${err.message}`, 'error');
    await notifier.notifyEmergency(`Session ${sessionNumber} 실패: ${err.message}`);
    throw err;
  }
}

/* ── PROMPT BUILDERS ─────────────────────────────── */
function buildArchitectPrompt(session, projectRoot) {
  return `프로젝트 루트: ${projectRoot || '(미지정)'}

세션 제목: ${session.title}
세션 설명: ${session.description}

태스크 목록:
${session.tasks.map(t => `- ${t.id}: ${t.title}\n  파일: ${t.files.join(', ')}\n  내용: ${t.description}`).join('\n')}

위 세션을 구현하기 위한 프로젝트 구조, 파일 인터페이스, 타입 정의, 공통 유틸리티를 설계해주세요.
JSON 형식: {"structure": {...}, "interfaces": {...}, "conventions": [...]}`;
}

function buildOrchestratorPrompt(session, architectOutput) {
  return `아키텍처 설계도:
${JSON.stringify(architectOutput, null, 2).slice(0, 1500)}

세션 태스크:
${session.tasks.map(t => `- ID: ${t.id}, 제목: ${t.title}, 파일: ${t.files.join(', ')}`).join('\n')}

파일 충돌이 없도록 독립적인 워커 그룹으로 태스크를 분배해주세요.
JSON 배열: [{"id": "...", "title": "...", "files": [...], "description": "..."}]`;
}

function buildWorkerPrompt(tasks, architectOutput, repoContext = '') {
  const taskList = tasks.map(t =>
    `태스크: ${t.title || t.id}\n파일: ${(t.files||[]).join(', ')}\n내용: ${t.description || ''}`
  ).join('\n\n');

  const archCtx = architectOutput ?
    `\n\n아키텍처 가이드:\n${JSON.stringify(architectOutput?.conventions || [], null, 2).slice(0, 800)}` : '';

  const ctxBlock = repoContext ? `\n\n${repoContext}` : '';

  return `${archCtx}${ctxBlock}

구현할 태스크:
${taskList}

위 태스크를 완전히 구현한 코드를 제공하세요.
기존 코드와의 일관성을 유지하고, 위 컨텍스트에 있는 함수/클래스를 중복 구현하지 마세요.
JSON 형식: {"files": [{"path": "파일경로", "content": "전체 파일 내용"}]}`;
}

function buildDesignerPrompt(files) {
  const preview = files.slice(0, 5).map(f =>
    `=== ${f.path} ===\n${(f.content || '').slice(0, 500)}`
  ).join('\n\n');

  return `다음 UI 코드를 검토하고 디자인 개선을 제안하세요:\n\n${preview}\n\nJSON: {"suggestions": [{"file": "...", "issue": "...", "fix": "..."}]}`;
}

function buildReviewerPrompt(files) {
  const preview = files.slice(0, 10).map(f =>
    `=== ${f.path} ===\n${(f.content || '').slice(0, 600)}`
  ).join('\n\n');

  return `당신은 시니어 소프트웨어 아키텍트 겨해 교육 멘토입니다.
다음 코드를 상세히 분석하여 보안, 품질, 교유적 리뷰를 제공하세요.

${preview}

## 요구 사항
각 파일에 대해 다음을 포함하세요:
1. **사용된 타기술 & 도구**: 어떤 프레임워크, 패턴, 라이브러리를 사용했는지 표기 (예: React hooks, Firestore onSnapshot 등)
2. **사용 이유**: 왜 이 접근법 / 학수를 택했는지 설명 (예: useEffect를 싼 이유, 웨 소켓 vs polling)
3. **보안 검토**: XSS, CSRF, 인증 누락, SQL 인젝션 등 취약점 이슈
4. **품질 평가**: 코드 복잡도, 덕업링, 네이밍, SRP 위반 등
5. **개선 안**: 구체적인 코드 예시를 포함한 개선안 (‘모호할수 있다’가 아니라 ‘이렇게 블해라’)
6. **학습 탁쿤**: 이 코드에서 배울 수 있는 핑 주요 개념 1개 나열

응답 JSON 형식:
{
  "score": 0-100,
  "summary": "전체 코드 질 평가의 한 줄 요약",
  "files": [
    {
      "path": "...",
      "techniques": [
        {"name": "기법/도구 이름", "reason": "왜 사용했는지", "example": "코드 예"}
      ],
      "issues": [
        {"severity": "high|medium|low", "type": "보안|품질|성능|변수명", "message": "상세 문제 설명", "fix": "구체적 해결 코드"}
      ],
      "learning_tip": "이 파일에서 배울 핀 핵심 개념"
    }
  ]
}`;
}

/* ── HELPERS ─────────────────────────────────────── */
function parseJsonSafe(text) {
  try {
    // JSON 블록 추출 시도
    const match = String(text).match(/```json\n?([\s\S]*?)\n?```/) ||
                  String(text).match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    const jsonStr = match ? match[1] || match[0] : text;
    return JSON.parse(jsonStr.trim());
  } catch {
    return { raw: text };
  }
}

/* ── runDirect: plan.md 없이 직접 프롬프트로 돌림 (v4.1) ─ */
async function runDirect({ prompt, taskTitle, projectRoot, broadcast, onAgentStart, onAgentDone }) {
  const log = (msg, type = 'system') => {
    console.log(`[Direct] ${msg}`);
    if (broadcast) broadcast(msg, type);
  };

  const agentStart = (role, task) => { if (onAgentStart) onAgentStart(role, task); };
  const agentDone  = (role, cost) => { if (onAgentDone)  onAgentDone(role, cost); };

  const startTime = Date.now();
  const tracker = new CostTracker({});

  log('🚀 [DIRECT] 직접 프롬프트 모드 시작', 'start');

  try {
    // 1. ARCHITECT
    log('🏗 [ARCHITECT] 구조 설계 중...');
    agentStart('architect', '구조 설계 중...');
    const archResult = await callAgent('architect', [
      { role: 'system', content: '당신은 소프트웨어 아키텍트입니다. JSON으로만 응답하세요.' },
      { role: 'user', content: `다음 작업을 위한 프로젝트 구조를 설계해주세요:\n\n${prompt}\n\nJSON: {"structure": {}, "interfaces": {}, "conventions": []}` },
    ], { temperature: 0.1, max_tokens: 2048 });
    tracker.record({ model: process.env.AGENT_ARCHITECT, role: 'architect', costUSD: archResult.costUSD, tokens: archResult.usage.total_tokens });
    const architectOutput = parseJsonSafe(archResult.content);
    agentDone('architect', archResult.costUSD);
    log(`✅ [ARCHITECT] 완료 ($${archResult.costUSD.toFixed(4)})`);

    // 2. WORKER (+ 레포 컨텍스트 주입)
    log('⚡ [WORKER] 코드 구현 중...');
    agentStart('worker', '코드 구현 중...');
    const workerContext = architectOutput
      ? `\n\n아키텍처 가이드:\n${JSON.stringify(architectOutput?.conventions || [], null, 2).slice(0, 600)}`
      : '';
    let repoCtxDirect = '';
    if (projectRoot) {
      try {
        const { indexRepository } = require('./repo-indexer');
        indexRepository(projectRoot);
        repoCtxDirect = buildContextString(prompt, projectRoot);
        if (repoCtxDirect) log('📂 [REPO INDEX] 레포 컨텍스트 주입됨', 'system');
      } catch { /* 색인 실패 시 무시 */ }
    }
    const workerResult = await callAgent('worker', [
      { role: 'system', content: '당신은 시니어 풀스택 개발자입니다. 주어진 태스크의 코드를 완벽하게 구현하세요. 파일 경로(path)는 슬래시(/)나 점(.)으로 시작하지 않는 순수 상대경로(예: "src/app/page.tsx")만 사용하세요. 응답은 반드시 순수 JSON 형태만 출력하세요: {"files": [{"path": "...", "content": "..."}]}' },
      { role: 'user', content: `${workerContext}${repoCtxDirect ? '\n\n' + repoCtxDirect : ''}\n\n작업: ${prompt}\n\n기존 코드와 일관성을 유지하고 중복 구현을 피하세요.\nJSON {"files": [{"path": "...", "content": "..."}]}로 응답` },
    ], { temperature: 0.2, max_tokens: 8192 });
    tracker.record({ model: process.env.AGENT_WORKER, role: 'worker', costUSD: workerResult.costUSD, tokens: workerResult.usage.total_tokens });
    const workerFiles = parseJsonSafe(workerResult.content)?.files || [];
    agentDone('worker', workerResult.costUSD);
    log(`✅ [WORKER] 완료 (${workerFiles.length}개 파일, $${workerResult.costUSD.toFixed(4)})`);

    // 3. REVIEWER (교육용 상세 리뷰)
    log('🔍 [REVIEWER] 교육용 코드 리뷰 중...');
    agentStart('reviewer', '교육용 상세 리뷰 중...');
    const reviewPrompt = buildReviewerPrompt(workerFiles);
    const reviewResult = await callAgent('reviewer', [
      { role: 'system', content: '당신은 시니어 아키텍트 겸 교육 멘토입니다. 코드의 기법, 도구, 이유를 아주 구체적으로 설명하여 JSON으로 리뷰하세요.' },
      { role: 'user', content: reviewPrompt },
    ], { temperature: 0.1, max_tokens: 8192 });
    tracker.record({ model: process.env.AGENT_REVIEWER, role: 'reviewer', costUSD: reviewResult.costUSD, tokens: reviewResult.usage.total_tokens });
    const review = parseJsonSafe(reviewResult.content);
    agentDone('reviewer', reviewResult.costUSD);
    log(`✅ [REVIEWER] 리뷰 완료 (점수: ${review?.score || '?'}/100, $${reviewResult.costUSD.toFixed(4)})`, 'success');

    // 리뷰 상세 로그 출력
    if (review?.files) {
      for (const fr of review.files) {
        log(`\n📊 [${fr.path}]`, 'system');
        (fr.techniques || []).forEach(t => log(`  🔧 ${t.name}: ${t.reason}`, 'log'));
        (fr.issues || []).forEach(i => log(`  [${i.severity?.toUpperCase()}] ${i.message}`, i.severity === 'high' ? 'error' : 'warn'));
        if (fr.learning_tip) log(`  🎓 학습 팁: ${fr.learning_tip}`, 'success');
      }
    }

    // 4. FILE WRITER
    let writeResult = { total: 0, errors: [] };
    if (workerFiles.length > 0 && projectRoot) {
      const FileWriter = require('./file-writer');
      const writer = new FileWriter(projectRoot, { backup: true, dryRun: false });
      writeResult = writer.writeAll(workerFiles);
      log(`💾 [FILE WRITER] ${writeResult.total}개 파일 적용 완료`);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const costSummary = tracker.summary();
    log(`\n${'━'.repeat(40)}\n🎉 직접 실행 완료\n적용 파일: ${writeResult.total}개\n소요 시간: ${duration}초\n총 비용: $${costSummary.totalUSD.toFixed(4)}\n${'━'.repeat(40)}`, 'success');

    return { ok: true, workerFiles, review, writeResult, cost: costSummary, duration };

  } catch (err) {
    log(`❌ [DIRECT] 오류: ${err.message}`, 'error');
    throw err;
  }
}

/* ── CLI ─────────────────────────────────────────── */
if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };

  const planPath     = get('--plan') || './plan.md';
  const sessionNum   = parseInt(get('--session') || '1');
  const projectRoot  = get('--project') || process.cwd();
  const directPrompt = get('--prompt');

  if (directPrompt) {
    runDirect({ prompt: directPrompt, projectRoot, broadcast: null })
      .then(r => { console.log(`\n✅ 완료! 총 비용: $${r.cost.totalUSD.toFixed(4)}`); process.exit(0); })
      .catch(err => { console.error(`\n❌ 실패: ${err.message}`); process.exit(1); });
  } else {
    run({ planPath, sessionNumber: sessionNum, projectRoot, broadcast: null })
      .then(r => { console.log(`\n✅ 완료! 총 비용: $${r.cost.totalUSD.toFixed(4)}`); process.exit(0); })
      .catch(err => { console.error(`\n❌ 실패: ${err.message}`); process.exit(1); });
  }
}

module.exports = { run, runDirect };
