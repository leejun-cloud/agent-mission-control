/**
 * Deployment Agent — v5.0
 * 배포 아티팩트를 생성하고 인간 승인을 요청합니다.
 * RULE 9: Human Approval Gates — 배포 전 반드시 인간 검토
 */

const fs       = require('fs');
const path     = require('path');
const logger   = require('./logger');
const notifier = require('./notifier');

async function prepareDeployment({ projectRoot, projectName, target = 'docker', prUrl, reviewReport }) {
  const timer     = logger.stage('deploy-agent');
  const artifacts = [];
  const outDir    = path.join(projectRoot, '.agents', 'deploy');
  fs.mkdirSync(outDir, { recursive: true });

  try {
    if (target === 'docker' || target === 'k8s') {
      const p = path.join(outDir, 'Dockerfile');
      fs.writeFileSync(p, generateDockerfile(projectName), 'utf8');
      artifacts.push({ type: 'dockerfile', path: p });
    }

    if (target === 'k8s') {
      for (const [name, content] of Object.entries(generateK8sManifests(projectName))) {
        const p = path.join(outDir, name);
        fs.writeFileSync(p, content, 'utf8');
        artifacts.push({ type: 'k8s', path: p });
      }
    }

    const summary = buildApprovalSummary({ projectName, target, artifacts, prUrl, reviewReport });
    const summaryPath = path.join(outDir, 'deployment-summary.md');
    fs.writeFileSync(summaryPath, summary, 'utf8');
    artifacts.push({ type: 'summary', path: summaryPath });

    await notifier.send(`🚀 *배포 준비 완료 — 인간 승인 필요*\n프로젝트: ${projectName}\n대상: ${target}\nPR: ${prUrl || '없음'}\n\n⚠️ 자동 배포 비활성화 — 수동으로 배포하세요.`);
    timer.done({ data: { artifacts: artifacts.length, target } });
    return { ok: true, artifacts, approvalRequired: true, summary, outDir };
  } catch (err) {
    timer.fail(err);
    return { ok: false, error: err.message, approvalRequired: true, artifacts: [] };
  }
}

function buildApprovalSummary({ projectName, target, artifacts, prUrl, reviewReport }) {
  const issues = reviewReport?.issues || [];
  const highIssues = issues.filter(i => (i.severity||'').toLowerCase() === 'high');
  return `# 🚀 배포 검토 요청 — ${projectName}\n\n- **배포 대상**: ${target}\n- **PR**: ${prUrl || '없음'}\n- **고위험 이슈**: ${highIssues.length}건\n\n## 아티팩트\n${artifacts.map(a=>`- \`${path.basename(a.path)}\` (${a.type})`).join('\n')}\n\n## 체크리스트\n- [ ] PR 코드 리뷰 완료\n- [ ] 스테이징 테스트 완료\n- [ ] 고위험 보안 이슈 해결\n\n> ⚠️ 이 배포는 자동 실행되지 않습니다.\n> 생성: ${new Date().toISOString()}`;
}

function generateDockerfile(name) {
  return `FROM node:20-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci --only=production\nCOPY . .\nRUN addgroup -S app && adduser -S app -G app\nUSER app\nEXPOSE 4000\nCMD ["node", "server.js"]\n`;
}

function generateK8sManifests(name) {
  const n = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return {
    'deployment.yaml': `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: ${n}\nspec:\n  replicas: 2\n  selector:\n    matchLabels:\n      app: ${n}\n  template:\n    metadata:\n      labels:\n        app: ${n}\n    spec:\n      containers:\n        - name: ${n}\n          image: ${n}:latest\n          ports:\n            - containerPort: 4000\n`,
    'service.yaml': `apiVersion: v1\nkind: Service\nmetadata:\n  name: ${n}\nspec:\n  selector:\n    app: ${n}\n  ports:\n    - port: 80\n      targetPort: 4000\n  type: ClusterIP\n`,
  };
}

module.exports = { prepareDeployment };
