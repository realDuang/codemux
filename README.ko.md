<div align="center">

# CodeMux

[English](./README.md) | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md) | **[한국어](./README.ko.md)**

**최초의 오픈소스 GitHub Copilot CLI GUI.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/logo.png" alt="CodeMux" width="120" />

*멀티 엔진 AI 코딩 클라이언트 — 에이전트의 완전한 사고 과정 시각화와 설정 없는 안전한 원격 접속을 제공합니다. 단순한 채팅 래퍼가 아닙니다.*

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/screenshots/main-chat.jpg" alt="CodeMux - 멀티 엔진 AI 코딩 인터페이스" width="800" />

</div>

---

## 왜 CodeMux인가?

### 1. GitHub Copilot CLI 최초의 GUI

GitHub Copilot은 세계에서 가장 널리 사용되는 AI 코딩 도구입니다. **Copilot CLI**는 [ACP protocol](https://github.com/anthropics/agent-control-protocol)을 통해 터미널에서 완전한 에이전트 기능을 제공하지만, 이를 위한 그래픽 인터페이스는 존재하지 않았습니다.

**CodeMux는 Copilot CLI를 위한 최초이자 현재 유일한 오픈소스 GUI입니다.** 프로토콜 수준(JSON-RPC over stdio)에서 직접 연결하여, Copilot의 완전한 에이전트 코딩 경험을 시각적 인터페이스로 제공합니다.

### 2. 멀티 모델이 아닌 멀티 엔진

API 키를 바꿔 끼우는 채팅 래퍼가 아닙니다. CodeMux는 **프로토콜 수준의 게이트웨이**입니다 — 각 엔진은 자체 런타임, 세션, 도구 실행, 기능을 완전히 보존한 채 동작합니다.

하나의 인터페이스에서 엔진을 전환할 수 있습니다. 각 엔진은 파일 편집, 셸 접근, 세션 기록, 프로젝트 컨텍스트 등 모든 기능을 그대로 유지하며, CodeMux는 이들을 위한 통합 프론트엔드 역할만 합니다.

| 엔진 | 프로토콜 | 상태 |
|--------|----------|--------|
| **[OpenCode](https://opencode.ai)** | HTTP REST + SSE | ✅ 안정 |
| **[GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-coding-agent-in-cli)** | ACP (JSON-RPC/stdio) | ✅ 안정 |
| **[Claude Code](https://claude.ai/code)** | ACP | 🚧 예정 |

### 3. 에이전트 사고 과정 시각화

모든 에이전트 동작은 펼쳐볼 수 있는 단계로 렌더링됩니다 — 파일 diff, 셸 명령, 검색 결과, 도구 호출 — 최종 답변뿐 아니라 에이전트가 무엇을 왜 하고 있는지 정확히 확인할 수 있습니다.

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/screenshots/chat-steps.jpg" alt="CodeMux - 단계별 에이전트 시각화" width="700" />

### 4. 설정 없는 안전한 원격 접속

휴대폰, 태블릿, 다른 컴퓨터 등 어떤 기기에서든 설정 파일 하나 건드리지 않고 코딩 에이전트에 접속할 수 있습니다.

- **LAN**: 자동 감지된 IP + QR 코드, 수초 내 준비 완료
- **공용 인터넷**: 원클릭 [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) — 포트 포워딩, VPN, 방화벽 변경 불필요
- **내장 보안**: 기기 인증, JWT 토큰, Cloudflare를 통한 HTTPS, 재시작마다 변경되는 임시 터널 URL

---

## 빠른 시작

### 방법 1: 데스크톱 앱

사용 중인 플랫폼에 맞는 최신 릴리스를 다운로드하세요:

- **macOS (Apple Silicon)**: `CodeMux-x.x.x-arm64.dmg`
- **macOS (Intel)**: `CodeMux-x.x.x-x64.dmg`
- **Windows**: `CodeMux-x.x.x-setup.exe`

데스크톱 앱에는 Cloudflare Tunnel 바이너리와 게이트웨이 서버가 포함되어 있습니다. **OpenCode과 Copilot CLI는 별도로 설치해야 합니다** (아래 참조).

> ⚠️ **macOS 사용자**: 앱이 코드 서명되어 있지 않습니다. macOS에서 "앱이 손상되었습니다"라고 표시되면 다음 명령을 실행하세요:
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

> **엔진 사전 요구 사항**: 두 엔진 모두 별도로 설치하여 PATH에 등록해야 하는 외부 의존성입니다:
> - **OpenCode**: [opencode.ai](https://opencode.ai)에서 설치 — `curl -fsSL https://opencode.ai/install.sh | bash` (Unix) 또는 `irm https://opencode.ai/install.ps1 | iex` (Windows)
> - **Copilot CLI**: [GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-coding-agent-in-cli)를 별도로 설치
>
> CodeMux는 시작 시 설치된 엔진을 자동으로 감지합니다.

---

## 원격 접속

### LAN 접속

1. CodeMux를 열고 설정에서 **원격 접속**으로 이동합니다
2. 페이지에서 사용 중인 머신의 IP 주소를 확인합니다
3. 다른 기기에서 `http://<your-ip>:5173`을 엽니다
4. 6자리 접속 코드를 입력하거나 QR 코드를 스캔합니다

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/screenshots/remote-access.jpg" alt="CodeMux - 원격 접속" width="700" />

### 공용 인터넷 접속

Cloudflare Tunnel을 통해 어디서든 접속할 수 있습니다 — **포트 포워딩, 방화벽 변경, VPN이 필요 없습니다:**

1. 원격 접속 섹션에서 **"공개 접속"**을 토글합니다
2. 생성된 `*.trycloudflare.com` URL을 공유합니다
3. 원격 기기에서 접속 코드로 인증합니다

```
사용자의 휴대폰/태블릿
       ↓
https://xyz.trycloudflare.com
       ↓
  Cloudflare 네트워크
       ↓
  사용자의 워크스테이션 (CodeMux Gateway)
       ↓
  ┌─────────┬──────────┬───────────┐
  │OpenCode │ Copilot  │  Claude   │
  │ Engine  │  Engine  │  Engine   │
  └─────────┴──────────┴───────────┘
```

### 보안 및 기기 관리

| 계층 | 보호 방식 |
|-------|------------|
| **기기 인증** | 새 기기는 6자리 코드를 통한 승인이 필요합니다 |
| **JWT 토큰** | 기기별 토큰이 안전하게 저장됩니다 |
| **HTTPS** | 공개 터널은 Cloudflare를 통해 자동으로 HTTPS를 사용합니다 |
| **임시 URL** | 터널 URL은 재시작할 때마다 변경됩니다 |

기기 페이지에서 연결된 기기를 관리할 수 있습니다 — 마지막 접속 시간 확인, 식별을 위한 이름 변경, 기기별 접근 권한 취소가 가능합니다.

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/screenshots/devices-management.jpg" alt="CodeMux - 기기 관리" width="700" />

> CodeMux는 개인 사용을 위해 설계되었습니다. 더 이상 사용하지 않는 기기는 접근 권한을 취소하고, 필요하지 않을 때는 공개 터널을 비활성화하세요.

---

## 아키텍처

```
┌─────────────────────────────────────────────────────────────────┐
│  SolidJS UI (Electron을 통한 데스크톱 / 브라우저를 통한 웹)       │
│                          │                                      │
│              WebSocket (JSON-RPC)                               │
│                          │                                      │
│              ┌───────────┴───────────┐                          │
│              │    Gateway Server     │                          │
│              │    (Engine Manager)   │                          │
│              └───┬───────┬───────┬───┘                          │
│                  │       │       │                              │
│            ┌─────┘    ┌──┘      ┌┘                              │
│            │          │         │                               │
│      ┌─────┴─────┐ ┌──┴────┐ ┌──┴─────┐                         │
│      │ OpenCode  │ │Copilot│ │ Claude │                         │
│      │ Adapter   │ │Adapter│ │Adapter │                         │
│      │(HTTP+SSE) │ │ (ACP) │ │ (ACP)  │                         │
│      └───────────┘ └───────┘ └────────┘                         │
│                                                                 │
│     통합 타입 시스템: UnifiedPart, ToolPart, AgentMode            │
└─────────────────────────────────────────────────────────────────┘
```

모든 엔진은 **정규화된 타입 시스템**을 공유합니다 — 도구 호출, 파일 작업, diff, 메시지가 공통 포맷(`UnifiedPart`)으로 매핑되므로, UI는 어떤 엔진이 실행 중인지 알 필요가 없습니다.

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
│   │   ├── engines/          # 엔진 어댑터 (OpenCode, Copilot, ACP base)
│   │   ├── gateway/          # WebSocket 서버 + 엔진 라우팅
│   │   └── services/         # 인증, 기기 저장소, 터널, 세션
│   └── preload/
├── src/                      # SolidJS 렌더러
│   ├── pages/                # Chat, Settings, Devices, Entry
│   ├── components/           # UI 컴포넌트 + 콘텐츠 렌더러
│   ├── stores/               # 반응형 상태 (session, message, config)
│   ├── lib/                  # Gateway 클라이언트, 인증, i18n, 테마
│   └── types/                # 통합 타입 시스템 + 도구 매핑
├── scripts/                  # 설정, 바이너리 업데이터
├── electron.vite.config.ts
└── electron-builder.yml
```

---

## 기여하기

기여를 환영합니다! 다음 컨벤션을 따라주세요:

**코드 스타일**: TypeScript strict 모드, SolidJS 반응형 패턴, Tailwind을 사용한 스타일링

**커밋 컨벤션**: `feat:` | `fix:` | `docs:` | `refactor:` | `chore:`

**새 엔진 추가**: `EngineAdapter`를 구현하고 (`electron/main/engines/engine-adapter.ts` 참조), `src/types/tool-mapping.ts`에 도구 이름 매핑을 추가한 후, `electron/main/index.ts`에 등록하세요.

---

## 라이선스

[MIT](LICENSE)

---

## 링크

- [이슈 및 기능 요청](https://github.com/realDuang/codemux/issues)
- [OpenCode](https://opencode.ai) — 지원 엔진
- [GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-coding-agent-in-cli) — 지원 엔진

---

<div align="center">

**[Electron](https://electronjs.org), [SolidJS](https://solidjs.com), 그리고 AI 지원 코딩에 대한 열정으로 만들었습니다.**

</div>
