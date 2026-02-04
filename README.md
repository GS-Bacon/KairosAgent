# AutoClaudeKMP

AIが自律的に収益を稼ぎ、自己改善を続けるシステム

## 概要

このプロジェクトは、AIが自律的に以下を行うシステムです：

- 収益化方法の調査・選定・実行
- 問題発生時の根本原因分析（5 Whys）
- プロセスの自己改善と学習
- 継続的な最適化

## アーキテクチャ

```
┌─────────────────────────────────────────────────────────────────┐
│                       AutoClaudeKMP                             │
├─────────────────────────────────────────────────────────────────┤
│  Orchestrator ──▶ Task Queue ──▶ Claude Code CLI               │
│       │                              │                          │
│       ▼                              ▼                          │
│  Heartbeat (30min)           Tool System                       │
│                              ├─ Browser (Playwright)           │
│                              ├─ File Ops                       │
│                              └─ Web Search                     │
├─────────────────────────────────────────────────────────────────┤
│  Self-Improvement     Risk Management     Resource Manager      │
│  ├─ RCA Engine       ├─ Financial Risk   ├─ CPU/Memory Limit   │
│  ├─ Process Improver ├─ System Risk      └─ Process Priority   │
│  └─ Learning Cycle   └─ Boundary Guard                          │
└─────────────────────────────────────────────────────────────────┘
```

## セットアップ

### 1. 依存関係のインストール

```bash
pnpm install
```

### 2. ビルド

```bash
pnpm build
```

### 3. 設定

```bash
cp config.json.example config.json
# config.json を編集してDiscord Webhook URLなどを設定
```

### 4. 起動

#### 直接起動

```bash
pnpm start
```

#### systemdサービスとして

```bash
sudo cp systemd/auto-claude.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable auto-claude
sudo systemctl start auto-claude
```

## ダッシュボード

```bash
pnpm dashboard
```

または systemd:

```bash
sudo cp systemd/auto-claude-dashboard.service /etc/systemd/system/
sudo systemctl enable auto-claude-dashboard
sudo systemctl start auto-claude-dashboard
```

アクセス: http://localhost:3000 (Tailscale経由でも可能)

## プロジェクト構造

```
/home/bacon/AutoClaudeKMP/
├── apps/
│   ├── orchestrator/    # メインプロセス
│   └── dashboard/       # Webダッシュボード
├── packages/
│   ├── core/           # 共通型・ユーティリティ
│   ├── safety/         # 安全機構
│   ├── backup/         # バックアップ
│   ├── audit/          # 監査ログ
│   ├── notification/   # Discord通知
│   ├── memory/         # メモリ管理
│   ├── ledger/         # 収支管理
│   ├── ai-router/      # Claude CLI連携
│   ├── self-improve/   # 自己改善エンジン
│   ├── strategies/     # 戦略管理
│   ├── compliance/     # 法的コンプライアンス
│   ├── github/         # GitHub管理
│   ├── sandbox/        # テスト環境
│   └── browser/        # ブラウザ自動化
└── workspace/          # 作業ディレクトリ
```

## 制約

- 損失上限: ¥30,000（レバレッジ取引禁止）
- 稼いだ金の再投資は許可
- VM外操作は必ずDiscord承認

## 目標

| 期間 | 目標 |
|------|------|
| 1ヶ月 | ¥2,000 |
| 3ヶ月 | ¥5,000/月 |
| 6ヶ月 | ¥10,000/月 |
| 1年 | サブスク代+電気代を自給 |

## ライセンス

Private - All rights reserved
