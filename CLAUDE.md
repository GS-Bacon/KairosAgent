# MoltBot

## 開発ガイドライン

### Git運用
- 適宜コミットをプッシュすること

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
