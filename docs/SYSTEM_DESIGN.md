# MoltBot システム設計書

## 1. 概要

MoltBotは自己改善型AIシステムです。長期間動いて自律的に自分自身のコードを修正・改善し続けます。

### 設計原則

1. **疎結合**: コアはAPI提供のみ。UI/通知は別コンポーネント
2. **フェーズベース**: ループの各フェーズは独立モジュール、Orchestratorは薄いレイヤー
3. **単一責任**: 各モジュールは1つの機能に集中
4. **プロバイダーパターン**: AIモデルは差し替え可能（Claude, GLM, Ollama等）
5. **フェイルセーフ**: 修正失敗時は必ずロールバック
6. **観測可能性**: 全てのアクションはログとAPIで確認可能

## 2. アーキテクチャ

```
┌─────────────────────────────────────────────────────────┐
│                    MoltBot Core                         │
│  (自己改善エンジン - API提供)                            │
│                                                         │
│  ┌─────────┐  ┌───────────┐  ┌─────────┐              │
│  │ 診断    │  │ 修正      │  │ 安全    │              │
│  │ Engine  │→ │ Engine    │→ │ Guard   │              │
│  └─────────┘  └───────────┘  └─────────┘              │
│                      │                                  │
│              ┌───────┴───────┐                         │
│              │   REST API    │ ← 全ての外部通信はここ経由│
│              │   (Port 3100) │                         │
│              └───────────────┘                         │
└─────────────────────────────────────────────────────────┘
                       │
         ┌─────────────┼─────────────┐
         │             │             │
         ▼             ▼             ▼
    ┌─────────┐  ┌─────────┐  ┌─────────────┐
    │ CLI     │  │ WebUI   │  │ 通知サービス │
    │ Client  │  │ (別プロジェクト)│  │ (将来)     │
    └─────────┘  └─────────┘  └─────────────┘
```

## 3. 改善サイクル（8フェーズ）

```
┌──────────────┐
│ Phase 1      │ ヘルスチェック
│ health-check │ → システム正常性確認
└──────┬───────┘
       ↓
┌──────────────┐
│ Phase 2      │ エラー検出
│ error-detect │ → ログ/実行エラーの検出
└──────┬───────┘
       ↓
┌──────────────┐
│ Phase 3      │ 改善点検出
│ improve-find │ → TODO、コード品質問題の検出
└──────┬───────┘
       ↓ (問題/改善点があれば続行)
┌──────────────┐
│ Phase 4      │ 検索・調査
│ search       │ → 関連コード、依存関係、パターン調査
└──────┬───────┘
       ↓
┌──────────────┐
│ Phase 5      │ 修正計画
│ plan         │ → 影響範囲特定、修正方針決定
└──────┬───────┘
       ↓
┌──────────────┐
│ Phase 6      │ コード実装
│ implement    │ → スナップショット作成、AIでコード生成
└──────┬───────┘
       ↓
┌──────────────┐
│ Phase 7      │ テスト生成
│ test-gen     │ → 修正に対するテスト自動生成
└──────┬───────┘
       ↓
┌──────────────┐
│ Phase 8      │ テスト実行・検証
│ verify       │ → テスト実行、成功→コミット、失敗→ロールバック
└──────────────┘
```

## 4. ディレクトリ構成

```
MoltBot/
├── src/
│   ├── index.ts              # エントリーポイント
│   │
│   ├── core/
│   │   ├── orchestrator.ts   # フェーズの組み合わせのみ（薄いレイヤー）
│   │   ├── scheduler.ts      # 定期タスク
│   │   ├── logger.ts         # ロギング
│   │   └── event-bus.ts      # イベント管理
│   │
│   ├── phases/               # ★ ループの各フェーズをモジュール化
│   │   ├── types.ts          # フェーズ共通型
│   │   ├── 1-health-check/
│   │   ├── 2-error-detect/
│   │   ├── 3-improve-find/
│   │   ├── 4-search/
│   │   ├── 5-plan/
│   │   ├── 6-implement/
│   │   ├── 7-test-gen/
│   │   └── 8-verify/
│   │
│   ├── ai/                   # AIモデル抽象化
│   │   ├── provider.ts       # インターフェース
│   │   ├── claude-provider.ts
│   │   ├── glm-provider.ts
│   │   └── factory.ts
│   │
│   ├── safety/               # 安全機構
│   │   ├── snapshot.ts       # スナップショット
│   │   ├── guard.ts          # 変更制限
│   │   └── rollback.ts       # ロールバック
│   │
│   └── api/                  # REST API
│       ├── server.ts
│       ├── routes.ts
│       └── types.ts
│
├── workspace/
│   ├── logs/
│   ├── history/
│   └── snapshots/
│
├── cli/                      # CLIクライアント（別パッケージ）
│   └── src/
│       └── index.ts
│
├── tests/
└── docs/
```

## 5. REST API

### エンドポイント (Port 3100)

| Endpoint | Method | 説明 |
|----------|--------|------|
| `/api/status` | GET | システム状態 |
| `/api/health` | GET | ヘルスチェック（k8s/監視ツール用） |
| `/api/logs` | GET | ログ取得（ページング対応） |
| `/api/history` | GET | 変更履歴 |
| `/api/history/:id` | GET | 特定の変更詳細 |
| `/api/trigger/check` | POST | 手動でチェック実行 |
| `/api/trigger/repair` | POST | 手動で修正実行 |
| `/api/config` | GET | 現在の設定 |
| `/api/config` | PUT | 設定変更 |
| `/api/events` | GET | SSE (Server-Sent Events) |

### レスポンス例

**GET /api/status**
```json
{
  "state": "running",
  "uptime_seconds": 302520,
  "last_check": "2026-02-05T10:30:00Z",
  "stats": {
    "modifications_7d": 12,
    "rollbacks_7d": 1,
    "errors_7d": 3
  },
  "next_check": "2026-02-05T11:00:00Z"
}
```

**SSEイベント例 (GET /api/events)**
```
event: check_started
data: {"timestamp": "2026-02-05T10:30:00Z"}

event: modification
data: {"file": "src/core/logger.ts", "type": "fix", "description": "Fixed typo"}

event: rollback
data: {"reason": "test_failed", "snapshot_id": "snap_123"}
```

## 6. 安全機構

### 6.1 スナップショット

- 修正前に必ずコード全体を保存
- 最新10個を保持、古いものは自動削除

### 6.2 変更制限（Guard）

- 1回の修正で変更できるファイル数を制限（デフォルト5）
- 禁止パターン: `src/safety/`, `package.json`, `.env` など
- 許可された拡張子のみ: `.ts`, `.js`, `.json`, `.md`
- 危険なコードパターンの検出

### 6.3 ロールバック

- テスト失敗時は自動でスナップショットに戻す
- ロールバック履歴を保持

## 7. AIプロバイダー

### インターフェース

```typescript
interface AIProvider {
  name: string;
  generateCode(prompt: string, context: CodeContext): Promise<string>;
  generateTest(code: string, context: TestContext): Promise<string>;
  analyzeCode(code: string): Promise<Analysis>;
  searchAndAnalyze(query: string, codebase: string[]): Promise<SearchResult>;
  chat(prompt: string): Promise<string>;
  isAvailable(): Promise<boolean>;
}
```

### 設定

```json
{
  "ai": {
    "provider": "claude",
    "claude": {
      "model": "claude-sonnet-4-20250514"
    },
    "glm": {
      "apiKey": "...",
      "model": "glm-4"
    }
  }
}
```

## 8. 将来の拡張

- **WebUI**: 別リポジトリでReact/Vue等で実装、APIを叩く
- **通知サービス**: Discord/Slack等、APIのSSEを購読して通知
- **監視ツール連携**: Prometheus/Grafana等、/api/health と /api/status を使用
