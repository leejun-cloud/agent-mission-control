/**
 * Checkpoint Manager
 * 세션 진행 상태를 파일에 저장하고, 중단 시 재개할 수 있게 합니다.
 */

const fs   = require('fs');
const path = require('path');

class CheckpointManager {
  /**
   * @param {string} sessionId - 세션 고유 ID (예: 'session-3-1741234567')
   * @param {string} workspaceDir - 체크포인트 파일이 저장될 기본 경로
   */
  constructor(sessionId, workspaceDir = '/tmp/agent-sessions') {
    this.sessionId   = sessionId;
    this.dir         = path.join(workspaceDir, sessionId);
    this.checkpointPath = path.join(this.dir, 'checkpoint.json');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /**
   * 현재 체크포인트를 저장합니다.
   * @param {Object} state - 저장할 상태
   */
  save(state) {
    const data = {
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      ...state,
    };
    fs.writeFileSync(this.checkpointPath, JSON.stringify(data, null, 2), 'utf8');
    return data;
  }

  /**
   * 마지막 체크포인트를 불러옵니다.
   * @returns {Object|null} 저장된 상태 또는 null
   */
  load() {
    if (!fs.existsSync(this.checkpointPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.checkpointPath, 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * 특정 단계가 이미 완료되었는지 확인합니다.
   */
  isCompleted(stage) {
    const cp = this.load();
    return cp?.completedStages?.includes(stage) || false;
  }

  /**
   * 완료된 단계를 기록합니다.
   */
  markCompleted(stage) {
    const cp = this.load() || { completedStages: [] };
    if (!cp.completedStages) cp.completedStages = [];
    if (!cp.completedStages.includes(stage)) {
      cp.completedStages.push(stage);
    }
    this.save(cp);
  }

  /**
   * 파일 경로를 반환합니다 (워커 결과 저장 등에 사용).
   */
  filePath(name) {
    return path.join(this.dir, name);
  }

  /**
   * 세션 디렉토리를 삭제합니다.
   */
  clear() {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

module.exports = CheckpointManager;
