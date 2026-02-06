# KairosAgent

## 開発ガイドライン

### Git運用
- 適宜コミットをプッシュすること

### 作業ログ
- **保存場所**: `workspace/logs/YYYY-MM-DD-<topic>.md`
- **命名規則**: 日付 + 作業内容を英語で簡潔に
- **内容**: 概要、実装内容、変更ファイル一覧、検証結果、次のステップ

### アーキテクチャ
- **疎結合**: コアはAPI提供のみ、UI/通知は別コンポーネント
- **フェーズベース**: 8フェーズの改善サイクル
- **プロバイダーパターン**: AIモデルは差し替え可能

### 安全機構（修正禁止）
- `src/safety/` 以下のファイルは自己修正禁止
- 変更前にスナップショット必須
- テスト失敗時は自動ロールバック

### ビルド・実行
```bash
npm install
npm run build
npm start
```

### API
- Port 3100でREST API提供
- `/api/status`, `/api/health`, `/api/events` など

### AI呼び出しルール（必須）

1. **直接プロバイダー作成禁止**:
   - `new ClaudeProvider()` を直接使用しない
   - 必ず `getAIProvider()` 経由で取得

2. **例外**: 以下のファイルのみ直接作成を許可
   - `src/ai/factory.ts`
   - `src/ai/resilient-provider.ts`
   - `src/research/researcher.ts`（Opus用）
   - `src/core/orchestrator.ts`（確認レビュー用）

3. **JSONパース統一**:
   - `response.match(/\{[\s\S]*\}/)` を直接使用しない
   - `src/ai/json-parser.ts` の `parseJSONObject()` / `parseJSONArray()` を使用

4. **レートリミット対応**:
   - `ResilientAIProvider` が自動的にGLMフォールバックを提供
   - フォールバック時は `ConfirmationQueue` に記録され、次サイクルでClaudeがレビュー
