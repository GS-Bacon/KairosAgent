import { getLogger, generateId, formatDateTime } from '@auto-claude/core';
import { getClaudeCLI } from '@auto-claude/ai-router';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type {
  Problem,
  RootCause,
  RootCauseCategory,
  RecurringPattern,
  WhyAnalysis,
} from './types.js';
import { RootCauseCategory as RCC } from './types.js';

const logger = getLogger('self-improve:rca');

export interface RCAConfig {
  workspaceDir: string;
  maxWhyDepth: number;
  similarityThreshold: number;
}

export class RootCauseAnalyzer {
  private config: RCAConfig;
  private problemHistory: Problem[] = [];
  private rootCauses: RootCause[] = [];
  private claudeCLI = getClaudeCLI();

  constructor(config: Partial<RCAConfig> = {}) {
    this.config = {
      workspaceDir: config.workspaceDir ?? '/home/bacon/AutoClaudeKMP/workspace',
      maxWhyDepth: config.maxWhyDepth ?? 5,
      similarityThreshold: config.similarityThreshold ?? 0.7,
    };

    this.ensureDirectories();
    this.loadHistory();
    logger.info('RootCauseAnalyzer initialized');
  }

  private ensureDirectories(): void {
    if (!existsSync(this.config.workspaceDir)) {
      mkdirSync(this.config.workspaceDir, { recursive: true });
    }
  }

  private getHistoryPath(): string {
    return join(this.config.workspaceDir, 'ROOT_CAUSES.jsonl');
  }

  private getProblemsPath(): string {
    return join(this.config.workspaceDir, 'PROBLEMS.jsonl');
  }

  private loadHistory(): void {
    const problemsPath = this.getProblemsPath();
    if (existsSync(problemsPath)) {
      try {
        const content = readFileSync(problemsPath, 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean);
        this.problemHistory = lines.map((line) => {
          const p = JSON.parse(line);
          p.timestamp = new Date(p.timestamp);
          return p as Problem;
        });
      } catch (error) {
        logger.error('Failed to load problem history', { error });
      }
    }

    const rcPath = this.getHistoryPath();
    if (existsSync(rcPath)) {
      try {
        const content = readFileSync(rcPath, 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean);
        this.rootCauses = lines.map((line) => JSON.parse(line) as RootCause);
      } catch (error) {
        logger.error('Failed to load root causes', { error });
      }
    }
  }

  async registerProblem(
    problem: Omit<Problem, 'id' | 'timestamp'>
  ): Promise<Problem> {
    const fullProblem: Problem = {
      ...problem,
      id: generateId('prob'),
      timestamp: new Date(),
    };

    this.problemHistory.push(fullProblem);
    this.saveProblem(fullProblem);

    logger.info('Problem registered', {
      id: fullProblem.id,
      type: fullProblem.type,
      description: fullProblem.description.slice(0, 100),
    });

    return fullProblem;
  }

  private saveProblem(problem: Problem): void {
    const path = this.getProblemsPath();
    const line = JSON.stringify(problem) + '\n';
    appendFileSync(path, line, 'utf-8');
  }

  private saveRootCause(rootCause: RootCause): void {
    const path = this.getHistoryPath();
    const line = JSON.stringify(rootCause) + '\n';
    appendFileSync(path, line, 'utf-8');
  }

  async analyzeWithFiveWhys(problem: Problem): Promise<RootCause[]> {
    const causes: RootCause[] = [];
    let currentQuestion = `なぜ「${problem.description}」が起きたのか？`;
    let depth = 0;

    logger.info('Starting 5 Whys analysis', { problemId: problem.id });

    while (depth < this.config.maxWhyDepth) {
      const analysis = await this.askWhy(currentQuestion, problem.context, causes);

      if (!analysis || analysis.isRootCause) {
        if (analysis) {
          const finalCause: RootCause = {
            problemId: problem.id,
            category: analysis.category,
            description: analysis.answer,
            evidence: analysis.evidence,
            confidence: analysis.confidence,
            depth: depth + 1,
          };
          causes.push(finalCause);
          this.rootCauses.push(finalCause);
          this.saveRootCause(finalCause);
        }
        break;
      }

      const cause: RootCause = {
        problemId: problem.id,
        category: analysis.category,
        description: analysis.answer,
        evidence: analysis.evidence,
        confidence: analysis.confidence,
        depth: depth + 1,
      };

      causes.push(cause);
      this.rootCauses.push(cause);
      this.saveRootCause(cause);

      currentQuestion = `なぜ「${analysis.answer}」が起きたのか？`;
      depth++;
    }

    logger.info('5 Whys analysis completed', {
      problemId: problem.id,
      depth: causes.length,
    });

    return causes;
  }

  private async askWhy(
    question: string,
    context: Record<string, unknown>,
    previousCauses: RootCause[]
  ): Promise<WhyAnalysis | null> {
    const prompt = `以下の問題について根本原因を分析してください。

## 質問
${question}

## コンテキスト
${JSON.stringify(context, null, 2)}

## これまでの分析
${previousCauses.map((c, i) => `${i + 1}. ${c.description}`).join('\n')}

## 回答形式（JSON）
{
  "answer": "原因の説明",
  "category": "カテゴリ（以下から選択: process_missing, process_flawed, process_not_followed, knowledge_gap, outdated_info, assumption_wrong, code_bug, design_flaw, integration_issue, external_change, dependency_failure, resource_constraint, risk_underestimated, wrong_decision）",
  "evidence": ["根拠1", "根拠2"],
  "confidence": 0.0-1.0の確信度,
  "isRootCause": これ以上深く分析する必要がないならtrue
}

JSONのみを返してください。`;

    try {
      const result = await this.claudeCLI.executeTask({
        prompt,
        allowedTools: ['Read', 'Grep', 'WebSearch'],
        timeout: 2 * 60 * 1000,
      });

      if (!result.success) {
        logger.error('5 Whys analysis failed', { error: result.error });
        return null;
      }

      // JSON部分を抽出
      const jsonMatch = result.output.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.error('Failed to parse 5 Whys response', { output: result.output });
        return null;
      }

      const analysis = JSON.parse(jsonMatch[0]) as WhyAnalysis;
      return analysis;
    } catch (error) {
      logger.error('5 Whys analysis error', { error });
      return null;
    }
  }

  async findSimilarProblems(problem: Problem): Promise<Problem[]> {
    const keywords = this.extractKeywords(problem.description);

    return this.problemHistory.filter((p) => {
      if (p.id === problem.id) return false;

      const similarity = this.calculateSimilarity(
        keywords,
        this.extractKeywords(p.description)
      );

      return similarity >= this.config.similarityThreshold;
    });
  }

  private extractKeywords(text: string): Set<string> {
    const words = text
      .toLowerCase()
      .replace(/[^\w\s\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2);

    return new Set(words);
  }

  private calculateSimilarity(set1: Set<string>, set2: Set<string>): number {
    const intersection = new Set([...set1].filter((x) => set2.has(x)));
    const union = new Set([...set1, ...set2]);

    if (union.size === 0) return 0;
    return intersection.size / union.size;
  }

  async detectRecurringPatterns(): Promise<RecurringPattern[]> {
    const patterns: RecurringPattern[] = [];

    // カテゴリ別に集計
    const byCategory = new Map<string, RootCause[]>();

    for (const cause of this.rootCauses) {
      const existing = byCategory.get(cause.category) ?? [];
      existing.push(cause);
      byCategory.set(cause.category, existing);
    }

    for (const [category, causes] of byCategory.entries()) {
      if (causes.length >= 3) {
        const problems = causes
          .map((c) => this.problemHistory.find((p) => p.id === c.problemId))
          .filter((p): p is Problem => p !== undefined);

        if (problems.length >= 3) {
          const timestamps = problems.map((p) => p.timestamp.getTime()).sort();
          const firstOccurrence = new Date(timestamps[0]);
          const lastOccurrence = new Date(timestamps[timestamps.length - 1]);

          const daysBetween =
            (lastOccurrence.getTime() - firstOccurrence.getTime()) /
            (1000 * 60 * 60 * 24);
          const frequency = daysBetween > 0 ? causes.length / daysBetween : causes.length;

          const avgSeverity =
            problems.reduce((sum, p) => sum + p.severity, 0) / problems.length;

          patterns.push({
            category,
            occurrences: causes.length,
            firstOccurrence,
            lastOccurrence,
            frequency,
            severity: avgSeverity,
            suggestedAction: this.suggestAction(category),
          });
        }
      }
    }

    return patterns.sort((a, b) => b.severity - a.severity);
  }

  private suggestAction(category: string): string {
    const suggestions: Record<string, string> = {
      [RCC.PROCESS_MISSING]: 'プロセスを新規作成する必要があります',
      [RCC.PROCESS_FLAWED]: 'プロセスを見直し、改善してください',
      [RCC.PROCESS_NOT_FOLLOWED]: 'プロセス遵守の仕組みを強化してください',
      [RCC.KNOWLEDGE_GAP]: '知識の習得・ドキュメント化が必要です',
      [RCC.OUTDATED_INFO]: '定期的な情報更新の仕組みを導入してください',
      [RCC.ASSUMPTION_WRONG]: '前提条件の検証プロセスを追加してください',
      [RCC.CODE_BUG]: 'テストカバレッジを向上させてください',
      [RCC.DESIGN_FLAW]: 'アーキテクチャの見直しが必要です',
      [RCC.INTEGRATION_ISSUE]: '連携部分のテスト・監視を強化してください',
      [RCC.EXTERNAL_CHANGE]: '外部変更の監視・通知を導入してください',
      [RCC.DEPENDENCY_FAILURE]: '依存関係のフォールバックを検討してください',
      [RCC.RESOURCE_CONSTRAINT]: 'リソース管理の見直しが必要です',
      [RCC.RISK_UNDERESTIMATED]: 'リスク評価プロセスを改善してください',
      [RCC.WRONG_DECISION]: '意思決定プロセスに検証ステップを追加してください',
    };

    return suggestions[category] ?? '詳細な分析が必要です';
  }

  getProblemHistory(): Problem[] {
    return [...this.problemHistory];
  }

  getRootCauses(): RootCause[] {
    return [...this.rootCauses];
  }

  getRecentProblems(days: number = 7): Problem[] {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return this.problemHistory.filter((p) => p.timestamp >= cutoff);
  }
}

let instance: RootCauseAnalyzer | null = null;

export function getRootCauseAnalyzer(config?: Partial<RCAConfig>): RootCauseAnalyzer {
  if (!instance) {
    instance = new RootCauseAnalyzer(config);
  }
  return instance;
}
