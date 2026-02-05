/**
 * Prevention Generator
 *
 * AIを使用して予防策を生成する
 */

import { getAIProvider } from "../ai/factory.js";
import { TroublePattern, PreventionSuggestion, PreventionType } from "./types.js";
import { Trouble } from "../trouble/types.js";
import { logger } from "../core/logger.js";

interface GenerationContext {
  pattern: TroublePattern;
  recentTroubles: Trouble[];
  existingSuggestions: PreventionSuggestion[];
}

export class PreventionGenerator {
  private knownPreventions: Map<string, PreventionSuggestion[]> = new Map();

  constructor() {
    // 既知の予防策を初期化
    this.initializeKnownPreventions();
  }

  /**
   * パターンに対する予防策を生成
   */
  async generate(context: GenerationContext): Promise<PreventionSuggestion[]> {
    const { pattern, recentTroubles, existingSuggestions } = context;

    // 1. ルールベースで既知の予防策をチェック
    const knownSuggestions = this.getKnownPreventions(pattern);
    if (knownSuggestions.length > 0) {
      logger.debug("Using known prevention suggestions", {
        pattern: pattern.name,
        count: knownSuggestions.length,
      });
      return this.filterDuplicates(knownSuggestions, existingSuggestions);
    }

    // 2. 信頼度が低い場合はAIで生成
    if (pattern.confidence < 0.7) {
      return this.generateWithAI(pattern, recentTroubles);
    }

    // 3. 高信頼度パターンは簡易生成
    return this.generateSimple(pattern);
  }

  /**
   * AIを使用して予防策を生成
   */
  private async generateWithAI(
    pattern: TroublePattern,
    troubles: Trouble[]
  ): Promise<PreventionSuggestion[]> {
    try {
      const ai = getAIProvider();

      const troubleExamples = troubles
        .slice(0, 3)
        .map((t) => `- ${t.message}`)
        .join("\n");

      const prompt = `以下のトラブルパターンに対する予防策を提案してください。

パターン名: ${pattern.name}
カテゴリ: ${pattern.category}
説明: ${pattern.description}

最近のトラブル例:
${troubleExamples}

以下のJSON形式で3つまでの予防策を提案してください:
[
  {
    "type": "naming-convention" | "lint-rule" | "pre-commit" | "architecture" | "testing" | "documentation" | "tooling" | "process",
    "description": "予防策の説明",
    "implementation": "具体的な実装方法（コード例や設定例）",
    "automated": true/false
  }
]

JSONのみを返してください。`;

      const response = await ai.chat(prompt);

      // JSONをパース
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        logger.warn("Failed to parse AI prevention suggestions", {
          response: response.slice(0, 200),
        });
        return this.generateSimple(pattern);
      }

      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.map(
        (item: {
          type?: string;
          description?: string;
          implementation?: string;
          automated?: boolean;
        }) => ({
          id: `prev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          type: this.validatePreventionType(item.type),
          description: item.description || "",
          implementation: item.implementation,
          automated: item.automated ?? false,
          confidence: 0.6,
        })
      );
    } catch (error) {
      logger.error("AI prevention generation failed", { error });
      return this.generateSimple(pattern);
    }
  }

  /**
   * シンプルなルールベース生成
   */
  private generateSimple(pattern: TroublePattern): PreventionSuggestion[] {
    const suggestions: PreventionSuggestion[] = [];

    switch (pattern.category) {
      case "build-error":
        suggestions.push(this.createSuggestion("pre-commit", "ビルドチェックをpre-commitフックに追加", "npm run build を .husky/pre-commit に追加"));
        break;

      case "test-failure":
        suggestions.push(this.createSuggestion("testing", "テストカバレッジの向上", "jest --coverage で未テストコードを特定"));
        suggestions.push(this.createSuggestion("pre-commit", "テスト実行をpre-commitフックに追加", "npm test を .husky/pre-commit に追加"));
        break;

      case "naming-conflict":
        suggestions.push(this.createSuggestion("naming-convention", "モジュールプレフィックス命名規則の導入", "CONVENTIONS.mdに命名規則を追記"));
        suggestions.push(this.createSuggestion("lint-rule", "重複名チェックのESLintルール追加", "eslint-plugin-import の no-duplicates ルールを有効化"));
        break;

      case "type-error":
        suggestions.push(this.createSuggestion("lint-rule", "TypeScript strictモードの有効化", "tsconfig.json で \"strict\": true を設定"));
        break;

      case "lint-error":
        suggestions.push(this.createSuggestion("pre-commit", "lint-stagedによる自動修正", "npx lint-staged を .husky/pre-commit に追加"));
        break;

      case "dependency-error":
        suggestions.push(this.createSuggestion("tooling", "依存関係の定期更新", "npm audit と npm outdated を定期実行"));
        break;

      default:
        suggestions.push(this.createSuggestion("documentation", "トラブル対応手順の文書化", "TROUBLESHOOTING.md を作成"));
    }

    return suggestions;
  }

  /**
   * 既知の予防策を取得
   */
  private getKnownPreventions(pattern: TroublePattern): PreventionSuggestion[] {
    // カテゴリ別の既知予防策を返す
    const categoryKey = pattern.category;
    return this.knownPreventions.get(categoryKey) || [];
  }

  /**
   * 重複を除去
   */
  private filterDuplicates(
    newSuggestions: PreventionSuggestion[],
    existing: PreventionSuggestion[]
  ): PreventionSuggestion[] {
    const existingDescriptions = new Set(existing.map((s) => s.description.toLowerCase()));
    return newSuggestions.filter(
      (s) => !existingDescriptions.has(s.description.toLowerCase())
    );
  }

  private createSuggestion(
    type: PreventionType,
    description: string,
    implementation: string,
    automated: boolean = true
  ): PreventionSuggestion {
    return {
      id: `prev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type,
      description,
      implementation,
      automated,
      confidence: 0.8,
    };
  }

  private validatePreventionType(type?: string): PreventionType {
    const validTypes: PreventionType[] = [
      "naming-convention",
      "lint-rule",
      "pre-commit",
      "architecture",
      "testing",
      "documentation",
      "tooling",
      "process",
    ];

    if (type && validTypes.includes(type as PreventionType)) {
      return type as PreventionType;
    }
    return "process";
  }

  private initializeKnownPreventions(): void {
    // ビルドエラー
    this.knownPreventions.set("build-error", [
      this.createSuggestion("pre-commit", "ビルドチェックをpre-commitフックに追加", "npm run build を .husky/pre-commit に追加"),
      this.createSuggestion("tooling", "TypeScriptの増分コンパイルを有効化", "tsconfig.json で \"incremental\": true を設定"),
    ]);

    // テスト失敗
    this.knownPreventions.set("test-failure", [
      this.createSuggestion("testing", "テストカバレッジ基準の設定", "jest.config.js で coverageThreshold を設定"),
      this.createSuggestion("pre-commit", "変更ファイルのテストをpre-commitで実行", "jest --findRelatedTests を使用"),
    ]);

    // 名前重複
    this.knownPreventions.set("naming-conflict", [
      this.createSuggestion("naming-convention", "モジュールプレフィックス命名規則", "例: authValidate, userValidate のようにプレフィックスを付与"),
      this.createSuggestion("lint-rule", "ESLint import/no-duplicates", "eslint-plugin-import を追加して重複チェック"),
    ]);

    // 型エラー
    this.knownPreventions.set("type-error", [
      this.createSuggestion("lint-rule", "TypeScript strictモード", "tsconfig.json: \"strict\": true, \"noImplicitAny\": true"),
      this.createSuggestion("tooling", "ts-expect-errorの使用制限", "eslint: @typescript-eslint/ban-ts-comment を設定"),
    ]);
  }
}

export const preventionGenerator = new PreventionGenerator();
