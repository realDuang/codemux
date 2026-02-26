<div align="center">

# CodeMux

[English](./README.md) | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md) | **[한국어](./README.ko.md)**

**하나의 인터페이스. 모든 AI 코딩 엔진.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/logo.png" alt="CodeMux" width="120" />

*다양한 AI 코딩 엔진을 위한 통합 데스크톱 & 웹 클라이언트 — OpenCode, GitHub Copilot CLI 등을 하나의 인터페이스에서. 어떤 기기에서든, 어디서든 접속하세요.*

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/screenshots/main-chat.jpg" alt="CodeMux - 멀티 엔진 AI 코딩 인터페이스" width="800" />

</div>

---

## CodeMux란?

AI 코딩 에이전트는 강력하지만 분산되어 있습니다. OpenCode, GitHub Copilot CLI, Claude Code는 각각 별도의 터미널에서 실행되며, 세션이 분리되고, 프로토콜이 다르며, 통합된 인터페이스가 없습니다.

**CodeMux**는 이 모든 것을 하나로 통합하는 멀티 엔진 게이트웨이입니다. 각 엔진에 프로토콜 수준에서 연결하고, 통합된 데스크톱 앱과 웹 인터페이스를 통해 엔진 간 세션을 관리합니다 — 어떤 기기에서든, 인터넷을 통해서도 접속할 수 있습니다.

이것은 또 다른 멀티 모델 채팅 래퍼가 아닙니다. 각 엔진은 도구 실행, 파일 편집, 셸 접근, 세션 기록 등 모든 기능을 그대로 유지합니다 — CodeMux는 그것들에 대한 공통 입구를 제공할 뿐입니다.

---

## 주요 기능

| 카테고리 | 기능 | 설명 |
|----------|------|------|
| **멀티 엔진** | 통합 게이트웨이 | 하나의 인터페이스에서 OpenCode, Copilot CLI 등을 전환 |
| | 프로토콜 수준 통합 | ACP (JSON-RPC/stdio) 및 HTTP+SSE 직접 연결 — 프로세스 래퍼가 아닙니다 |
| | 엔진별 세션 | 각 엔진이 자체 세션, 기록, 기능을 유지 |
| **원격 접속** | 모든 기기에서 접속 | 스마트폰, 태블릿 또는 브라우저에서 코딩 엔진에 접속 |
| | 원클릭 공개 터널 | Cloudflare Tunnel — 포트 포워딩, VPN, 방화벽 변경 불필요 |
| | LAN + QR 코드 | QR 코드로 로컬 네트워크에서 즉시 접속 |
| **인터페이스** | 실시간 스트리밍 | 도구 호출 시각화를 포함한 라이브 토큰 스트리밍 |
| | 단계별 실행 | 파일 diff, 셸 출력 등을 표시하는 확장 가능한 도구 호출 |
| | 프로젝트 관리 | 엔진 간 프로젝트 디렉토리별 세션 그룹화 |
| **보안** | 기기 인증 | 각 기기는 접속 전 승인이 필요 |
| | JWT + 접속 코드 | 원격 기기용 6자리 접속 코드를 포함한 토큰 기반 인증 |
| | 임시 터널 URL | 터널 재시작 시마다 공개 URL이 변경 |

---

## 지원 엔진

| 엔진 | 프로토콜 | 상태 | 주요 특징 |
|------|----------|------|----------|
| **[OpenCode](https://opencode.ai)** | HTTP REST + SSE | ✅ 안정 | 멀티 프로바이더 모델 선택, 완전한 세션 관리, 파일/셸 도구 |
| **[GitHub Copilot CLI](https://githubnext.com/projects/copilot-cli)** | ACP (JSON-RPC/stdio) | ✅ 안정 | 네이티브 ACP 통합, SQLite 세션 기록, Copilot의 완전한 에이전트 기능 |
| **[Claude Code](https://claude.ai/code)** | ACP | 🚧 예정 | 공식 ACP 프로토콜 지원 대기 중 |

### 최초의 오픈소스 Copilot CLI GUI

GitHub Copilot은 세계에서 가장 널리 사용되는 AI 코딩 도구입니다. **Copilot CLI**를 통해 GitHub은 [ACP 프로토콜](https://github.com/anthropics/agent-control-protocol)을 사용하여 에이전트 코딩 기능을 터미널에 도입했습니다.

**CodeMux는 Copilot CLI에 그래픽 인터페이스를 제공하는 최초이자 현재 유일한 오픈소스 프로젝트입니다.** 프로토콜 수준의 ACP 통합과 완전한 GUI를 제공하는 도구는 다른 곳에 없습니다. Copilot을 사용하면서 에이전트 코딩을 위한 시각적 인터페이스를 원한다면, CodeMux가 유일한 오픈소스 선택지입니다.

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/screenshots/chat-steps.jpg" alt="CodeMux - 단계별 도구 실행" width="700" />

---

## 아키텍처

```
┌─────────────────────────────────────────────────────────────────┐
│  SolidJS UI (Desktop via Electron / Web via Browser)            │
│                          │                                      │
│              WebSocket (JSON-RPC)                               │
│                          │                                      │
│              ┌───────────┴───────────┐                          │
│              │    Gateway Server     │                          │
│              │    (Engine Manager)   │                          │
│              └───┬───────┬───────┬───┘                          │
│                  │       │       │                               │
│           ┌──────┘   ┌───┘   ┌───┘                              │
│           │          │       │                                   │
│     ┌─────┴─────┐ ┌──┴───┐ ┌─┴──────┐                          │
│     │ OpenCode  │ │Copilot│ │ Claude │                          │
│     │ Adapter   │ │Adapter│ │Adapter │                          │
│     │(HTTP+SSE) │ │ (ACP) │ │ (ACP)  │                          │
│     └───────────┘ └──────┘ └────────┘                           │
│                                                                  │
│     Unified Type System: UnifiedPart, ToolPart, AgentMode        │
└─────────────────────────────────────────────────────────────────┘
```

모든 엔진은 **정규화된 타입 시스템**을 공유합니다 — 도구 호출, 파일 작업, diff, 메시지가 모두 공통 포맷(`UnifiedPart`)으로 매핑되므로, UI는 어떤 엔진이 실행 중인지 알 필요가 없습니다.

---

## 빠른 시작

### 옵션 1: 데스크톱 앱

플랫폼에 맞는 최신 릴리스를 다운로드하세요:

- **macOS (Apple Silicon)**: `CodeMux-x.x.x-arm64.dmg`
- **macOS (Intel)**: `CodeMux-x.x.x-x64.dmg`
- **Windows**: `CodeMux-x.x.x-setup.exe`

데스크톱 앱에는 Cloudflare Tunnel 바이너리와 게이트웨이 서버가 포함되어 있습니다. **OpenCode와 Copilot CLI는 별도로 설치해야 합니다** (아래 참조).

> ⚠️ **macOS 사용자**: 앱은 코드 서명이 되어 있지 않습니다. macOS에서 "앱이 손상되었습니다"라고 표시되면 다음을 실행하세요:
>
> ```bash
> xattr -cr /Applications/CodeMux.app
> ```

### 옵션 2: 개발 모드

```bash
# 저장소 클론
git clone https://github.com/realDuang/codemux.git
cd codemux

# 의존성 설치
bun install

# Cloudflare Tunnel 바이너리 다운로드 (원격 접속용)
bun run update:cloudflared

# 개발 서버 시작 (Electron + Vite HMR)
bun run dev
```

> **엔진 사전 요구 사항**: OpenCode와 Copilot CLI는 외부 의존성이며 시스템 PATH에 설치되어 있어야 합니다. CodeMux는 시작 시 설치된 엔진을 자동으로 감지합니다.
>
> - **OpenCode 설치**:
>   - Unix/macOS: `curl -fsSL https://opencode.ai/install.sh | bash`
>   - Windows: `irm https://opencode.ai/install.ps1 | iex`
> - **Copilot CLI 설치**: [GitHub Copilot CLI 문서](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-coding-agent-in-cli)를 참조하세요.

---

## 원격 접속

### LAN 접속

1. CodeMux를 열고 설정에서 **원격 접속**으로 이동
2. 페이지에서 컴퓨터의 IP 주소를 확인
3. 다른 기기에서 `http://<IP주소>:5173`을 열기
4. 6자리 접속 코드를 입력하거나 QR 코드를 스캔

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/screenshots/remote-access.jpg" alt="CodeMux - 원격 접속" width="700" />

### 공용 인터넷 접속

Cloudflare Tunnel로 어디서든 접속:

1. 원격 접속 섹션에서 **"공용 접속"**을 활성화
2. 생성된 `*.trycloudflare.com` URL을 공유
3. 원격 기기에서 접속 코드로 인증

**포트 포워딩 불필요. 방화벽 변경 불필요. VPN 불필요.**

```
Your Phone/Tablet
       ↓
https://xyz.trycloudflare.com
       ↓
  Cloudflare Network
       ↓
  Your Workstation (CodeMux Gateway)
       ↓
  ┌─────────┬──────────┬───────────┐
  │OpenCode │ Copilot  │  Claude   │
  │ Engine  │  Engine  │  Engine   │
  └─────────┴──────────┴───────────┘
```

### 기기 관리

- 연결된 모든 기기를 마지막 접속 시간과 함께 **확인**
- 쉬운 식별을 위해 기기 **이름 변경**
- 기기별로 접속 **취소** 또는 전체 일괄 취소

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/screenshots/devices-management.jpg" alt="CodeMux - 기기 관리" width="700" />

---

## 보안

| 레이어 | 보호 |
|--------|------|
| **기기 인증** | 새 기기는 6자리 코드로 승인 필요 |
| **JWT 토큰** | 기기별로 안전하게 저장된 토큰 |
| **HTTPS** | 공개 터널은 Cloudflare를 통해 자동으로 HTTPS 사용 |
| **임시 URL** | 터널 재시작 시마다 URL 변경 |

**모범 사례:**
- 더 이상 사용하지 않는 기기의 접속 권한을 취소하세요
- 필요하지 않을 때는 공개 터널을 비활성화하세요
- CodeMux는 개인 사용을 위해 설계되었습니다 — 다중 사용자 시나리오용이 아닙니다

---

## 기술 스택

| 레이어 | 기술 |
|--------|------|
| 데스크톱 셸 | Electron 33 |
| 빌드 시스템 | electron-vite (Vite 5) |
| 프론트엔드 | SolidJS 1.8 + TypeScript 5 |
| 스타일링 | Tailwind CSS v4 |
| 엔진 통신 | WebSocket + JSON-RPC, HTTP+SSE, ACP (stdio) |
| 패키징 | electron-builder (DMG, NSIS) |
| 터널 | Cloudflare Tunnel (cloudflared) |

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
│   ├── lib/                  # 게이트웨이 클라이언트, 인증, i18n, 테마
│   └── types/                # 통합 타입 시스템 + 도구 매핑
├── scripts/                  # 설정, 바이너리 업데이트 도구
├── electron.vite.config.ts
└── electron-builder.yml
```

---

## 기여

기여를 환영합니다! 다음 규칙을 따라주세요:

**코드 스타일**: TypeScript strict 모드, SolidJS 반응형 패턴, Tailwind로 스타일링

**커밋 규칙**: `feat:` | `fix:` | `docs:` | `refactor:` | `chore:`

**새 엔진 추가**: `EngineAdapter`(`electron/main/engines/engine-adapter.ts` 참조)를 구현하고, `src/types/tool-mapping.ts`에 도구 이름 매핑을 추가하고, `electron/main/index.ts`에 등록하세요.

---

## 라이선스

[MIT](LICENSE)

---

## 링크

- [이슈 & 기능 요청](https://github.com/realDuang/codemux/issues)
- [OpenCode](https://opencode.ai) — 지원 엔진
- [GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-coding-agent-in-cli) — 지원 엔진

---

<div align="center">

**[Electron](https://electronjs.org), [SolidJS](https://solidjs.com), 그리고 AI 보조 코딩에 대한 열정으로 제작되었습니다.**

</div>
