<div align="center">

# CodeMux

[English](./README.md) | [简体中文](./README.zh-CN.md) | **[日本語](./README.ja.md)** | [한국어](./README.ko.md) | [Русский](./README.ru.md)

**フルリモートAgent体験を備えたマルチエンジンAIコーディングクライアント。**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/logo.png" alt="CodeMux" width="120" />

*マルチエンジンAIコーディングクライアント — エージェントの思考連鎖を完全に可視化し、設定不要のセキュアなリモートアクセスを実現。単なるチャットラッパーではありません。*

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/screenshots/main-chat.jpg" alt="CodeMux - マルチエンジンAIコーディングインターフェース" width="800" />

</div>

---

## なぜ CodeMux なのか？

### 1. マルチモデルではなく、マルチエンジン

これはAPIキーを切り替えるだけのチャットラッパーではありません。CodeMux は**プロトコルレベルのゲートウェイ**です — 各エンジンは独自のランタイム、セッション、ツール実行、機能をそのまま保持して動作します。

単一のインターフェースからエンジンを切り替えられます。各エンジンはファイル編集、シェルアクセス、セッション履歴、プロジェクトコンテキストなど、すべての機能を維持します — CodeMux はそれらに共通の入口を提供するだけです。

| エンジン | プロトコル | ステータス |
|--------|----------|--------|
| **[OpenCode](https://opencode.ai)** | HTTP REST + SSE | ✅ 安定版 |
| **[GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-coding-agent-in-cli)** | JSON-RPC/stdio | ✅ 安定版 |
| **[Claude Code](https://claude.ai/code)** | SDK (stdio) | ✅ 安定版 |
| **Codex** | JSON-RPC/stdio（app-server） | ⚠️ 実験的 |

> 💡 CodeMux は **Copilot CLI 初の、そして現時点で唯一のオープンソースGUI** でもあります。プロトコルレベル（JSON-RPC over stdio）で接続し、Copilot の完全なエージェントコーディング体験をビジュアルインターフェースで提供します。
>
> ⚠️ Codex サポートは現在 experimental/unstable です。上流の app-server プロトコルの変更に伴い、プロトコル詳細や挙動が変わる可能性があります。

### 2. エージェントの思考連鎖を可視化

すべてのエージェントアクションが展開可能なステップとしてレンダリングされます — ファイルの差分、シェルコマンド、検索結果、ツール呼び出しなど — エージェントが何をしているのか、なぜそうしているのかを、最終的な回答だけでなく正確に把握できます。

<img src="https://raw.githubusercontent.com/realDuang/codemux/main/assets/screenshots/chat-steps.jpg" alt="CodeMux - ステップバイステップのエージェント可視化" width="700" />

これはデスクトップアプリに限った話ではありません。**完全な思考連鎖体験はすべてのアクセス方法で保持されます** — LANやパブリックインターネット経由のブラウザでも、スマートフォンのIMボットでのやり取りでも。

### 3. 真のリモートAgent体験

[OpenClaw](https://github.com/openclaw/openclaw) のようなツールは、メッセージングアプリからAIにアクセスするというアイデアを普及させました — WhatsAppやTelegramでメッセージを送信し、テキストの返信を受け取る。しかしAIアシストコーディングにおいて、テキスト返信では不十分です。エージェントが何を**考え**、どのファイルを**編集し**、どのコマンドを**実行している**のかを — リアルタイムで見る必要があります。

**CodeMux はこのギャップを埋めます。** ブラウザからでもIMプラットフォームからでも、構造化されたストリーミングによる完全なエージェント体験を得られます：

| 機能 | CodeMux | テキストベースのアシスタント |
|------|---------|--------------------------|
| ストリーミング出力 | ✅ トークンレベルのリアルタイムストリーミング | ⚠️ 完全な返信またはチャンク分割テキスト |
| 思考ステップ | ✅ 各ツール呼び出しを展開可能なステップとして表示 | ❌ 最終回答のみ |
| ファイル差分 | ✅ シンタックスハイライト付きインラインdiffビューア | ❌ プレーンテキストまたは表示なし |
| シェルコマンド | ✅ コマンド + 出力をリアルタイムレンダリング | ❌ せいぜいテキスト要約 |
| マルチエンジン | ✅ OpenCode / Copilot / Claude Code / Codex を切り替え | ❌ 単一モデル / プロバイダー |
| コーディングコンテキスト | ✅ 完全なツールアクセスを備えたプロジェクト対応セッション | ⚠️ 汎用アシスタントコンテキスト |
| 画像入力 | ✅ 画像の貼り付け/ドラッグで全エンジンが分析 | ❌ テキスト入力のみ |

### 4. マルチモーダルサポート

テキストベースのコーディングツールはテキスト入力に限定されています。CodeMux はこの壁を打ち破ります — **プロンプトに画像を添付して、AIにあなたが見ているものを見せましょう**。

スクリーンショットを貼り付け、デザインモックアップをドラッグ、エラー画像をアップロード — 4つのエンジンすべてが画像をネイティブに分析できます。各エンジンアダプターが裏で画像をネイティブフォーマットに変換し、統一された体験を提供します：

- **アップロード方法**：ファイルピッカー、ドラッグ＆ドロップ、クリップボード貼り付け
- **対応フォーマット**：JPEG、PNG、GIF、WebP（メッセージあたり最大4枚、各3MBまで）
- **インラインプレビュー**：送信前にサムネイルを表示、チャット履歴で画像をレンダリング

> これはすべてのアクセス方法で機能します — デスクトップ、リモートブラウザ、IMボット — CodeMux が動作する場所であれば、画像入力も使えます。

### 5. 開発ワークフローツール

CodeMux はチャットにとどまりません — 開発ワークフローを直接インターフェースから管理する統合ツールを提供します。

- **スケジュールタスク**：定期的なエージェントタスクを自動化 — 毎朝のコードレビュー、インターバルでのレポート生成、週次のイシュー一括処理。手動トリガー、インターバル（5分〜12時間）、日次、週次スケジューリングに対応し、アプリ再起動時に実行漏れを自動補完します。

- **Git Worktree 並列セッション**：`git stash` なしで複数ブランチの同時作業が可能。サイドバーから隔離されたワークツリーを作成し、それぞれが独自のディレクトリ、ブランチ、AIセッションを持ちます。merge、squash、rebase から選択してマージバック — すべてUI内で完結します。

- **ファイルエクスプローラーとGit変更監視**：折りたたみ可能なツリーでプロジェクトファイルを閲覧し、シンタックスハイライト付きでコードをプレビュー、Git変更をリアルタイムに追跡。「変更」タブで変更ファイルを行レベルの追加/削除数と共に表示し、インラインdiffビューアーでCodeMuxを離れずにすべての変更を確認できます。

- **スラッシュコマンドとエンジンスキル**：入力欄で `/` を入力すると、オートコンプリートでエンジンネイティブのコマンドとスキルを呼び出せます — `/cancel`、`/status`、`/mode`、`/model` など。各エンジンは独自のコマンドを公開; Copilot はプロジェクトレベルおよび個人スキルを、Claude Code はユーザーインストール済みスキルを、OpenCode は SDK コマンドをパススルーし、Codex は app-server スキルを公開します — すべて統一されたオートコンプリート UI で操作できます。

### その他の機能

- **エージェントモード切替**：Build / Plan / Autopilot モードをエンジンごとに切り替え — それぞれ異なる動作とプロンプトスタイル
- **リアルタイムタスクパネル**：エージェントが生成したタスクリストを入力エリア上部に表示、進捗をリアルタイム追跡
- **パーミッション承認**：シェルやファイル編集などの機密操作をインラインで承認/拒否 — 信頼済みパターンには「常に許可」オプション
- **インタラクティブ質問**：エンジンが単一/複数選択の質問を提示可能、説明文とカスタム入力をサポート
- **エンジンごとのモデル選択**：エンジンごとに異なるモデルを選択可能; Claude Code と Codex はカスタムモデル ID の手動入力をサポート
- **トークン使用量追跡**：入力、出力、キャッシュトークンの消費量をエンジンごとのコスト内訳と共に監視

#### ブラウザリモートアクセス

スマートフォン、タブレット、別のマシンなど、あらゆるデバイスからコーディングエージェントにアクセスできます — 設定ファイルを一切触る必要はありません。

- **LAN**: IPアドレスの自動検出 + QRコードで、数秒で準備完了
- **パブリックインターネット**: ワンクリックで [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) — ポート転送、VPN、ファイアウォール変更は一切不要。**クイックトンネル**（ランダムな一時URL、設定不要）と**ネームドトンネル**（`~/.cloudflared/` 認証情報による永続カスタムドメイン）の両方をサポート
- **セキュリティ内蔵**: デバイス認証、JWT トークン、Cloudflare 経由のHTTPS; クイックトンネルURLは再起動ごとにローテーション、ネームドトンネルはカスタムホスト名を維持

#### IM ボットチャネル

お気に入りのメッセージングアプリから直接AIコーディングエージェントを使用できます。**リアルタイムストリーミングと構造化されたリッチコンテンツ**を提供 — 単なるプレーンテキスト返信ではありません。

##### 対応プラットフォーム

| プラットフォーム | イベント受信 | ストリーミング | グループ作成 | リッチコンテンツ |
|-----------------|-------------|--------------|-------------|----------------|
| [Feishu (Lark)](https://open.feishu.cn/) | WebSocket（長期接続） | ✅ 編集更新 | ✅ 自動グループ作成 | インタラクティブカード |
| [DingTalk](https://open.dingtalk.com/) | Stream モード（WS） | ✅ AI カード | ✅ シーングループ | ActionCard / Markdown |
| [Telegram](https://core.telegram.org/bots/api) | Webhook / ロングポーリング | ✅ sendMessageDraft | ❌ P2Pのみ | MarkdownV2 + インラインキーボード |
| [WeCom](https://developer.work.weixin.qq.com/) | HTTP コールバック（AES XML） | ❌ バッチモード | ✅ アプリグループチャット | Markdown / テンプレートカード |
| [Microsoft Teams](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/) | Bot Framework HTTP | ✅ 編集更新 | ❌ P2Pのみ | Adaptive Cards v1.5 |

##### 共通機能

- **P2Pエントリポイント**：ボットとのプライベートチャットでプロジェクトとセッションを選択
- **スラッシュコマンド**：`/cancel`、`/status`、`/mode`、`/model`、`/history`、`/help`
- **ストリーミング応答**：プラットフォームに応じた更新戦略でAIリアルタイム出力
- **ツールサマリー**：完了時にアクション数を表示（例：`Shell(2), Edit(1)`）
- **パーミッション自動承認**：エンジンのパーミッションリクエストを自動承認

##### セッションモデル

- **1グループ＝1セッション**（Feishu、DingTalk、WeCom）：各グループチャットが1つのCodeMuxセッションに対応。P2Pでプロジェクト選択 → グループ自動作成。
- **P2Pダイレクト**（Telegram、Teams）：プライベートチャットで直接対話（一時セッション、2時間TTL）。グループチャットでは@メンションで対話。

##### セットアップ

各プラットフォームの開発者ポータルでボット/アプリを作成し、CodeMux 設定 → チャネルで認証情報を設定してください：

| プラットフォーム | 必要な認証情報 | 開発者ポータル |
|-----------------|--------------|--------------|
| Feishu | App ID、App Secret | [open.feishu.cn](https://open.feishu.cn/) |
| DingTalk | App Key、App Secret、Robot Code | [open.dingtalk.com](https://open.dingtalk.com/) |
| Telegram | Bot Token（@BotFatherから取得） | [core.telegram.org](https://core.telegram.org/bots) |
| WeCom | Corp ID、Corp Secret、Agent ID、Callback Token、Encoding AES Key | [developer.work.weixin.qq.com](https://developer.work.weixin.qq.com/) |
| Teams | Microsoft App ID、App Password | [Azure Portal](https://portal.azure.com/) + [Teams Dev Portal](https://dev.teams.microsoft.com/) |

---

## クイックスタート

### オプション 1: デスクトップアプリ

**macOS（推奨 — Homebrew 経由）：**

```bash
brew tap realDuang/codemux
brew install --cask codemux
```

**手動ダウンロード：**

- **macOS (Apple Silicon)**: `CodeMux-x.x.x-arm64.dmg`
- **macOS (Intel)**: `CodeMux-x.x.x-x64.dmg`
- **Windows**: `CodeMux-x.x.x-setup.exe`

デスクトップアプリには Cloudflare Tunnel バイナリとゲートウェイサーバーがバンドルされています。**OpenCode、Copilot CLI、Claude Code、Codex は別途インストールが必要です**（以下を参照）。

> ⚠️ **macOS ユーザーへ（手動ダウンロード）**: このアプリはコード署名されていません。macOS で「アプリが壊れています」と表示される場合は、以下を実行してください：
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

> **エンジンの前提条件**: すべてのエンジンは外部依存関係であり、インストールしてPATHで利用可能にする必要があります：
> - **OpenCode**: [opencode.ai](https://opencode.ai) からインストール — `curl -fsSL https://opencode.ai/install.sh | bash`（Unix）または `irm https://opencode.ai/install.ps1 | iex`（Windows）
> - **Copilot CLI**: [GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-coding-agent-in-cli) を別途インストール
> - **Claude Code**: `npm install -g @anthropic-ai/claude-code` でインストールし、`ANTHROPIC_API_KEY` を設定
> - **Codex**: `codex` CLI を別途インストールし、`codex` が PATH にあることを確認してください。CodeMux は Codex の既存の OpenAI ログインまたは API キー設定を再利用します。現在は experimental/unstable です。
>
> CodeMux は起動時にインストール済みのエンジンを自動検出します。

---

## リモートアクセスとチャネル

### 接続方法

| 方法 | 設定 | 最適な用途 |
|------|------|-----------|
| **LANブラウザ** | `http://<あなたのIP>:8233` を開き、6桁コードを入力またはQRスキャン | 同じネットワーク上の別デバイスからの高速アクセス |
| **パブリックインターネット** | 「パブリックアクセス」を切替 → `*.trycloudflare.com` URLを共有 | どこからでもアクセス、ポート転送不要 |
| **IMボット** | 設定 → チャネルでボット認証情報を設定 | Feishu、DingTalk、Telegram、WeCom、Teamsから操作 |

### セキュリティとデバイス管理

| レイヤー | 保護内容 |
|---------|----------|
| **デバイス認証** | 新しいデバイスには6桁コードによる承認が必要 |
| **JWT トークン** | デバイスごとのトークンを安全に保存 |
| **HTTPS** | パブリックトンネルは Cloudflare 経由で自動的にHTTPSを使用 |
| **エフェメラルURL** | トンネルURLは再起動ごとに変更 |

デバイスページから接続中のデバイスを管理できます — 最終アクセス時刻の確認、識別用の名前変更、デバイスごとのアクセス取り消しが可能です。

> CodeMux は個人利用向けに設計されています。使用しなくなったデバイスは取り消し、不要な場合はパブリックトンネルを無効にしてください。

---

## アーキテクチャ

```
┌─────────────────────────────────────────────────────────────────┐
│                       アクセスレイヤー                            │
│                                                                 │
│  ┌──────────┐  ┌───────────────┐  ┌──────────────────────────┐  │
│  │ Electron │  │ ブラウザ(LAN/ │  │ IMボット (Feishu/DingTalk│  │
│  │  アプリ  │  │ Cloudflare)   │  │ /Telegram/WeCom/Teams)   │  │
│  └────┬─────┘  └──────┬────────┘  └────────────┬─────────────┘  │
│       │               │                        │                │
│       └───────────────┼────────────────────────┘                │
│                       │                                         │
│              WebSocket (JSON-RPC)                               │
│                       │                                         │
│              ┌────────┴────────┐                                │
│              │  Gateway Server │                                │
│              │ (Engine Manager)│                                │
│              └──┬──────┬──────┬─────┬┘                            │
│                 │      │      │     │                             │
│           ┌─────┘   ┌──┘   ┌──┘   └──┐                            │
│           │         │      │         │                            │
│     ┌─────┴─────┐ ┌─┴──────┐ ┌┴───────┐ ┌─────────┐               │
│     │ OpenCode  │ │Copilot │ │ Claude │ │  Codex  │               │
│     │ Adapter   │ │Adapter │ │Adapter │ │ Adapter │               │
│     │(HTTP+SSE) │ │(stdio) │ │ (SDK)  │ │ (stdio) │               │
│     └───────────┘ └────────┘ └────────┘ └─────────┘               │
│                                                                 │
│     統一型システム: UnifiedPart, ToolPart, AgentMode              │
└─────────────────────────────────────────────────────────────────┘
```

すべてのアクセス方法 — デスクトップアプリ、リモートブラウザ、IMボット — は同じWebSocketゲートウェイを通じて接続します。エンジンは**正規化された型システム**を共有しているため、どのエンジンやアクセス方法を使用しても、ツール呼び出し、ファイル差分、ストリーミングメッセージは同じように表示されます。

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
│   │   ├── engines/          # エンジンアダプター (OpenCode, Copilot, Claude Code, Codex)
│   │   ├── gateway/          # WebSocket サーバー + エンジンルーティング
│   │   ├── channels/         # IM ボットチャネル（Feishu、DingTalk、Telegram、WeCom、Teams）
│   │   │   └── streaming/    # クロスチャネルストリーミング基盤
│   │   ├── services/         # 認証、デバイスストア、トンネル、セッション、ファイルサービス、トレイなど
│   │   └── utils/            # 共有ユーティリティ（ID生成など）
│   └── preload/
├── src/                      # SolidJS レンダラー
│   ├── pages/                # Chat, Settings, Devices, Entry
│   ├── components/           # UIコンポーネント + コンテンツレンダラー
│   ├── stores/               # リアクティブステート (session, message, config)
│   ├── lib/                  # Gateway クライアント、認証、i18n、テーマ
│   ├── locales/              # i18n翻訳ファイル (en, zh, ru)
│   └── types/                # 統一型システム + ツールマッピング
├── shared/                   # 共有バックエンドモジュール（認証、JWT、デバイスストアベース）
├── tests/                    # ユニットテスト、E2Eテスト（Playwright）、ベンチマーク
├── docs/                     # チャネル設定ガイド + 設計ドキュメント
├── website/                  # プロジェクトウェブサイト（SolidJS + Vite）
├── scripts/                  # セットアップ、バイナリアップデーター、CIヘルパー
├── homebrew/                 # macOS Homebrew 配布用フォーミュラ
├── electron.vite.config.ts
└── electron-builder.yml
```

---

## コントリビューション

コントリビューションを歓迎します！詳細なガイドラインは [CONTRIBUTING.md](CONTRIBUTING.md) をご覧ください。

**コードスタイル**: TypeScript strict モード、SolidJS リアクティブパターン、Tailwind によるスタイリング

**コミット規約**: `feat:` | `fix:` | `docs:` | `refactor:` | `chore:`

**新しいエンジンの追加**: `EngineAdapter` を実装し（`electron/main/engines/engine-adapter.ts` を参照）、`src/types/tool-mapping.ts` にツール名マッピングを追加し、`electron/main/index.ts` に登録してください。

---

## ライセンス

[MIT](LICENSE)

---

## リンク

- [ディスカッション](https://github.com/realDuang/codemux/discussions) — ロードマップ、機能リクエスト、コミュニティ会話
- [ロードマップ](https://github.com/realDuang/codemux/discussions/61) — 開発ロードマップとマイルストーン追跡
- [Issue](https://github.com/realDuang/codemux/issues) — バグ報告
- [OpenCode](https://opencode.ai) — 対応エンジン
- [GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-coding-agent-in-cli) — 対応エンジン
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — 対応エンジン
- [Feishu 開放プラットフォーム](https://open.feishu.cn/) — Feishu ボットチャネル
- [DingTalk 開放プラットフォーム](https://open.dingtalk.com/) — DingTalk ボットチャネル
- [Telegram Bot API](https://core.telegram.org/bots/api) — Telegram ボットチャネル
- [WeCom 開発者センター](https://developer.work.weixin.qq.com/) — WeCom ボットチャネル
- [Microsoft Teams プラットフォーム](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/) — Teams ボットチャネル

---

<div align="center">

**[Electron](https://electronjs.org)、[SolidJS](https://solidjs.com)、そしてAIアシストコーディングへの情熱で構築されています。**

</div>
