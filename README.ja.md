<div align="center">

# OpenCode Remote

[English](./README.md) | [简体中文](./README.zh-CN.md) | **[日本語](./README.ja.md)** | [한국어](./README.ko.md)

**どこからでも、どんなデバイスからでも OpenCode にアクセス**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![OpenCode](https://img.shields.io/badge/OpenCode-1.1.15+-green.svg)](https://opencode.ai)

<img src="https://raw.githubusercontent.com/realDuang/opencode-remote/main/assets/logo.png" alt="OpenCode Remote" width="120" />

*高性能ワークステーションで AI コーディングエージェントを実行し、タブレット、スマートフォン、または任意のブラウザからアクセス — インターネット経由でも。*

<img src="https://raw.githubusercontent.com/realDuang/opencode-remote/main/assets/screenshots/main-chat.jpg" alt="メインチャット画面" width="800" />

</div>

---

## なぜ OpenCode Remote？

OpenCode のような AI コーディングエージェントは、以下の条件を満たすマシンで実行する必要があります：
- コードベースと開発環境へのアクセス
- 適切な API キーと設定
- 十分な計算能力

でも、**ソファでスマホを使いたい**、**iPad でペアプログラミングしたい**、**世界中どこからでも開発マシンにアクセスしたい**場合はどうしますか？

**OpenCode Remote** は、ブラウザを持つ任意のデバイスから動作する Web インターフェースを提供することで、この問題を解決します。

### 主な機能

| 機能 | 説明 |
|------|------|
| **任意端末からのリモートアクセス** | スマホ、タブレット、ノートPC など、ブラウザを持つ任意のデバイスからクリーンな Web UI で OpenCode にアクセス |
| **ワンクリック公開トンネル** | Cloudflare Tunnel でワンクリックでインターネットアクセスを有効化 — ポートフォワーディングや VPN 不要 |
| **LAN アクセス** | ローカルネットワーク上の任意のデバイスから即座にアクセス可能 |
| **QR コード接続** | モバイルデバイスからスキャンで接続 — URL 入力不要 |
| **デフォルトで安全** | セッションごとにランダムな 6 桁のアクセスコードを使用 |
| **リアルタイムストリーミング** | Server-Sent Events による ライブメッセージストリーミング |
| **フル機能対応** | すべての OpenCode 機能が Web UI でシームレスに動作 |

<div align="center">
<img src="https://raw.githubusercontent.com/realDuang/opencode-remote/main/assets/screenshots/chat-steps.jpg" alt="チャットステップ" width="700" />

*ステップ実行とダークモードをサポートする AI アシスタント*
</div>

---

## クイックスタート

### オプション 1：デスクトップアプリ（推奨）

プラットフォームに合わせて最新リリースをダウンロード：

- **macOS (Apple Silicon)**: `OpenCode Remote-x.x.x-arm64.dmg`
- **macOS (Intel)**: `OpenCode Remote-x.x.x-x64.dmg`
- **Windows**: `OpenCode Remote-x.x.x-setup.exe`

デスクトップアプリには必要なものがすべて含まれています — 追加のインストールは不要です。

> ⚠️ **macOS ユーザーへ**：アプリはコード署名されていません。macOS で「アプリが破損しています」というエラーが表示される場合があります。以下のコマンドを実行して修正してください：
>
> ```bash
> xattr -cr /Applications/OpenCode\ Remote.app
> ```

### オプション 2：開発モード

```bash
# リポジトリをクローン
git clone https://github.com/realDuang/opencode-remote.git
cd opencode-remote

# 依存関係をインストール
bun install

# バンドルされたバイナリをダウンロード
bun run update:opencode
bun run update:cloudflared

# 開発モードで起動
bun run dev
```

---

## リモートアクセスガイド

### 方法1：LAN アクセス（同一ネットワーク）

ローカルネットワーク上の任意のデバイスからアクセス：

1. マシンの IP アドレスを確認（リモートアクセスページに表示）
2. 他のデバイスから `http://<あなたのIP>:5174` を開く
3. 6 桁のアクセスコードを入力

**またはリモートアクセスページに表示される QR コードをスキャン。**

<div align="center">
<img src="https://raw.githubusercontent.com/realDuang/opencode-remote/main/assets/screenshots/remote-access.jpg" alt="リモートアクセス" width="700" />
</div>

### 方法2：パブリックインターネットアクセス

Cloudflare Tunnel で世界中どこからでもアクセス：

1. `cloudflared` をインストール（`bun run setup` でガイド付きインストール）
2. Web UI で **設定** → **リモートアクセス** に移動
3. **「パブリックアクセス」** をオン
4. 生成された `*.trycloudflare.com` URL を共有

**ポートフォワーディング不要、ファイアウォール変更不要、VPN 不要。**

```
┌──────────────────────────────────────────────────────────┐
│                  あなたのスマホ/タブレット                 │
│                          ↓                                │
│              https://xyz.trycloudflare.com                │
│                          ↓                                │
│                 Cloudflare ネットワーク                    │
│                          ↓                                │
│             あなたのワークステーション (OpenCode)           │
└──────────────────────────────────────────────────────────┘
```

---

## ユースケース

### どこでも作業
高性能デスクトップで OpenCode を実行し、カフェのノートパソコンから操作。

### モバイルコーディングアシスタント
紙やホワイトボードでコードをレビューしながら、スマホで AI の助けを借りる。

### ペアプログラミング
パブリック URL を同僚と共有し、リアルタイムでコラボレーション。

### ホームサーバー設定
ホームサーバーで実行し、家中の任意のデバイスからアクセス。

---

## セキュリティ

OpenCode Remote は複数のセキュリティレイヤーを使用：

| レイヤー | 保護 |
|----------|------|
| **アクセスコード** | セッションごとにランダムな 6 桁のコードが必要 |
| **トークン認証** | ログイン後、JWT ライクなトークンを localStorage に保存 |
| **HTTPS** | パブリックトンネルは Cloudflare 経由で自動的に HTTPS を使用 |
| **一時的な URL** | トンネルを起動するたびにパブリック URL が変更 |

**ベストプラクティス：**
- アクセスコードを公開しない
- 使用しないときはパブリックトンネルを無効化
- 個人使用のみ — マルチユーザーシナリオには設計されていません

---

## 開発

### コマンド

```bash
# すべてを起動（OpenCode サーバー + Web UI）
bun run start

# 開発モード（Web UI のみ、OpenCode サーバーは手動で起動が必要）
bun run dev

# オプションの依存関係をインストール（cloudflared など）
bun run setup

# 本番ビルド
bun run build

# 型チェック
bunx tsc --noEmit
```

### プロジェクト構造

```
opencode-remote/
├── src/
│   ├── pages/           # ページコンポーネント (Chat, Login, Settings, RemoteAccess)
│   ├── components/      # UI コンポーネント
│   ├── lib/             # コアライブラリ (API クライアント, 認証, i18n)
│   ├── stores/          # 状態管理
│   └── types/           # TypeScript 型定義
├── scripts/
│   ├── start.ts         # 起動スクリプト
│   └── setup.ts         # 依存関係セットアップ
└── vite.config.ts       # Vite 設定（認証ミドルウェア含む）
```

---

## 技術スタック

| カテゴリ | 技術 |
|----------|------|
| フレームワーク | SolidJS |
| ビルドツール | Vite |
| スタイリング | Tailwind CSS |
| 言語 | TypeScript |
| パッケージマネージャー | Bun |
| トンネル | Cloudflare Tunnel |

---

## トラブルシューティング

### OpenCode CLI が見つからない

```bash
# セットアップスクリプトを実行してガイド付きインストール
bun run setup

# または手動でインストール：
# macOS/Linux
curl -fsSL https://opencode.ai/install.sh | bash

# Windows
irm https://opencode.ai/install.ps1 | iex
```

### ポートが使用中

```bash
# ポート 5174 を使用しているプロセスを終了
lsof -ti:5174 | xargs kill -9

# または vite.config.ts でポートを変更
```

### パブリックトンネルが動作しない

1. `cloudflared` がインストールされていることを確認：`bun run setup`
2. インターネット接続を確認
3. リモートアクセスページからトンネルを再起動してみる

---

## コントリビューション

コントリビューション歓迎！PR を提出する前にコントリビューションガイドラインをお読みください。

### コードスタイル
- TypeScript 厳格モード
- SolidJS リアクティブパターン
- スタイリングには Tailwind を使用

### コミット規約
- `feat:` 新機能
- `fix:` バグ修正
- `docs:` ドキュメント
- `refactor:` コードリファクタリング

---

## ライセンス

[MIT](LICENSE)

---

## リンク

- [OpenCode](https://opencode.ai) — AI コーディングエージェント
- [ドキュメント](https://opencode.ai/docs) — OpenCode ドキュメント
- [イシュー](https://github.com/realDuang/opencode-remote/issues) — バグ報告や機能リクエスト

---

<div align="center">

**[OpenCode](https://opencode.ai) と [SolidJS](https://solidjs.com) で構築**

</div>
