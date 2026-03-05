# 🛰 Agent Mission Control v3.1

**명령 하나로 AI 에이전트 군단이 코드를 분석·설계·구현·검토·PR까지 자동으로 완료합니다.**

```
명령 실행 → AI 설계 → 병렬 코딩 → 코드 리뷰 → 파일 자동 적용 → GitHub PR 생성 → Slack 알림
```

---

## ✨ 주요 기능

| 기능                            | 설명                                            |
| ------------------------------- | ----------------------------------------------- |
| 🏗 **Architect AI (o3.2)**      | plan.md 분석 → 프로젝트 구조 및 인터페이스 설계 |
| 🎯 **Orchestrator AI (Claude)** | 태스크 병렬 분배 (파일 충돌 없는 그룹 생성)     |
| ⚡ **Workers AI ×N (Kimi)**     | 최대 N개 동시 코드 구현                         |
| 🎨 **Designer AI (Gemini)**     | UI/UX 코드 품질 검토 및 개선 제안               |
| 🔍 **Reviewer AI (Qwen)**       | 보안·품질 전수검사 → 점수 + 이슈 리포트         |
| 💾 **File Writer**              | 생성 코드 자동 적용 (백업 + 롤백 지원)          |
| 🐙 **GitHub PR**                | 연동 브랜치 생성 + PR 자동 오픈                 |
| 📡 **Slack 알림**               | 세션 시작/완료/예산초과 실시간 알림             |
| 🛑 **Kill Switch**              | 전체 파이프라인 즉시 중단                       |
| 💰 **예산 제어**                | 달러 한도 설정 → 초과 시 자동 중단              |

---

## 📁 프로젝트 구조

```
agent-mission-control/
├── server.js                    # Express + WebSocket 서버 (v3.0)
├── public/
│   └── dashboard.html           # 관제 대시보드 UI
├── orchestrator/
│   ├── index.js                 # ★ 8단계 자율화 파이프라인
│   ├── plan-parser.js           # plan.md → 세션/태스크 파싱
│   ├── worker-pool.js           # 병렬 워커 실행 풀
│   ├── checkpoint.js            # 중단 후 재개 (체크포인트)
│   ├── file-writer.js           # 코드 파일 자동 적용 + 롤백
│   ├── github-integration.js    # GitHub PR 자동 생성
│   ├── openrouter-client.js     # OpenRouter API 클라이언트
│   ├── cost-tracker.js          # 비용 추적 + 예산 제어
│   └── notifier.js              # Slack 웹훅 알림
├── .env.example                 # 환경 변수 템플릿
├── package.json
└── plan.md                      # 자율화할 작업 계획 파일 (직접 작성)
```

---

## 🚀 빠른 시작 (서버)

### 1. 설치

```bash
git clone https://github.com/leejun-cloud/agent-mission-control.git
cd agent-mission-control
npm install
```

### 2. 환경 설정

```bash
cp .env.example .env
nano .env  # 아래 필수 항목 입력
```

**필수 설정:**

```env
DASHBOARD_PASSWORD=your-strong-password    # 대시보드 로그인 비밀번호
OPENROUTER_API_KEY=sk-or-v1-...            # OpenRouter API 키
BUDGET_LIMIT_USD=10                        # AI 예산 한도 (달러)
SLACK_WEBHOOK_URL=https://hooks.slack.com/... # Slack 알림 웹훅
```

**GitHub PR 자동화 (선택):**

```env
GITHUB_TOKEN=ghp_...        # GitHub Personal Access Token (repo 권한)
GITHUB_OWNER=leejun-cloud   # GitHub 사용자명 또는 org명
GITHUB_REPO=famiy-achive    # 대상 레포명
AUTO_APPLY_FILES=true        # 워커 결과 자동 파일 적용 여부
```

### 3. 서버 시작

```bash
# 개발 환경
node server.js

# 프로덕션 (PM2)
pm2 start server.js --name mission-control
pm2 save
```

접속: `http://YOUR_SERVER_IP:4000`

---

## 📋 plan.md 작성 방법

오케스트레이터가 읽는 작업 계획 파일입니다. 프로젝트 루트에 `plan.md`를 만드세요.

```markdown
# Project: 내 프로젝트 이름

## Session 1: 인증 시스템 구현

### Task 1.1: JWT 로그인 API

- 파일: `src/api/auth.js`, `src/middleware/auth.js`
- 설명: POST /api/login → JWT 토큰 발급. bcrypt 비밀번호 검증.

### Task 1.2: 회원가입 API

- 파일: `src/api/register.js`
- 설명: POST /api/register → 이메일 중복 검사 + 비밀번호 해싱 후 저장.

## Session 2: UI 컴포넌트 개발

### Task 2.1: 로그인 폼

- 파일: `src/components/LoginForm.tsx`
- 설명: React 컴포넌트. 이메일/비밀번호 입력 + 유효성 검사.
```

---

## 🎮 대시보드 사용법

### ORCHESTRATE 탭 (핵심)

1. **ORCHESTRATE** 탭 클릭
2. 드롭다운에서 실행할 `plan.md` 세션 선택
3. **▶ RUN** 클릭 → 터미널에서 실시간 로그 확인
4. 8단계 파이프라인이 자동 실행됨:
   - `🏗 ARCHITECT` → `🎯 ORCHESTRATOR` → `⚡ WORKERS` → `🎨 DESIGNER` → `🔍 REVIEWER` → `💾 FILE WRITER` → `🐙 GITHUB PR` → `📡 SLACK`

### AI 에이전트 모델 변경

ORCHESTRATE 탭 하단 **AI AGENT MODEL CONFIG**에서 각 역할의 모델을 실시간 변경 가능합니다:

- 입력창에 OpenRouter 모델 ID 입력 후 `Tab` 또는 클릭 아웃
- 즉시 적용 (서버 재시작 불필요)

### 커스텀 미션

MISSIONS 탭 → **+ ADD CUSTOM MISSION**:

- `ID`: 고유 식별자
- `Label`: 화면에 표시될 이름
- `Command`: 실행할 쉘 명령어

---

## ⌨️ CLI로 직접 실행

서버 없이 터미널에서 직접 실행할 수 있습니다:

```bash
node orchestrator/index.js \
  --plan ./plan.md \
  --session 1 \
  --project /root/my-project
```

| 옵션        | 설명                         | 기본값        |
| ----------- | ---------------------------- | ------------- |
| `--plan`    | plan.md 경로                 | `./plan.md`   |
| `--session` | 실행할 세션 번호             | `1`           |
| `--project` | 파일 적용 대상 프로젝트 경로 | 현재 디렉토리 |

---

## 🔌 REST API

| Method   | Endpoint                  | 설명                    |
| -------- | ------------------------- | ----------------------- |
| POST     | `/api/auth/login`         | 로그인 → JWT 토큰       |
| GET      | `/api/agents/ai`          | AI 에이전트 상태 조회   |
| GET/POST | `/api/agents/config`      | 에이전트 모델 조회/변경 |
| GET/POST | `/api/plan`               | plan.md 조회/저장       |
| POST     | `/api/orchestrate`        | 파이프라인 실행 시작    |
| GET      | `/api/orchestrate/status` | 파이프라인 실행 상태    |
| POST     | `/api/shell`              | 임의 쉘 명령 실행       |
| GET      | `/api/cost`               | 비용 현황               |
| POST     | `/api/cost/reset`         | 비용 초기화 + 한도 변경 |
| POST     | `/api/emergency-stop`     | 전체 긴급 정지          |

모든 API는 `Authorization: Bearer <token>` 헤더 필요.

---

## 💡 AI 에이전트 커스터마이징

`.env`에서 각 역할의 OpenRouter 모델을 자유롭게 교체하세요:

```env
# 예시: 더 저렴한 모델로 교체
AGENT_ARCHITECT=openai/gpt-4o
AGENT_WORKER=deepseek/deepseek-coder
AGENT_REVIEWER=meta-llama/llama-3.1-70b-instruct:nitro
```

[OpenRouter 모델 목록](https://openrouter.ai/models) 참조.

---

## 🛡 보안 주의사항

- `DASHBOARD_PASSWORD`와 `JWT_SECRET`을 반드시 강한 값으로 변경하세요
- `GITHUB_TOKEN`은 필요한 최소 권한(repo)만 부여하세요
- `AUTO_APPLY_FILES=false`로 설정하면 파일 자동 적용 없이 검토 후 수동 적용 가능
- 파일 작성 시 프로젝트 루트 외부 경로는 자동으로 차단됩니다

---

## 📄 라이선스

MIT License — @leejun-cloud
