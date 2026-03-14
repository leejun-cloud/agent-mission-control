/**
 * Plan Parser — v5.1
 * plan.md → 세션 / 태스크 / 서브태스크 3단계 계층 파싱
 *
 * 형식:
 *   ## Session N: 큰 제목
 *   ### Task N.1: 중간 제목
 *   파일: path/to/file.js
 *   내용: 설명
 *   #### 세부 항목 (선택)
 *   - [ ] 작은 항목 1
 *   - [x] 완료 항목
 *   - 일반 항목
 */

const fs   = require('fs');
const path = require('path');

function parsePlan(planPath) {
  if (!fs.existsSync(planPath)) {
    throw new Error(`plan.md not found: ${planPath}`);
  }

  const raw = fs.readFileSync(planPath, 'utf8');
  const sessions = [];
  const sessionBlocks = raw.split(/^## /m).filter(Boolean);

  for (const block of sessionBlocks) {
    const lines = block.split('\n');
    const header = lines[0].trim();

    const sessionMatch = header.match(/^Session\s+(\d+)[:\s]+(.+)/i) ||
                         header.match(/^(\d+)[:\s.]+(.+)/);
    const sessionNumber = sessionMatch ? parseInt(sessionMatch[1]) : sessions.length + 1;
    const sessionTitle  = sessionMatch ? sessionMatch[2].trim() : header;

    const taskBlocks = block.split(/^### /m).slice(1);
    const body       = block.split(/^### /m)[0];

    const tasks = taskBlocks.map((taskBlock, idx) => {
      const taskLines  = taskBlock.split('\n');
      const taskHeader = taskLines[0].trim();
      const taskBody   = taskLines.slice(1).join('\n').trim();

      const taskMatch = taskHeader.match(/^Task\s+[\d.]+[:\s]+(.+)/i) ||
                        taskHeader.match(/^[\d.]+[:\s]+(.+)/);
      const taskTitle = taskMatch ? taskMatch[1].trim() : taskHeader;

      const fileMatches = taskBody.match(/(?:파일|File)[:\s]+([^\n]+)/gi) || [];
      const files = fileMatches.map(m => m.replace(/(?:파일|File)[:\s]+/i, '').trim());

      const contentMatch = taskBody.match(/(?:내용|Content)[:\s]+([\s\S]+?)(?=\n(?:파일|File|####|-)|$)/i);
      const description  = contentMatch ? contentMatch[1].trim() : taskBody.slice(0, 200);

      // ── 서브태스크 파싱 ──────────────────────────────
      const subtasks = [];

      // #### 소제목 섹션 분리
      // subSections[0]: #### 이전 본문, subSections[1+]: #### 이후 섹션
      const subSections = taskBody.split(/^#### /m);
      subSections.forEach((section, sIdx) => {
        const sLines = section.split('\n');
        // #### 이후 섹션만 sTitle 사용; 본문(sIdx===0)은 section=null
        const sTitle = sIdx === 0 ? null : sLines[0].trim();
        const bodyLines = sIdx === 0 ? sLines : sLines.slice(1);
        for (const line of bodyLines) {
          const checkedMatch   = line.match(/^-\s+\[x\]\s+(.+)/i);
          const uncheckedMatch = line.match(/^-\s+\[\s*\]\s+(.+)/);
          const bulletMatch    = line.match(/^-\s+(?!\[)(.+)/);
          if (checkedMatch)        subtasks.push({ text: checkedMatch[1].trim(),   checked: true,  section: sTitle });
          else if (uncheckedMatch) subtasks.push({ text: uncheckedMatch[1].trim(), checked: false, section: sTitle });
          else if (bulletMatch)    subtasks.push({ text: bulletMatch[1].trim(),    checked: false, section: sTitle });
        }
      });

      return {
        id: `${sessionNumber}.${idx + 1}`,
        title: taskTitle,
        files,
        description,
        subtasks,
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

function getSession(planPath, sessionNumber) {
  const { sessions } = parsePlan(planPath);
  const session = sessions.find(s => s.number === sessionNumber);
  if (!session) {
    throw new Error(`Session ${sessionNumber} not found in ${planPath}. Available: ${sessions.map(s => s.number).join(', ')}`);
  }
  return session;
}

function partitionTasks(tasks) {
  const fileToGroup = new Map();
  const groups = [];

  for (const task of tasks) {
    let assignedGroup = null;
    for (const file of task.files) {
      if (fileToGroup.has(file)) { assignedGroup = fileToGroup.get(file); break; }
    }
    if (assignedGroup === null) { assignedGroup = groups.length; groups.push([]); }
    groups[assignedGroup].push(task);
    for (const file of task.files) fileToGroup.set(file, assignedGroup);
  }

  return groups;
}

module.exports = { parsePlan, getSession, partitionTasks };
