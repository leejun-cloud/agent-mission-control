/**
 * GitHub Integration
 * 오케스트레이터 실행 후 자동으로 브랜치 생성, 커밋, PR을 만듭니다.
 *
 * 사용 예시:
 *   const gh = new GitHubIntegration({ projectRoot: '/root/my-project' });
 *   await gh.createPR({ branchName: 'agent/session-3', title: '...', body: '...' });
 */

const { execSync, exec } = require('child_process');
const https = require('https');

class GitHubIntegration {
  /**
   * @param {Object} opts
   * @param {string} opts.projectRoot - Git 레포 루트
   * @param {string} opts.token - GitHub Personal Access Token (GITHUB_TOKEN)
   * @param {string} opts.owner - GitHub 레포 소유자 (leejun-cloud)
   * @param {string} opts.repo  - GitHub 레포명 (famiy-achive)
   * @param {string} opts.baseBranch - PR 대상 브랜치 (기본: main)
   */
  constructor(opts = {}) {
    this.projectRoot = opts.projectRoot || process.cwd();
    this.token       = opts.token || process.env.GITHUB_TOKEN;
    this.owner       = opts.owner || process.env.GITHUB_OWNER;
    this.repo        = opts.repo  || process.env.GITHUB_REPO;
    this.baseBranch  = opts.baseBranch || 'main';
  }

  /**
   * Git 명령 실행 헬퍼
   */
  _git(cmd) {
    return execSync(`git ${cmd}`, { cwd: this.projectRoot, encoding: 'utf8' }).trim();
  }

  /**
   * 새 브랜치를 만들고 변경사항을 커밋합니다.
   * @param {Object} opts
   * @param {string} opts.branchName - 브랜치명 (예: 'agent/session-3-auth')
   * @param {string} opts.commitMessage - 커밋 메세지
   * @param {string[]} opts.files - 커밋할 파일 목록 (없으면 all)
   */
  commitChanges({ branchName, commitMessage, files }) {
    // 현재 브랜치 저장
    const currentBranch = this._git('branch --show-current');

    try {
      // 브랜치 생성 또는 전환
      try {
        this._git(`checkout -b ${branchName}`);
      } catch {
        this._git(`checkout ${branchName}`);
      }

      // 파일 스테이징
      if (files && files.length > 0) {
        files.forEach(f => this._git(`add "${f}"`));
      } else {
        this._git('add -A');
      }

      // 커밋
      this._git(`commit -m "${commitMessage.replace(/"/g, "'")}"`);

      // 푸시
      this._git(`push origin ${branchName}`);

      return { ok: true, branch: branchName, baseBranch: this.baseBranch };
    } catch (err) {
      // 원래 브랜치로 복귀
      try { this._git(`checkout ${currentBranch}`); } catch {}
      return { ok: false, error: err.message };
    }
  }

  /**
   * GitHub API를 통해 Pull Request를 생성합니다.
   * @param {Object} opts
   * @param {string} opts.branchName - 소스 브랜치
   * @param {string} opts.title - PR 제목
   * @param {string} opts.body  - PR 본문 (마크다운)
   * @param {string[]} opts.labels - 라벨 (선택)
   * @returns {Promise<Object>} PR 정보 { url, number }
   */
  async createPR({ branchName, title, body, labels = [] }) {
    if (!this.token || !this.owner || !this.repo) {
      return { ok: false, error: 'GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO 환경변수 필요' };
    }

    const payload = JSON.stringify({
      title,
      body,
      head: branchName,
      base: this.baseBranch,
      draft: false,
    });

    return new Promise((resolve) => {
      const req = https.request({
        hostname: 'api.github.com',
        path: `/repos/${this.owner}/${this.repo}/pulls`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `token ${this.token}`,
          'User-Agent': 'agent-mission-control',
          'Content-Length': Buffer.byteLength(payload),
        },
      }, (res) => {
        let data = '';
        res.on('data', d => { data += d; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.html_url) {
              resolve({ ok: true, url: json.html_url, number: json.number });
            } else {
              resolve({ ok: false, error: json.message || data });
            }
          } catch {
            resolve({ ok: false, error: data });
          }
        });
      });
      req.on('error', err => resolve({ ok: false, error: err.message }));
      req.write(payload);
      req.end();
    });
  }

  /**
   * 커밋 + PR 생성 원스톱 메서드
   */
  async commitAndPR({ branchName, commitMessage, title, body, files, labels }) {
    const commitResult = this.commitChanges({ branchName, commitMessage, files });
    if (!commitResult.ok) return commitResult;

    const prResult = await this.createPR({ branchName, title, body, labels });
    return { ...commitResult, ...prResult };
  }

  /**
   * PR 본문 자동 생성 (오케스트레이터 결과 기반)
   */
  static buildPRBody({ sessionNumber, sessionTitle, tasksCount, filesChanged, cost, reviewScore, summary }) {
    return `## 🛰 Agent Mission Control — 자율 개발 완료

**Session**: ${sessionNumber} — ${sessionTitle}  
**태스크**: ${tasksCount}개  
**변경 파일**: ${filesChanged}개  
**AI 비용**: $${(cost || 0).toFixed(4)}  
**코드 검토 점수**: ${reviewScore || '—'}/100  

---

### 변경 요약
${summary || '(자동 생성)'}

---

> 🤖 이 PR은 **Agent Mission Control v3.0**에 의해 자동으로 생성되었습니다.
> 반드시 사람이 검토하고 머지하세요.`;
  }
}

module.exports = GitHubIntegration;
