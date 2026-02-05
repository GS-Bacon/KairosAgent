# MoltBot

自己改善型AIシステム - 長期間動いて自律的に自分自身のコードを修正・改善し続けます。

## 概要

MoltBotは以下の特徴を持つシステムです：

- **自己修正**: AIが自分自身のソースコードを改善
- **フェイルセーフ**: 変更前にスナップショット、失敗時は自動ロールバック
- **疎結合**: コアはREST API提供のみ、UI/通知は別コンポーネント
- **長期安定稼働**: エラーからの自動復旧

## アーキテクチャ

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
```

## 改善サイクル（8フェーズ）

```
Phase 1: health-check  → システム正常性確認
Phase 2: error-detect  → ログ/ビルドエラー検出
Phase 3: improve-find  → TODO/FIXME、品質問題検出
Phase 4: search        → 関連コード調査
Phase 5: plan          → 修正計画作成
Phase 6: implement     → スナップショット→コード生成
Phase 7: test-gen      → テスト自動生成
Phase 8: verify        → テスト実行→成功:コミット/失敗:ロールバック
```

## セットアップ

### インストール

```bash
npm install
npm run build
```

### 設定

```bash
# config.json を編集
{
  "port": 3100,
  "checkInterval": 1800000,  // 30分
  "ai": {
    "provider": "claude"  // or "glm"
  }
}
```

### 起動

```bash
npm start
```

## REST API

| Endpoint | Method | 説明 |
|----------|--------|------|
| `/api/status` | GET | システム状態 |
| `/api/health` | GET | ヘルスチェック |
| `/api/logs` | GET | ログ取得 |
| `/api/history` | GET | 変更履歴 |
| `/api/events` | GET | SSE (リアルタイム) |
| `/api/trigger/check` | POST | 手動チェック実行 |
| `/api/trigger/repair` | POST | 手動修正実行 |
| `/api/config` | GET/PUT | 設定 |

## CLI

```bash
cd cli
npm install
npm run build
npm link

moltbot status          # システム状態
moltbot health          # ヘルスチェック
moltbot logs            # ログ表示
moltbot history         # 変更履歴
moltbot check           # チェック実行
moltbot watch           # リアルタイム監視
```

## ディレクトリ構造

```
MoltBot/
├── src/
│   ├── index.ts              # エントリーポイント
│   ├── core/                 # コア機能
│   │   ├── orchestrator.ts   # フェーズ制御
│   │   ├── scheduler.ts      # 定期実行
│   │   ├── logger.ts         # ロギング
│   │   └── event-bus.ts      # イベント管理
│   ├── phases/               # 8つのフェーズ
│   ├── ai/                   # AIプロバイダー
│   ├── safety/               # 安全機構
│   └── api/                  # REST API
├── cli/                      # CLIクライアント
├── workspace/                # 作業ディレクトリ
└── tests/                    # テスト
```

## 安全機構

1. **スナップショット**: 修正前にコード全体を保存
2. **変更制限**: 1回の修正で変更できるファイル数を制限
3. **禁止パターン**: 安全機構自体は修正禁止
4. **テスト必須**: 修正後は必ずテスト実行
5. **自動ロールバック**: テスト失敗時は自動で戻す

## ライセンス

MIT
