/**
 * Plan Parser
 * plan.md 파일을 파싱하여 세션과 태스크로 분해합니다.
 *
 * plan.md 형식 예시:
 *   ## Session 1: 기본 인증 구현
 *   - 목표: ...
 *
 *   ### Task 1.1: 로그인 API
 *   파일: src/api/auth.js
 *   내용: JWT 로그인 엔드포인트 구현
 *
 *   ### Task 1.2: 회원가입 API
 *   파일: src/api/auth.js
 *   내용: 이메일/비밀번호 회원가입
 */

const fs   = require('fs');
const path = require('path');

/**
 * plan.md 파일을 파싱합니다.
 * @param {string} planPath - plan.md 파일 절대 경로
 * @returns {Object} { sessions: [...], raw: '...' }
 */
function parsePlan(planPath) {
  if (!fs.existsSync(planPath)) {
    throw new Error(`plan.md not found: ${planPath}`);
  }

  const raw = fs.readFileSync(planPath, 'utf8');
  const sessions = [];

  // 세션을 ## 헤더로 분리
  const sessionBlocks = raw.split(/^## /m).filter(Boolean);

  for (const block of sessionBlocks) {
    const lines = block.split('\n');
    const header = lines[0].trim();

    // "Session N: 제목" 또는 그냥 "제목" 형식 모두 처리
    const sessionMatch = header.match(/^Session\s+(\d+)[:\s]+(.+)/i) ||
                         header.match(/^(\d+)[:\s.]+(.+)/);

    const sessionNumber = sessionMatch ? parseInt(sessionMatch[1]) : sessions.length + 1;
    const sessionTitle  = sessionMatch ? sessionMatch[2].trim() : header;

    // 태스크를 ### 헤더로 분리
    const taskBlocks = block.split(/^### /m).slice(1); // 첫 번째는 세션 설명
    const body       = block.split(/^### /m)[0];

    const tasks = taskBlocks.map((taskBlock, idx) => {
      const taskLines = taskBlock.split('\n');
      const taskHeader = taskLines[0].trim();
      const taskBody   = taskLines.slice(1).join('\n').trim();

      // Task N.M: 제목 형식 파싱
      const taskMatch = taskHeader.match(/^Task\s+[\d.]+[:\s]+(.+)/i) ||
                        taskHeader.match(/^[\d.]+[:\s]+(.+)/);
      const taskTitle = taskMatch ? taskMatch[1].trim() : taskHeader;

      // 파일 경로 추출 (파일: path 또는 File: path)
      const fileMatches = taskBody.match(/(?:파일|File)[:\s]+([^\n]+)/gi) || [];
      const files = fileMatches.map(m => m.replace(/(?:파일|File)[:\s]+/i, '').trim());

      // 내용 추출 (내용: ... 또는 Content: ...)
      const contentMatch = taskBody.match(/(?:내용|Content)[:\s]+([\s\S]+?)(?=\n(?:파일|File)|$)/i);
      const description  = contentMatch ? contentMatch[1].trim() : taskBody.slice(0, 200);

      return {
        id: `${sessionNumber}.${idx + 1}`,
        title: taskTitle,
        files,
        description,
        raw: taskBody,
      };
    });

    sessions.push({
      number: sessionNumber,
      title: sessionTitle,
      description: body.trim(),
      tasks,
    });
  }

  return { sessions, raw };
}

/**
 * 특정 세션 번호를 찾아 반환합니다.
 */
function getSession(planPath, sessionNumber) {
  const { sessions } = parsePlan(planPath);
  const session = sessions.find(s => s.number === sessionNumber);
  if (!session) {
    throw new Error(`Session ${sessionNumber} not found in ${planPath}. Available: ${sessions.map(s => s.number).join(', ')}`);
  }
  return session;
}

/**
 * 세션을 병렬 실행 가능한 독립 태스크 그룹으로 분해합니다.
 * 같은 파일을 건드리는 태스크는 같은 그룹에 배치하여 충돌 방지.
 */
function partitionTasks(tasks) {
  const fileToGroup = new Map();
  const groups = [];

  for (const task of tasks) {
    // 이 태스크가 건드리는 파일이 이미 어느 그룹에 있는지 확인
    let assignedGroup = null;

    for (const file of task.files) {
      if (fileToGroup.has(file)) {
        assignedGroup = fileToGroup.get(file);
        break;
      }
    }

    if (assignedGroup === null) {
      // 새 그룹 생성
      assignedGroup = groups.length;
      groups.push([]);
    }

    groups[assignedGroup].push(task);
    for (const file of task.files) {
      fileToGroup.set(file, assignedGroup);
    }
  }

  return groups; // [[task, task], [task], ...] — 각 그룹은 한 워커에게 할당
}

module.exports = { parsePlan, getSession, partitionTasks };
