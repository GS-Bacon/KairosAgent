# KairosAgent

半自律AIエージェントシステム — 部署パイプラインによる段階的自律化

## 概要

個人開発者が長期目標を設定し、AIエージェントが自律的に調査・計画・実装・改善を繰り返すCLIベースのシステム。各「部署」をパイプラインステージとして設計し、PoorDevSkillsと同じ思想で構築する。

**半自律スタート + 段階的自律化** — 最初は人間と協働（Level 0）、実績が積み上がったら徐々に自律化。

## アーキテクチャ

```
オーナー（人間）: 目標設定（goals.md）
    │
    ▼
経営部 ──[indicators.json + directives.md]──▶ 企画部 ──[targets.json + assignments.json]──▶ 実行部
    ▲                                                                                          │
    └──────────────────────── metrics.json + execution-report.md ───────────────────────────────┘
```

### 部署 = パイプラインステージ

各部署は統一インターフェースを持つ：
- **入力**: 前ステージの出力（KPI + 要件） + workspace内の任意ファイル
- **処理**: 判断（進める / 止める / 差し戻す）
- **出力**: KPIファイル + 要件ファイル + ステータス（continue / hold / reject）

### KPI三層カスケード

| 部署 | KPIの性質 | ファイル |
|------|-----------|----------|
| 経営部 | 指標（方向性） | `indicators.json` |
| 企画部 | 数値目標 | `targets.json` |
| 実行部 | 実測値 | `metrics.json` |

### エスカレーション

任意の部署がパイプラインを止められる。止めた場合は上流に伝播し、最終的に人間に到達する。

## 初期目標

- **最優先**: システムの安定稼働
- **収益目標**: 月$200（Claudeサブスク費用のペイ）

## CLI

```bash
autoclaude run                    # パイプライン1サイクル実行
autoclaude status                 # 状態確認
autoclaude directive "指示内容"    # 方針設定
autoclaude kpi                    # KPIダッシュボード（三層表示）
autoclaude queue                  # エスカレーション一覧
autoclaude approve <id>           # 承認
autoclaude reject <id> "理由"     # 却下
```

## 技術スタック

| コンポーネント | 技術 |
|-------------|------|
| 言語 | TypeScript + bash |
| AI呼び出し | Claude Code CLI（非対話モード） |
| モデル | Opus（重要判断）/ Sonnet・Haiku（日常）/ GLM5（安価作業） |
| 状態管理 | JSON/Markdownファイル（Git管理） |

## ロードマップ

詳細は [ROADMAP.md](./ROADMAP.md) を参照。

| Phase | 内容 | 状態 |
|-------|------|------|
| 0 | DevSkills成熟（並行・別リポジトリ） | 進行中 |
| 1 | パイプライン基盤 + 最小部署 | 未着手 |
| 2 | 部署の段階的追加 | - |
| 3 | ハートビート（自動化） | - |
| 4 | 信頼レベル昇格 | - |
| 5 | 部署分離・拡張 | - |
| 6 | 自己改善 | - |

## ライセンス

MIT
