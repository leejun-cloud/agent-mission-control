/**
 * File Writer Agent
 * 오케스트레이터 워커가 반환한 files[] JSON을 실제 파일시스템에 씁니다.
 * Git diff 생성, 롤백을 위한 백업도 담당합니다.
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

class FileWriter {
  /**
   * @param {string} projectRoot - 파일을 쓸 프로젝트 루트 경로
   * @param {Object} opts
   * @param {boolean} opts.dryRun - true이면 실제로 쓰지 않고 계획만 반환
   * @param {boolean} opts.backup - true이면 덮어쓰기 전 백업 생성
   * @param {string}  opts.backupDir - 백업 디렉토리 (기본: projectRoot/.agent-backup)
   */
  constructor(projectRoot, opts = {}) {
    this.projectRoot = projectRoot;
    this.dryRun      = opts.dryRun || false;
    this.backup      = opts.backup !== false; // 기본 true
    this.backupDir   = opts.backupDir || path.join(projectRoot, '.agent-backup', `backup-${Date.now()}`);
    this.written     = [];
    this.skipped     = [];
    this.errors      = [];
  }

  /**
   * files 배열을 실제 파일시스템에 씁니다.
   * @param {Array} files - [{ path: '상대경로', content: '내용' }, ...]
   * @returns {Object} 결과 요약
   */
  writeAll(files) {
    if (!files || !files.length) return this._summary();

    if (this.backup && !this.dryRun) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }

    for (const file of files) {
      try {
        this._writeFile(file);
      } catch (err) {
        this.errors.push({ path: file.path, error: err.message });
      }
    }

    return this._summary();
  }

  _writeFile({ path: filePath, content }) {
    if (!filePath || content === undefined) return;

    // 절대경로 기호 제거 (예: "/src/app.js" -> "src/app.js")
    const safeRelPath = filePath.replace(/^[\/\\]+/, '');

    // 보안: 프로젝트 루트 밖으로 나가는 경로(예: ../../) 차단
    const absPath = path.resolve(this.projectRoot, safeRelPath);
    if (!absPath.startsWith(this.projectRoot)) {
      this.skipped.push({ path: filePath, reason: '경로 탈출 시도 차단' });
      return;
    }

    if (this.dryRun) {
      this.written.push({ path: filePath, dryRun: true, bytes: content.length });
      return;
    }

    // 기존 파일 백업
    if (this.backup && fs.existsSync(absPath)) {
      const backupPath = path.join(this.backupDir, filePath);
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      fs.copyFileSync(absPath, backupPath);
    }

    // 디렉토리 생성 후 파일 쓰기
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, 'utf8');
    this.written.push({ path: filePath, bytes: content.length });
  }

  /**
   * Git diff를 반환합니다 (파일 쓰기 후 호출).
   */
  getDiff() {
    try {
      return execSync('git diff --stat', { cwd: this.projectRoot, encoding: 'utf8' });
    } catch {
      return '';
    }
  }

  /**
   * 백업에서 원래 파일을 복원합니다.
   */
  rollback() {
    if (!fs.existsSync(this.backupDir)) return { ok: false, reason: '백업 없음' };
    const restored = [];
    const walk = (dir, rel = '') => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const relPath = path.join(rel, name);
        if (fs.statSync(full).isDirectory()) { walk(full, relPath); continue; }
        const dest = path.join(this.projectRoot, relPath);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(full, dest);
        restored.push(relPath);
      }
    };
    walk(this.backupDir);
    return { ok: true, restored };
  }

  _summary() {
    return {
      written:  this.written,
      skipped:  this.skipped,
      errors:   this.errors,
      total:    this.written.length,
      success:  this.errors.length === 0,
      backupDir: this.backup && !this.dryRun ? this.backupDir : null,
    };
  }
}

module.exports = FileWriter;
