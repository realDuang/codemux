<div align="center">

# CodeMux

[English](./README.md) | [简体中文](./README.zh-CN.md) | **[日本語](./README.ja.md)** | [한국어](./README.ko.md)

**GitHub Copilot CLI 初のオープンソースGUI。**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/logo.png" alt="CodeMux" width="120" />

*マルチエンジンAIコーディングクライアント — エージェントの思考連鎖を完全に可視化し、設定不要のセキュアなリモートアクセスを実現。単なるチャットラッパーではありません。*

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/screenshots/main-chat.jpg" alt="CodeMux - マルチエンジンAIコーディングインターフェース" width="800" />

</div>

---

## なぜ CodeMux なのか？

### 1. GitHub Copilot CLI 初のGUI

GitHub Copilot は世界で最も広く採用されているAIコーディングツールです。**Copilot CLI** は [ACP プロトコル](https://github.com/anthropics/agent-control-protocol)を通じてターミナルで完全なエージェント機能を提供しますが、そのためのグラフィカルインターフェースは存在しませんでした。

**CodeMux は Copilot CLI 初の、そして現時点で唯一のオープンソースGUIです。** プロトコルレベル（JSON-RPC over stdio）で接続し、Copilot の完全なエージェントコーディング体験をビジュアルインターフェースで提供します。

### 2. マルチモデルではなく、マルチエンジン

これはAPIキーを切り替えるだけのチャットラッパーではありません。CodeMux は**プロトコルレベルのゲートウェイ**です — 各エンジンは独自のランタイム、セッション、ツール実行、機能をそのまま保持して動作します。

単一のインターフェースからエンジンを切り替えられます。各エンジンはファイル編集、シェルアクセス、セッション履歴、プロジェクトコンテキストなど、すべての機能を維持します — CodeMux はそれらに共通の入口を提供するだけです。

| エンジン | プロトコル | ステータス |
|--------|----------|--------|
| **[OpenCode](https://opencode.ai)** | HTTP REST + SSE | ✅ 安定版 |
| **[GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-coding-agent-in-cli)** | ACP (JSON-RPC/stdio) | ✅ 安定版 |
| **[Claude Code](https://claude.ai/code)** | ACP | 🚧 計画中 |

### 3. エージェントの思考連鎖を可視化

すべてのエージェントアクションが展開可能なステップとしてレンダリングされます — ファイルの差分、シェルコマンド、検索結果、ツール呼び出しなど — エージェントが何をしているのか、なぜそうしているのかを、最終的な回答だけでなく正確に把握できます。

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/screenshots/chat-steps.jpg" alt="CodeMux - ステップバイステップのエージェント可視化" width="700" />

### 4. 設定不要のセキュアなリモートアクセス

スマートフォン、タブレット、別のマシンなど、あらゆるデバイスからコーディングエージェントにアクセスできます — 設定ファイルを一切触る必要はありません。

- **LAN**: IPアドレスの自動検出 + QRコードで、数秒で準備完了
- **パブリックインターネット**: ワンクリックで [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) — ポート転送、VPN、ファイアウォール変更は一切不要
- **セキュリティ内蔵**: デバイス認証、JWT トークン、Cloudflare 経由のHTTPS、再起動ごとにローテーションされるエフェメラルトンネルURL

---

## クイックスタート

### オプション 1: デスクトップアプリ

お使いのプラットフォーム向けの最新リリースをダウンロードしてください：

- **macOS (Apple Silicon)**: `CodeMux-x.x.x-arm64.dmg`
- **macOS (Intel)**: `CodeMux-x.x.x-x64.dmg`
- **Windows**: `CodeMux-x.x.x-setup.exe`

デスクトップアプリには Cloudflare Tunnel バイナリとゲートウェイサーバーがバンドルされています。**OpenCode と Copilot CLI は別途インストールが必要です**（以下を参照）。

> ⚠️ **macOS ユーザーへ**: このアプリはコード署名されていません。macOS で「アプリが壊れています」と表示される場合は、以下を実行してください：
>
> ```bash
> xattr -cr /Applications/CodeMux.app
> ```

### オプション 2: 開発モード

```bash
# リポジトリをクローン
git clone https://github.com/realDuang/codemux.git
cd codemux

# 依存関係をインストール
bun install

# cloudflared バイナリをダウンロード（リモートアクセス用）
bun run update:cloudflared

# 開発サーバーを起動（Electron + Vite HMR）
bun run dev
```

> **エンジンの前提条件**: 両方のエンジンは外部依存関係であり、インストールしてPATHで利用可能にする必要があります：
> - **OpenCode**: [opencode.ai](https://opencode.ai) からインストール — `curl -fsSL https://opencode.ai/install.sh | bash`（Unix）または `irm https://opencode.ai/install.ps1 | iex`（Windows）
> - **Copilot CLI**: [GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-coding-agent-in-cli) を別途インストール
>
> CodeMux は起動時にインストール済みのエンジンを自動検出します。

---

## リモートアクセス

### LAN アクセス

1. CodeMux を開き、設定の**リモートアクセス**に移動します
2. ページ上でマシンのIPアドレスを確認します
3. 別のデバイスから `http://<your-ip>:5173` を開きます
4. 6桁のアクセスコードを入力するか、QRコードをスキャンします

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/screenshots/remote-access.jpg" alt="CodeMux - リモートアクセス" width="700" />

### パブリックインターネットアクセス

Cloudflare Tunnel でどこからでもアクセス — **ポート転送、ファイアウォール変更、VPNは一切不要：**

1. リモートアクセスセクションで**「パブリックアクセス」**を切り替えます
2. 生成された `*.trycloudflare.com` のURLを共有します
3. リモートデバイスがアクセスコードで認証します

```
あなたのスマートフォン/タブレット
       ↓
https://xyz.trycloudflare.com
       ↓
  Cloudflare ネットワーク
       ↓
  あなたのワークステーション (CodeMux Gateway)
       ↓
  ┌─────────┬──────────┬───────────┐
  │OpenCode │ Copilot  │  Claude   │
  │ Engine  │  Engine  │  Engine   │
  └─────────┴──────────┴───────────┘
```

### セキュリティとデバイス管理

| レイヤー | 保護内容 |
|---------|----------|
| **デバイス認証** | 新しいデバイスには6桁コードによる承認が必要 |
| **JWT トークン** | デバイスごとのトークンを安全に保存 |
| **HTTPS** | パブリックトンネルは Cloudflare 経由で自動的にHTTPSを使用 |
| **エフェメラルURL** | トンネルURLは再起動ごとに変更 |

デバイスページから接続中のデバイスを管理できます — 最終アクセス時刻の確認、識別用の名前変更、デバイスごとのアクセス取り消しが可能です。

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/screenshots/devices-management.jpg" alt="CodeMux - デバイス管理" width="700" />

> CodeMux は個人利用向けに設計されています。使用しなくなったデバイスは取り消し、不要な場合はパブリックトンネルを無効にしてください。

---

## アーキテクチャ

```
┌─────────────────────────────────────────────────────────────────┐
│  SolidJS UI (Electron によるデスクトップ / ブラウザによるWeb)      │
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
│     統一型システム: UnifiedPart, ToolPart, AgentMode              │
└─────────────────────────────────────────────────────────────────┘
```

すべてのエンジンは**正規化された型システム**を共有しています — ツール呼び出し、ファイル操作、差分、メッセージは共通フォーマット（`UnifiedPart`）にマッピングされるため、UIはどのエンジンが動作しているかを意識する必要がありません。

---

## 開発

### コマンド

```bash
bun run dev              # Electron + Vite HMR
bun run build            # プロダクションビルド
bun run dist:mac:arm64   # macOS Apple Silicon
bun run dist:mac:x64     # macOS Intel
bun run dist:win         # Windows NSIS インストーラー
bun run typecheck        # 型チェック
bun run update:cloudflared  # Cloudflare Tunnel バイナリの更新
```

### プロジェクト構成

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
│   ├── components/           # UIコンポーネント + コンテンツレンダラー
│   ├── stores/               # リアクティブステート (session, message, config)
│   ├── lib/                  # Gateway クライアント、認証、i18n、テーマ
│   └── types/                # 統一型システム + ツールマッピング
├── scripts/                  # セットアップ、バイナリアップデーター
├── electron.vite.config.ts
└── electron-builder.yml
```

---

## コントリビューション

コントリビューションを歓迎します！以下の規約に従ってください：

**コードスタイル**: TypeScript strict モード、SolidJS リアクティブパターン、Tailwind によるスタイリング

**コミット規約**: `feat:` | `fix:` | `docs:` | `refactor:` | `chore:`

**新しいエンジンの追加**: `EngineAdapter` を実装し（`electron/main/engines/engine-adapter.ts` を参照）、`src/types/tool-mapping.ts` にツール名マッピングを追加し、`electron/main/index.ts` に登録してください。

---

## ライセンス

[MIT](LICENSE)

---

## リンク

- [Issue & 機能リクエスト](https://github.com/realDuang/codemux/issues)
- [OpenCode](https://opencode.ai) — 対応エンジン
- [GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-coding-agent-in-cli) — 対応エンジン

---

<div align="center">

**[Electron](https://electronjs.org)、[SolidJS](https://solidjs.com)、そしてAIアシストコーディングへの情熱で構築されています。**

</div>
