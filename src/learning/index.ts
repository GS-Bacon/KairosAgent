/**
 * Adaptive Learning System - Public API
 *
 * 学習システムの公開インターフェース
 */

// 型定義のエクスポート
export * from "./types.js";

// モジュールのエクスポート
export { PatternRepository, patternRepository } from "./pattern-repository.js";
export { RuleEngine, ruleEngine } from "./rule-engine.js";
export { AIAnalyzer, aiAnalyzer } from "./ai-analyzer.js";
export {
  PatternExtractor,
  patternExtractor,
} from "./pattern-extractor.js";
export type { FailurePattern } from "./pattern-extractor.js";

// 初期化ヘルパー
import { patternRepository } from "./pattern-repository.js";
import { ruleEngine } from "./rule-engine.js";

/**
 * 学習システム全体を初期化
 */
export async function initializeLearningSystem(): Promise<void> {
  await patternRepository.initialize();
  await ruleEngine.initialize();
}
