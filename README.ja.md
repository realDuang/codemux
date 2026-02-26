<div align="center">

# CodeMux

[English](./README.md) | [简体中文](./README.zh-CN.md) | **[日本語](./README.ja.md)** | [한국어](./README.ko.md)

**ひとつのインターフェース。すべての AI コーディングエンジン。**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/logo.png" alt="CodeMux" width="120" />

*複数の AI コーディングエンジン — OpenCode、GitHub Copilot CLI など — を統合するデスクトップ & Web クライアント。あらゆるデバイスから、どこからでもアクセスできます。*

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/screenshots/main-chat.jpg" alt="CodeMux - マルチエンジン AI コーディングインターフェース" width="800" />

</div>

---

## CodeMux とは？

AI コーディングエージェントは強力ですが、バラバラに存在しています。OpenCode、GitHub Copilot CLI、Claude Code はそれぞれ独自のターミナルで動作し、セッションは分離され、プロトコルも異なり、共通のインターフェースがありません。

**CodeMux** は、これらすべてをひとつにまとめるマルチエンジンゲートウェイです。各エンジンにプロトコルレベルで接続し、統一されたデスクトップアプリと Web インターフェースを通じて、エンジン横断のセッション管理を実現します — あらゆるデバイスから、インターネット経由でもアクセス可能です。

これはマルチモデルチャットのラッパーではありません。各エンジンはツール実行、ファイル編集、シェルアクセス、セッション履歴といった本来の機能をすべて保持します — CodeMux はそれらへの共通の入り口を提供するだけです。

---

## 主な機能

| カテゴリ | 機能 | 説明 |
|----------|------|------|
| **マルチエンジン** | 統合ゲートウェイ | ひとつのインターフェースから OpenCode、Copilot CLI などを切り替え |
| | プロトコルレベル統合 | ACP (JSON-RPC/stdio) および HTTP+SSE への直接接続 — プロセスラッパーではありません |
| | エンジンごとのセッション | 各エンジンが独自のセッション、履歴、機能を維持 |
| **リモートアクセス** | あらゆるデバイスからアクセス | スマートフォン、タブレット、ブラウザからコーディングエンジンにアクセス |
| | ワンクリック公開トンネル | Cloudflare Tunnel — ポートフォワーディング、VPN、ファイアウォール変更は不要 |
| | LAN + QR コード | QR コードによるローカルネットワーク上の即時アクセス |
| **インターフェース** | リアルタイムストリーミング | ツール呼び出しの可視化を伴うライブトークンストリーミング |
| | ステップバイステップ実行 | ファイル差分やシェル出力などを表示する展開可能なツール呼び出し |
| | プロジェクト管理 | エンジン横断でプロジェクトディレクトリごとにセッションをグループ化 |
| **セキュリティ** | デバイス認可 | 各デバイスはアクセス前に承認が必要 |
| | JWT + アクセスコード | リモートデバイス向け 6 桁アクセスコード付きトークン認証 |
| | 一時的なトンネル URL | トンネル再起動のたびに公開 URL が変更 |

---

## 対応エンジン

| エンジン | プロトコル | ステータス | 特徴 |
|----------|-----------|----------|------|
| **[OpenCode](https://opencode.ai)** | HTTP REST + SSE | ✅ 安定版 | マルチプロバイダーモデル選択、完全なセッション管理、ファイル/シェルツール |
| **[GitHub Copilot CLI](https://githubnext.com/projects/copilot-cli)** | ACP (JSON-RPC/stdio) | ✅ 安定版 | ネイティブ ACP 統合、SQLite セッション履歴、Copilot の完全なエージェント機能 |
| **[Claude Code](https://claude.ai/code)** | ACP | 🚧 予定 | 公式 ACP プロトコル対応待ち |

### 初のオープンソース Copilot CLI GUI

GitHub Copilot は世界で最も広く利用されている AI コーディングツールです。**Copilot CLI** により、GitHub は [ACP プロトコル](https://github.com/anthropics/agent-control-protocol) を通じてエージェント型コーディング機能をターミナルに導入しました。

**CodeMux は、Copilot CLI にグラフィカルインターフェースを提供する、初めてのそして現時点で唯一のオープンソースプロジェクトです。** プロトコルレベルの ACP 統合を完全な GUI で実現するツールは他に存在しません。Copilot を使っていてエージェント型コーディングのビジュアルインターフェースが欲しい方にとって、CodeMux は唯一のオープンソースの選択肢です。

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/screenshots/chat-steps.jpg" alt="CodeMux - ステップバイステップのツール実行" width="700" />

---

## アーキテクチャ

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

すべてのエンジンが**正規化された型システム**を共有します — ツール呼び出し、ファイル操作、差分、メッセージはすべて共通フォーマット（`UnifiedPart`）にマッピングされるため、UI はどのエンジンが動作しているかを意識する必要がありません。

---

## クイックスタート

### オプション 1：デスクトップアプリ

プラットフォームに合わせて最新リリースをダウンロード：

- **macOS (Apple Silicon)**：`CodeMux-x.x.x-arm64.dmg`
- **macOS (Intel)**：`CodeMux-x.x.x-x64.dmg`
- **Windows**：`CodeMux-x.x.x-setup.exe`

デスクトップアプリには Cloudflare Tunnel バイナリとゲートウェイサーバーが同梱されています。**OpenCode と Copilot CLI は別途インストールが必要です**（下記参照）。

> ⚠️ **macOS ユーザーへ**：アプリはコード署名されていません。macOS で「アプリが破損しています」と表示された場合、以下を実行してください：
>
> ```bash
> xattr -cr /Applications/CodeMux.app
> ```

### オプション 2：開発モード

```bash
# リポジトリをクローン
git clone https://github.com/realDuang/codemux.git
cd codemux

# 依存関係をインストール
bun install

# リモートアクセス用バイナリをダウンロード
bun run update:cloudflared

# 開発サーバーを起動（Electron + Vite HMR）
bun run dev
```

> **エンジンの前提条件**：CodeMux はエンジン本体を同梱していません。使用するエンジンを事前にインストールし、PATH に配置してください。
>
> - **OpenCode**：[opencode.ai](https://opencode.ai) からインストール
>   - Unix / macOS：`curl -fsSL https://opencode.ai/install.sh | bash`
>   - Windows：`irm https://opencode.ai/install.ps1 | iex`
> - **Copilot CLI**：[GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-coding-agent-in-cli) をインストールし、`gh auth login` で認証してください。
>
> CodeMux は起動時にインストール済みのエンジンを自動検出します。

---

## リモートアクセス

### LAN アクセス

1. CodeMux を開き、設定の**リモートアクセス**に移動
2. ページに表示されるマシンの IP アドレスを確認
3. 別のデバイスから `http://<あなたのIP>:5173` を開く
4. 6 桁のアクセスコードを入力、または QR コードをスキャン

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/screenshots/remote-access.jpg" alt="CodeMux - リモートアクセス" width="700" />

### パブリックインターネットアクセス

Cloudflare Tunnel でどこからでもアクセス：

1. リモートアクセスセクションで**「パブリックアクセス」**をオンに切り替え
2. 生成された `*.trycloudflare.com` URL を共有
3. リモートデバイスでアクセスコードを入力して認証

**ポートフォワーディング不要。ファイアウォール変更不要。VPN 不要。**

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

### デバイス管理

- 接続中のすべてのデバイスを最終アクセス時刻付きで**表示**
- デバイスを識別しやすいように**名前変更**
- デバイスごとにアクセスを**取り消し**、または一括取り消し

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/screenshots/devices-management.jpg" alt="CodeMux - デバイス管理" width="700" />

---

## セキュリティ

| レイヤー | 保護 |
|----------|------|
| **デバイス認可** | 新しいデバイスは 6 桁コードによる承認が必要 |
| **JWT トークン** | デバイスごとに安全に保存されたトークン |
| **HTTPS** | パブリックトンネルは Cloudflare 経由で自動的に HTTPS を使用 |
| **一時的な URL** | トンネル再起動のたびに URL が変更 |

**ベストプラクティス：**
- 使用しなくなったデバイスのアクセスを取り消す
- 不要時はパブリックトンネルを無効化
- CodeMux は個人利用向けに設計されています — マルチユーザー環境向けではありません

---

## 技術スタック

| レイヤー | 技術 |
|----------|------|
| デスクトップシェル | Electron 33 |
| ビルドシステム | electron-vite (Vite 5) |
| フロントエンド | SolidJS 1.8 + TypeScript 5 |
| スタイリング | Tailwind CSS v4 |
| エンジン通信 | WebSocket + JSON-RPC, HTTP+SSE, ACP (stdio) |
| パッケージング | electron-builder (DMG, NSIS) |
| トンネル | Cloudflare Tunnel (cloudflared) |

---

## 開発

### コマンド

```bash
bun run dev              # Electron + Vite HMR
bun run build            # 本番ビルド
bun run dist:mac:arm64   # macOS Apple Silicon
bun run dist:mac:x64     # macOS Intel
bun run dist:win         # Windows NSIS インストーラー
bun run typecheck        # 型チェック
bun run update:cloudflared  # Cloudflare Tunnel バイナリの更新
```

### プロジェクト構造

```
codemux/
├── electron/
│   ├── main/
│   │   ├── engines/          # エンジンアダプター (OpenCode, Copilot, ACP base)
│   │   ├── gateway/          # WebSocket サーバー + エンジンルーティング
│   │   └── services/         # 認証、デバイスストア、トンネル、セッション
│   └── preload/
├── src/                      # SolidJS レンダラー
│   ├── pages/                # Chat, Settings, Devices, Entry
│   ├── components/           # UI コンポーネント + コンテンツレンダラー
│   ├── stores/               # リアクティブ状態 (session, message, config)
│   ├── lib/                  # ゲートウェイクライアント、認証、i18n、テーマ
│   └── types/                # 統一型システム + ツールマッピング
├── scripts/                  # セットアップ、バイナリ更新ツール
├── electron.vite.config.ts
└── electron-builder.yml
```

---

## コントリビューション

コントリビューション歓迎です！以下の規約に従ってください：

**コードスタイル**：TypeScript 厳格モード、SolidJS リアクティブパターン、スタイリングには Tailwind を使用

**コミット規約**：`feat:` | `fix:` | `docs:` | `refactor:` | `chore:`

**新しいエンジンの追加**：`EngineAdapter`（`electron/main/engines/engine-adapter.ts` を参照）を実装し、`src/types/tool-mapping.ts` にツール名マッピングを追加、`electron/main/index.ts` で登録してください。

---

## ライセンス

[MIT](LICENSE)

---

## リンク

- [イシュー & 機能リクエスト](https://github.com/realDuang/codemux/issues)
- [OpenCode](https://opencode.ai) — 対応エンジン
- [GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-coding-agent-in-cli) — 対応エンジン

---

<div align="center">

**[Electron](https://electronjs.org)、[SolidJS](https://solidjs.com)、そして AI アシストコーディングへの情熱で構築されました。**

</div>
