/**
 * GitHub Integration — v5.0
 * 오케스트레이터 실행 후 자동으로 브랜치 생성, 커밋, PR을 만듭니다.
 * v5.0: execFileSync 배열 방식(보안), 중복 PR 방지
 */

const { execFileSync } = require('child_process');
const https = require('https');

class GitHubIntegration {
  constructor(opts = {}) {
    this.projectRoot = opts.projectRoot || process.cwd();
    this.token       = opts.token || process.env.GITHUB_TOKEN;
    this.baseBranch  = opts.baseBranch || 'main';

    const detected = this._detectRepoInfo();
    this.owner = opts.owner || process.env.GITHUB_OWNER || detected.owner;
    this.repo  = opts.repo  || process.env.GITHUB_REPO  || detected.repo;
  }

  /** git remote -v 에서 owner/repo 추출 */
  _detectRepoInfo() {
    try {
      const remotes = this._git('remote', '-v');
      const match = remotes.match(/github\.com[:/]([^/]+)\/([^/.\s]+)/);
      if (match) return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
    } catch { /* ignore */ }
    return { owner: null, repo: null };
  }

  /** 안전한 Git 실행 헬퍼 — 인자를 배열로 전달 (shell injection 방지) */
  _git(...args) {
    return execFileSync('git', args, { cwd: this.projectRoot, encoding: 'utf8' }).trim();
  }

  /** 새 브랜치 생성 + 커밋 + push */
  commitChanges({ branchName, commitMessage, files }) {
    const currentBranch = this._git('branch', '--show-current');
    try {
      try {
        this._git('checkout', '-b', branchName);
      } catch {
        this._git('checkout', branchName);
      }

      if (files && files.length > 0) {
        files.forEach(f => this._git('add', f));
      } else {
        this._git('add', '-A');
      }

      this._git('commit', '-m', commitMessage);
      this._git('push', 'origin', branchName);

      return { ok: true, branch: branchName, baseBranch: this.baseBranch };
    } catch (err) {
      try { this._git('checkout', currentBranch); } catch { /* ignore */ }
      return { ok: false, error: err.message };
    }
  }

  /** 기존 오픈 PR 조회 (중복 방지) */
  async _findExistingPR(branchName) {
    if (!this.token || !this.owner || !this.repo) return null;
    return new Promise((resolve) => {
      const req = https.request({
        hostname: 'api.github.com',
        path: `/repos/${this.owner}/${this.repo}/pulls?head=${this.owner}:${branchName}&state=open`,
        method: 'GET',
        headers: {
          'Authorization': `token ${this.token}`,
          'User-Agent': 'agent-mission-control',
        },
      }, (res) => {
        let data = '';
        res.on('data', d => { data += d; });
        res.on('end', () => {
          try {
            const prs = JSON.parse(data);
            resolve(Array.isArray(prs) && prs.length > 0 ? prs[0] : null);
          } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.end();
    });
  }

  /** GitHub API — Pull Request 생성 (중복 시 기존 PR URL 반환) */
  async createPR({ branchName, title, body, labels = [] }) {
    if (!this.token || !this.owner || !this.repo) {
      return { ok: false, error: 'GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO 환경변수 필요' };
    }

    // 중복 PR 방지
    const existing = await this._findExistingPR(branchName);
    if (existing) {
      console.log(`[GitHub] 이미 오픈 PR 존재 — #${existing.number}: ${existing.html_url}`);
      return { ok: true, url: existing.html_url, number: existing.number, duplicate: true };
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
              let msg = json.message || data;
              if (json.errors) msg += ' : ' + JSON.stringify(json.errors);
              resolve({ ok: false, error: msg });
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

  /** 커밋 + PR 원스톱 */
  async commitAndPR({ branchName, commitMessage, title, body, files, labels }) {
    const commitResult = this.commitChanges({ branchName, commitMessage, files });
    if (!commitResult.ok) return commitResult;
    const prResult = await this.createPR({ branchName, title, body, labels });
    return { ...commitResult, ...prResult };
  }

  /** PR 본문 자동 생성 */
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

> 🤖 이 PR은 **Agent Mission Control v5.0**에 의해 자동으로 생성되었습니다.
> 반드시 사람이 검토하고 머지하세요.`;
  }
}

module.exports = GitHubIntegration;
