<div align="center">

# CodeMux

[English](./README.md) | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md) | **[한국어](./README.ko.md)** | [Русский](./README.ru.md)

**완전한 원격 Agent 경험을 제공하는 멀티 엔진 AI 코딩 클라이언트.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/logo.png" alt="CodeMux" width="120" />

*멀티 엔진 AI 코딩 클라이언트 — 에이전트의 완전한 사고 과정 시각화와 설정 없는 안전한 원격 접속을 제공합니다. 단순한 채팅 래퍼가 아닙니다.*

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/screenshots/main-chat.jpg" alt="CodeMux - 멀티 엔진 AI 코딩 인터페이스" width="800" />

</div>

---

## 왜 CodeMux인가?

### 1. 멀티 모델이 아닌 멀티 엔진

API 키를 바꿔 끼우는 채팅 래퍼가 아닙니다. CodeMux는 **프로토콜 수준의 게이트웨이**입니다 — 각 엔진은 자체 런타임, 세션, 도구 실행, 기능을 완전히 보존한 채 동작합니다.

하나의 인터페이스에서 엔진을 전환할 수 있습니다. 각 엔진은 파일 편집, 셸 접근, 세션 기록, 프로젝트 컨텍스트 등 모든 기능을 그대로 유지하며, CodeMux는 이들을 위한 통합 프론트엔드 역할만 합니다.

| 엔진 | 프로토콜 | 상태 |
|--------|----------|--------|
| **[OpenCode](https://opencode.ai)** | HTTP REST + SSE | ✅ 안정 |
| **[GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-coding-agent-in-cli)** | JSON-RPC/stdio | ✅ 안정 |
| **[Claude Code](https://claude.ai/code)** | SDK (stdio) | ✅ 안정 |

> 💡 CodeMux는 **Copilot CLI를 위한 최초이자 현재 유일한 오픈소스 GUI**이기도 합니다. 프로토콜 수준(JSON-RPC over stdio)에서 직접 연결하여, Copilot의 완전한 에이전트 코딩 경험을 시각적 인터페이스로 제공합니다.

### 2. 에이전트 사고 과정 시각화

모든 에이전트 동작은 펼쳐볼 수 있는 단계로 렌더링됩니다 — 파일 diff, 셸 명령, 검색 결과, 도구 호출 — 최종 답변뿐 아니라 에이전트가 무엇을 왜 하고 있는지 정확히 확인할 수 있습니다.

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/screenshots/chat-steps.jpg" alt="CodeMux - 단계별 에이전트 시각화" width="700" />

이것은 데스크톱 앱에만 국한되지 않습니다. **완전한 사고 과정 경험은 모든 접속 방법에서 유지됩니다** — LAN이나 공용 인터넷을 통한 브라우저에서든, 휴대폰의 IM 봇을 통한 상호작용에서든.

### 3. 진정한 원격 Agent 경험

[OpenClaw](https://github.com/openclaw/openclaw) 같은 도구들은 메시징 앱에서 AI에 접근한다는 아이디어를 널리 퍼뜨렸습니다 — WhatsApp이나 Telegram에서 메시지를 보내고, 텍스트 답변을 받는 방식. 하지만 AI 지원 코딩에서는 텍스트 답변만으로는 부족합니다. 에이전트가 무엇을 **생각하고**, 어떤 파일을 **편집하고**, 어떤 명령을 **실행하는지** — 실시간으로 확인해야 합니다.

**CodeMux는 이 격차를 해소합니다.** 브라우저에서든 IM 플랫폼에서든, 구조화된 스트리밍을 통한 완전한 에이전트 경험을 제공합니다:

| 기능 | CodeMux | 텍스트 기반 어시스턴트 |
|------|---------|---------------------|
| 스트리밍 출력 | ✅ 토큰 수준 실시간 스트리밍 | ⚠️ 완전한 답변 또는 청크 분할 텍스트 |
| 사고 단계 | ✅ 각 도구 호출을 펼칠 수 있는 단계로 표시 | ❌ 최종 답변만 |
| 파일 차이 | ✅ 구문 강조 지원 인라인 diff 뷰어 | ❌ 일반 텍스트 또는 없음 |
| 셸 명령 | ✅ 명령 + 출력 실시간 렌더링 | ❌ 기껏해야 텍스트 요약 |
| 멀티 엔진 | ✅ OpenCode / Copilot / Claude Code 전환 | ❌ 단일 모델 / 제공자 |
| 코딩 컨텍스트 | ✅ 완전한 도구 접근을 갖춘 프로젝트 인식 세션 | ⚠️ 범용 어시스턴트 컨텍스트 |
| 이미지 입력 | ✅ 이미지 붙여넣기/드래그로 모든 엔진이 분석 | ❌ 텍스트 입력만 가능 |

### 4. 멀티모달 지원

텍스트 기반 코딩 도구는 텍스트 입력에 한정됩니다. CodeMux는 이 한계를 넘어섭니다 — **프롬프트에 이미지를 첨부하여 AI가 당신이 보는 것을 보게 하세요**.

스크린샷을 붙여넣고, 디자인 목업을 드래그하고, 에러 이미지를 업로드하세요 — 세 엔진 모두 이미지를 네이티브로 분석할 수 있습니다. 각 엔진 어댑터가 이미지를 네이티브 형식으로 변환하지만, 사용자에게는 통합된 경험을 제공합니다:

- **업로드 방법**: 파일 선택기, 드래그 앤 드롭, 클립보드 붙여넣기
- **지원 형식**: JPEG, PNG, GIF, WebP (메시지당 최대 4장, 각 3MB)
- **인라인 미리보기**: 전송 전 썸네일 표시, 채팅 기록에서 이미지 렌더링

> 이것은 모든 접속 방법에서 작동합니다 — 데스크톱, 원격 브라우저, IM 봇 — CodeMux가 실행되는 곳이라면 어디서든 이미지 입력이 가능합니다.

### 더 많은 기능

- **에이전트 모드 전환**: 엔진별로 Build / Plan / Autopilot 모드 전환 — 각각 고유한 동작과 프롬프트 스타일
- **실시간 작업 패널**: 에이전트가 생성한 작업 목록을 입력 영역 위에 표시, 실시간 진행 상황 추적
- **권한 승인**: 민감한 작업(셸, 파일 편집)을 인라인으로 승인 또는 거부 — 신뢰할 수 있는 패턴에 대한 "항상 허용" 옵션
- **대화형 질문**: 엔진이 단일/다중 선택 질문을 제시, 설명 텍스트와 사용자 정의 입력 지원
- **엔진별 모델 선택**: 각 엔진에 대해 독립적으로 다른 모델 선택 가능; Copilot과 Claude Code는 사용자 정의 모델 ID 입력 지원

#### 브라우저 원격 접속

휴대폰, 태블릿, 다른 컴퓨터 등 어떤 기기에서든 설정 파일 하나 건드리지 않고 코딩 에이전트에 접속할 수 있습니다.

- **LAN**: 자동 감지된 IP + QR 코드, 수초 내 준비 완료
- **공용 인터넷**: 원클릭 [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) — 포트 포워딩, VPN, 방화벽 변경 불필요. **퀵 터널**(랜덤 임시 URL, 제로 설정)과 **네임드 터널**(`~/.cloudflared/` 인증 정보를 통한 영구 커스텀 도메인) 모두 지원
- **내장 보안**: 기기 인증, JWT 토큰, Cloudflare를 통한 HTTPS; 퀵 터널 URL은 재시작마다 변경, 네임드 터널은 커스텀 호스트명 유지

#### IM 봇 채널

즐겨 사용하는 메시징 앱에서 직접 AI 코딩 에이전트를 사용하세요. **실시간 스트리밍과 구조화된 리치 콘텐츠**를 제공합니다 — 단순한 텍스트 답변이 아닙니다.

##### 지원 플랫폼

| 플랫폼 | 이벤트 수신 | 스트리밍 | 그룹 생성 | 리치 콘텐츠 |
|--------|-----------|---------|----------|------------|
| [Feishu (Lark)](https://open.feishu.cn/) | WebSocket (장기 연결) | ✅ 편집 업데이트 | ✅ 자동 그룹 생성 | 인터랙티브 카드 |
| [DingTalk](https://open.dingtalk.com/) | Stream 모드 (WS) | ✅ AI 카드 | ✅ 씬 그룹 | ActionCard / Markdown |
| [Telegram](https://core.telegram.org/bots/api) | Webhook / 롱 폴링 | ✅ sendMessageDraft | ❌ P2P만 | MarkdownV2 + 인라인 키보드 |
| [WeCom](https://developer.work.weixin.qq.com/) | HTTP 콜백 (AES XML) | ❌ 배치 모드 | ✅ 앱 그룹 채팅 | Markdown / 템플릿 카드 |
| [Microsoft Teams](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/) | Bot Framework HTTP | ✅ 편집 업데이트 | ❌ P2P만 | Adaptive Cards v1.5 |

##### 공통 기능

- **P2P 진입점**: 봇과의 개인 채팅에서 프로젝트와 세션 선택
- **슬래시 명령**: `/cancel`, `/status`, `/mode`, `/model`, `/history`, `/help`
- **스트리밍 응답**: 플랫폼에 맞는 업데이트 전략으로 AI 실시간 출력
- **도구 요약**: 완료 시 작업 수 표시 (예: `Shell(2), Edit(1)`)
- **권한 자동 승인**: 엔진 권한 요청을 자동으로 승인

##### 세션 모델

- **1그룹 = 1세션** (Feishu, DingTalk, WeCom): 각 그룹 채팅이 하나의 CodeMux 세션에 매핑. P2P에서 프로젝트 선택 → 그룹 자동 생성.
- **P2P 다이렉트** (Telegram, Teams): 개인 채팅에서 직접 대화 (임시 세션, 2시간 TTL). 그룹 채팅에서는 @멘션으로 대화.

##### 설정

각 플랫폼의 개발자 포털에서 봇/앱을 생성하고 CodeMux 설정 → 채널에서 인증 정보를 구성하세요:

| 플랫폼 | 필요한 인증 정보 | 개발자 포털 |
|--------|-----------------|------------|
| Feishu | App ID, App Secret | [open.feishu.cn](https://open.feishu.cn/) |
| DingTalk | App Key, App Secret, Robot Code | [open.dingtalk.com](https://open.dingtalk.com/) |
| Telegram | Bot Token (@BotFather에서 획득) | [core.telegram.org](https://core.telegram.org/bots) |
| WeCom | Corp ID, Corp Secret, Agent ID, Callback Token, Encoding AES Key | [developer.work.weixin.qq.com](https://developer.work.weixin.qq.com/) |
| Teams | Microsoft App ID, App Password | [Azure Portal](https://portal.azure.com/) + [Teams Dev Portal](https://dev.teams.microsoft.com/) |

---

## 빠른 시작

### 방법 1: 데스크톱 앱

**macOS (권장 — Homebrew 사용):**

```bash
brew tap realDuang/codemux
brew install --cask codemux
```

**수동 다운로드:**

- **macOS (Apple Silicon)**: `CodeMux-x.x.x-arm64.dmg`
- **macOS (Intel)**: `CodeMux-x.x.x-x64.dmg`
- **Windows**: `CodeMux-x.x.x-setup.exe`

데스크톱 앱에는 Cloudflare Tunnel 바이너리와 게이트웨이 서버가 포함되어 있습니다. **OpenCode, Copilot CLI, Claude Code는 별도로 설치해야 합니다** (아래 참조).

> ⚠️ **macOS 사용자 (수동 다운로드)**: 앱이 코드 서명되어 있지 않습니다. macOS에서 "앱이 손상되었습니다"라고 표시되면 다음 명령을 실행하세요:
>
> ```bash
> xattr -cr /Applications/CodeMux.app
> ```

### 방법 2: 개발 모드

```bash
# 저장소 클론
git clone https://github.com/realDuang/codemux.git
cd codemux

# 의존성 설치
bun install

# cloudflared 바이너리 다운로드 (원격 접속용)
bun run update:cloudflared

# 개발 서버 시작 (Electron + Vite HMR)
bun run dev
```

> **엔진 사전 요구 사항**: 모든 엔진은 별도로 설치하여 PATH에 등록해야 하는 외부 의존성입니다:
> - **OpenCode**: [opencode.ai](https://opencode.ai)에서 설치 — `curl -fsSL https://opencode.ai/install.sh | bash` (Unix) 또는 `irm https://opencode.ai/install.ps1 | iex` (Windows)
> - **Copilot CLI**: [GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-coding-agent-in-cli)를 별도로 설치
> - **Claude Code**: `npm install -g @anthropic-ai/claude-code`로 설치하고 `ANTHROPIC_API_KEY` 설정
>
> CodeMux는 시작 시 설치된 엔진을 자동으로 감지합니다.

---

## 원격 접속 및 채널

### 연결 방법

| 방법 | 설정 | 최적 용도 |
|------|------|----------|
| **LAN 브라우저** | `http://<내 IP>:8233`을 열고, 6자리 코드 입력 또는 QR 스캔 | 같은 네트워크의 다른 기기에서 빠른 접속 |
| **공용 인터넷** | "공개 접속" 토글 → `*.trycloudflare.com` URL 공유 | 어디서든 접속, 포트 포워딩 불필요 |
| **IM 봇** | 설정 → 채널에서 봇 인증 정보 구성 | Feishu, DingTalk, Telegram, WeCom, Teams에서 상호작용 |

### 보안 및 기기 관리

| 계층 | 보호 방식 |
|-------|------------|
| **기기 인증** | 새 기기는 6자리 코드를 통한 승인이 필요합니다 |
| **JWT 토큰** | 기기별 토큰이 안전하게 저장됩니다 |
| **HTTPS** | 공개 터널은 Cloudflare를 통해 자동으로 HTTPS를 사용합니다 |
| **임시 URL** | 터널 URL은 재시작할 때마다 변경됩니다 |

기기 페이지에서 연결된 기기를 관리할 수 있습니다 — 마지막 접속 시간 확인, 식별을 위한 이름 변경, 기기별 접근 권한 취소가 가능합니다.

> CodeMux는 개인 사용을 위해 설계되었습니다. 더 이상 사용하지 않는 기기는 접근 권한을 취소하고, 필요하지 않을 때는 공개 터널을 비활성화하세요.

---

## 아키텍처

```
┌─────────────────────────────────────────────────────────────────┐
│                        접근 계층                                 │
│                                                                 │
│  ┌──────────┐  ┌───────────────┐  ┌──────────────────────────┐  │
│  │ Electron │  │ 브라우저(LAN/ │  │ IM 봇 (Feishu/DingTalk   │  │
│  │   앱     │  │ Cloudflare)   │  │ /Telegram/WeCom/Teams)   │  │
│  └────┬─────┘  └──────┬────────┘  └────────────┬─────────────┘  │
│       │               │                        │                │
│       └───────────────┼────────────────────────┘                │
│                       │                                         │
│              WebSocket (JSON-RPC)                               │
│                       │                                         │
│              ┌────────┴────────┐                                │
│              │  Gateway Server │                                │
│              │ (Engine Manager)│                                │
│              └──┬──────┬─────┬┘                                 │
│                 │      │     │                                  │
│           ┌─────┘   ┌──┘    └──┐                                │
│           │         │          │                                │
│     ┌─────┴─────┐ ┌─┴──────┐ ┌┴───────┐                        │
│     │ OpenCode  │ │Copilot │ │ Claude │                        │
│     │ Adapter   │ │Adapter │ │Adapter │                        │
│     │(HTTP+SSE) │ │(stdio) │ │ (SDK)  │                        │
│     └───────────┘ └────────┘ └────────┘                        │
│                                                                 │
│     통합 타입 시스템: UnifiedPart, ToolPart, AgentMode            │
└─────────────────────────────────────────────────────────────────┘
```

모든 접속 방법 — 데스크톱 앱, 원격 브라우저, IM 봇 — 은 동일한 WebSocket 게이트웨이를 통해 연결됩니다. 엔진은 **정규화된 타입 시스템**을 공유하므로, 어떤 엔진이나 접속 방법을 사용하든 도구 호출, 파일 diff, 스트리밍 메시지가 동일하게 렌더링됩니다.

---

## 개발

### 명령어

```bash
bun run dev              # Electron + Vite HMR
bun run build            # 프로덕션 빌드
bun run dist:mac:arm64   # macOS Apple Silicon
bun run dist:mac:x64     # macOS Intel
bun run dist:win         # Windows NSIS 설치 프로그램
bun run typecheck        # 타입 검사
bun run update:cloudflared  # Cloudflare Tunnel 바이너리 업데이트
```

### 프로젝트 구조

```
codemux/
├── electron/
│   ├── main/
│   │   ├── engines/          # 엔진 어댑터 (OpenCode, Copilot, Claude Code)
│   │   ├── gateway/          # WebSocket 서버 + 엔진 라우팅
│   │   ├── channels/         # IM 봇 채널 (Feishu, DingTalk, Telegram, WeCom, Teams)
│   │   │   └── streaming/    # 크로스 채널 스트리밍 인프라
│   │   ├── services/         # 인증, 기기 저장소, 터널, 세션, 파일 서비스, 트레이 등
│   │   └── utils/            # 공유 유틸리티 (ID 생성 등)
│   └── preload/
├── src/                      # SolidJS 렌더러
│   ├── pages/                # Chat, Settings, Devices, Entry
│   ├── components/           # UI 컴포넌트 + 콘텐츠 렌더러
│   ├── stores/               # 반응형 상태 (session, message, config)
│   ├── lib/                  # Gateway 클라이언트, 인증, i18n, 테마
│   ├── locales/              # i18n 번역 파일 (en, zh, ru)
│   └── types/                # 통합 타입 시스템 + 도구 매핑
├── shared/                   # 공유 백엔드 모듈 (인증, JWT, 기기 저장소 베이스)
├── tests/                    # 단위 테스트, E2E 테스트 (Playwright), 벤치마크
├── docs/                     # 채널 설정 가이드 + 설계 문서
├── website/                  # 프로젝트 웹사이트 (SolidJS + Vite)
├── scripts/                  # 설정, 바이너리 업데이터, CI 헬퍼
├── homebrew/                 # macOS Homebrew 배포 포뮬러
├── electron.vite.config.ts
└── electron-builder.yml
```

---

## 기여하기

기여를 환영합니다! 자세한 가이드라인은 [CONTRIBUTING.md](CONTRIBUTING.md)를 참고하세요.

**코드 스타일**: TypeScript strict 모드, SolidJS 반응형 패턴, Tailwind을 사용한 스타일링

**커밋 컨벤션**: `feat:` | `fix:` | `docs:` | `refactor:` | `chore:`

**새 엔진 추가**: `EngineAdapter`를 구현하고 (`electron/main/engines/engine-adapter.ts` 참조), `src/types/tool-mapping.ts`에 도구 이름 매핑을 추가한 후, `electron/main/index.ts`에 등록하세요.

---

## 라이선스

[MIT](LICENSE)

---

## 링크

- [토론](https://github.com/realDuang/codemux/discussions) — 로드맵, 기능 요청 및 커뮤니티 대화
- [로드맵](https://github.com/realDuang/codemux/discussions/61) — 개발 로드맵 및 마일스톤 추적
- [이슈](https://github.com/realDuang/codemux/issues) — 버그 리포트
- [OpenCode](https://opencode.ai) — 지원 엔진
- [GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-coding-agent-in-cli) — 지원 엔진
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — 지원 엔진
- [Feishu 개방 플랫폼](https://open.feishu.cn/) — Feishu 봇 채널
- [DingTalk 개방 플랫폼](https://open.dingtalk.com/) — DingTalk 봇 채널
- [Telegram Bot API](https://core.telegram.org/bots/api) — Telegram 봇 채널
- [WeCom 개발자 센터](https://developer.work.weixin.qq.com/) — WeCom 봇 채널
- [Microsoft Teams 플랫폼](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/) — Teams 봇 채널

---

<div align="center">

**[Electron](https://electronjs.org), [SolidJS](https://solidjs.com), 그리고 AI 지원 코딩에 대한 열정으로 만들었습니다.**

</div>
