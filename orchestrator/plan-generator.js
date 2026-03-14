/**
 * Plan Generator — v5.0
 * 자연어 요청 → plan.md 형식의 새 세션 블록 AI 자동 생성
 * 기존 plan.md를 덮어쓰지 않고 끝에 append만 수행
 */

const fs             = require('fs');
const path           = require('path');
const { callAgent }  = require('./openrouter-client');
const { parsePlan }  = require('./plan-parser');
const logger         = require('./logger');

/**
 * 자연어 요청을 받아 plan.md 세션 블록을 AI로 생성합니다.
 * @param {string} prompt      - 자연어 요청 (예: "결제 기능 추가해줘")
 * @param {string} planPath    - 기존 plan.md 경로
 * @returns {{ sessionNumber, title, sessionBlock }}
 */
async function generateSessionBlock(prompt, planPath) {
  const timer = logger.stage('plan-generator');

  // 기존 plan.md에서 마지막 세션 번호 계산
  let nextSessionNumber = 1;
  let existingContext = '';
  if (fs.existsSync(planPath)) {
    try {
      const { sessions } = parsePlan(planPath);
      if (sessions.length > 0) {
        nextSessionNumber = Math.max(...sessions.map(s => s.number)) + 1;
        existingContext = `기존 세션 목록:\n${sessions.map(s => `- Session ${s.number}: ${s.title}`).join('\n')}\n\n`;
      }
    } catch { /* 파싱 실패 시 1번부터 시작 */ }
  }

  const systemPrompt = `당신은 소프트웨어 프로젝트 플래닝 전문가입니다.
사용자의 자연어 요청을 분석하여 plan.md 형식의 세션 블록을 생성합니다.

plan.md 형식 규칙:
## Session N: 세션 제목
- 목표: 간략한 목표 설명

### Task N.1: 태스크 제목
파일: 상대경로/파일명.ext
내용: 구체적인 구현 내용 설명

### Task N.2: 태스크 제목
파일: 상대경로/파일명.ext
내용: 구체적인 구현 내용 설명

규칙:
- 태스크는 파일 단위로 세분화 (하나의 태스크 = 하나의 파일 그룹)
- 파일 경로는 슬래시로 시작하지 않는 순수 상대경로
- 태스크는 3~7개가 적절
- 응답은 세션 블록만 출력 (설명, 마크다운 코드블록 없음)`;

  const userPrompt = `${existingContext}다음 요청에 대한 Session ${nextSessionNumber} 블록을 생성해주세요:

"${prompt}"

Session ${nextSessionNumber}부터 시작하는 plan.md 세션 블록만 출력하세요.`;

  const result = await callAgent('architect', [
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: userPrompt },
  ], { temperature: 0.2, max_tokens: 2048 });

  const sessionBlock = cleanBlock(result.content, nextSessionNumber);
  const titleMatch = sessionBlock.match(/^## Session \d+[:\s]+(.+)/m);
  const title = titleMatch ? titleMatch[1].trim() : `Session ${nextSessionNumber}`;

  timer.done({ data: { sessionNumber: nextSessionNumber, title } });
  return { sessionNumber: nextSessionNumber, title, sessionBlock };
}

/**
 * 생성된 세션 블록을 plan.md 끝에 추가합니다.
 * @param {string} planPath    - plan.md 경로
 * @param {string} sessionBlock - 추가할 세션 블록 텍스트
 */
function appendSessionToPlan(planPath, sessionBlock) {
  const block = sessionBlock.trim();
  if (fs.existsSync(planPath)) {
    const existing = fs.readFileSync(planPath, 'utf8').trimEnd();
    fs.writeFileSync(planPath, `${existing}\n\n${block}\n`, 'utf8');
  } else {
    fs.writeFileSync(planPath, `${block}\n`, 'utf8');
  }
}

// AI가 코드 블록(```)이나 앞 설명을 포함할 경우 정리
function cleanBlock(text, sessionNumber) {
  let t = String(text).trim();
  // 마크다운 코드블록 제거
  t = t.replace(/^```[\w]*\n?/m, '').replace(/\n?```$/m, '').trim();
  // ## Session N 헤더로 시작하도록 보정
  if (!t.startsWith('## Session')) {
    const idx = t.indexOf(`## Session ${sessionNumber}`);
    if (idx >= 0) t = t.slice(idx);
    else t = `## Session ${sessionNumber}: 새 세션\n\n${t}`;
  }
  return t;
}

module.exports = { generateSessionBlock, appendSessionToPlan };
