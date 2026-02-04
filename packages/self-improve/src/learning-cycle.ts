import { getLogger, formatDateTime, formatDate } from '@auto-claude/core';
import { getDiscordNotifier } from '@auto-claude/notification';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { Problem, RootCause, ProcessImprovement, LearningReport, RecurringPattern } from './types.js';
import { getRootCauseAnalyzer } from './root-cause-analyzer.js';
import { getProcessImprover } from './process-improver.js';

const logger = getLogger('self-improve:learning');

export interface LearningCycleConfig {
  workspaceDir: string;
  autoAnalyze: boolean;
}

export class LearningCycleManager {
  private config: LearningCycleConfig;
  private rcAnalyzer = getRootCauseAnalyzer();
  private processImprover = getProcessImprover();
  private discord = getDiscordNotifier();

  constructor(config: Partial<LearningCycleConfig> = {}) {
    this.config = {
      workspaceDir: config.workspaceDir ?? '/home/bacon/AutoClaudeKMP/workspace',
      autoAnalyze: config.autoAnalyze ?? true,
    };

    this.ensureDirectories();
    logger.info('LearningCycleManager initialized');
  }

  private ensureDirectories(): void {
    if (!existsSync(this.config.workspaceDir)) {
      mkdirSync(this.config.workspaceDir, { recursive: true });
    }
  }

  private getCyclesPath(): string {
    return join(this.config.workspaceDir, 'LEARNING_CYCLES.md');
  }

  async registerProblem(
    problem: Omit<Problem, 'id' | 'timestamp'>
  ): Promise<void> {
    // 問題を登録
    const fullProblem = await this.rcAnalyzer.registerProblem(problem);

    // 類似問題があるか確認
    const similar = await this.rcAnalyzer.findSimilarProblems(fullProblem);

    if (similar.length > 0) {
      await this.discord.send({
        type: 'warning',
        title: '類似問題の再発',
        description: `「${fullProblem.description}」は過去${similar.length}回発生しています。根本的な対策が必要です。`,
      });
    }

    // 自動分析が有効な場合、根本原因分析を開始
    if (this.config.autoAnalyze) {
      const rootCauses = await this.rcAnalyzer.analyzeWithFiveWhys(fullProblem);

      // 最も深い原因に対して改善を提案
      if (rootCauses.length > 0) {
        const deepestCause = rootCauses[rootCauses.length - 1];
        const improvement = await this.processImprover.proposeImprovement(deepestCause);

        await this.recordCycle(fullProblem, rootCauses, improvement);
      }
    }
  }

  private async recordCycle(
    problem: Problem,
    rootCauses: RootCause[],
    improvement: ProcessImprovement
  ): Promise<void> {
    const path = this.getCyclesPath();

    let content = '';
    if (existsSync(path)) {
      content = readFileSync(path, 'utf-8');
    } else {
      content = '# 学習サイクル履歴\n\n';
    }

    const entry = `
## ${formatDate(new Date())} - ${problem.description}

### 問題
- ID: ${problem.id}
- タイプ: ${problem.type}
- 重要度: ${problem.severity}

### 根本原因分析
${rootCauses.map((rc, i) => `${i + 1}. **${rc.category}**: ${rc.description} (確信度: ${(rc.confidence * 100).toFixed(0)}%)`).join('\n')}

### 提案された改善
- ID: ${improvement.id}
- タイプ: ${improvement.type}
- 対象: ${improvement.target}
- 説明: ${improvement.description}
- 実装: ${improvement.implementation}

---
`;

    content += entry;
    writeFileSync(path, content, 'utf-8');
  }

  async dailyReview(): Promise<LearningReport> {
    const today = new Date();

    // 昨日の問題を集計
    const recentProblems = this.rcAnalyzer.getRecentProblems(1);

    // 繰り返しパターンを検出
    const patterns = await this.rcAnalyzer.detectRecurringPatterns();

    // 保留中の改善を確認
    const pendingImprovements = this.processImprover.getPendingImprovements();

    // 検証が必要な改善を確認
    const implementedImprovements = this.processImprover.getImplementedImprovements();
    let verifiedToday = 0;

    for (const improvement of implementedImprovements) {
      const score = await this.processImprover.verifyImprovement(improvement.id);
      if (score >= 0) {
        verifiedToday++;
      }
    }

    const recommendations = await this.generateRecommendations(patterns);

    const report: LearningReport = {
      date: today,
      problemCount: recentProblems.length,
      recurringPatterns: patterns,
      pendingImprovements: pendingImprovements.length,
      verifiedToday,
      recommendations,
    };

    // Discordに要約を送信
    if (recentProblems.length > 0 || patterns.length > 0) {
      await this.discord.send({
        type: 'info',
        title: '日次学習レポート',
        description: `問題: ${recentProblems.length}件, 繰り返しパターン: ${patterns.length}件`,
        fields: [
          {
            name: '保留中の改善',
            value: `${pendingImprovements.length}件`,
            inline: true,
          },
          {
            name: '本日検証',
            value: `${verifiedToday}件`,
            inline: true,
          },
        ],
      });
    }

    return report;
  }

  private async generateRecommendations(
    patterns: RecurringPattern[]
  ): Promise<string[]> {
    const recommendations: string[] = [];

    // 高頻度・高重要度のパターンに基づく推奨
    const criticalPatterns = patterns.filter(
      (p) => p.occurrences >= 5 || p.severity >= 3
    );

    for (const pattern of criticalPatterns) {
      if (pattern.suggestedAction) {
        recommendations.push(
          `[${pattern.category}] ${pattern.suggestedAction} (発生${pattern.occurrences}回)`
        );
      }
    }

    // 保留中の改善がある場合
    const pending = this.processImprover.getPendingImprovements();
    if (pending.length > 3) {
      recommendations.push(
        `保留中の改善が${pending.length}件あります。優先度の高いものから実装を検討してください。`
      );
    }

    return recommendations;
  }

  async exportLearningHistory(): Promise<string> {
    const problems = this.rcAnalyzer.getProblemHistory();
    const rootCauses = this.rcAnalyzer.getRootCauses();
    const improvements = this.processImprover.getImprovements();
    const patterns = await this.rcAnalyzer.detectRecurringPatterns();

    const verifiedImprovements = improvements.filter((i) => i.status === 'verified');
    const implementedImprovements = improvements.filter(
      (i) => i.status === 'implemented' || i.status === 'verified'
    );

    return `# 学習履歴

## 概要
- 総問題数: ${problems.length}
- 根本原因分析: ${rootCauses.length}
- 実施した改善: ${implementedImprovements.length}
- 検証済み改善: ${verifiedImprovements.length}

## 繰り返しパターン（要注意）
${patterns.map((p) => `- **${p.category}**: ${p.occurrences}回発生 (重要度: ${p.severity.toFixed(1)})`).join('\n') || 'なし'}

## 改善効果
${verifiedImprovements
  .map(
    (i) =>
      `- ${i.description}: 効果 ${((i.effectivenessScore ?? 0) * 100).toFixed(0)}%`
  )
  .join('\n') || 'まだ検証された改善がありません'}

## 最近の学習サイクル
${problems
  .slice(-5)
  .map((p) => {
    const causes = rootCauses.filter((rc) => rc.problemId === p.id);
    const improvement = improvements.find((i) => i.rootCauseId === p.id);

    return `
### ${formatDate(p.timestamp)} - ${p.description}
- 根本原因: ${causes[causes.length - 1]?.description ?? '未分析'}
- 改善: ${improvement?.description ?? '未提案'}
- 状態: ${improvement?.status ?? '不明'}
`;
  })
  .join('\n')}
`;
  }

  async getStats(): Promise<{
    totalProblems: number;
    totalRootCauses: number;
    totalImprovements: number;
    verifiedImprovements: number;
    averageEffectiveness: number;
  }> {
    const improvements = this.processImprover.getImprovements();
    const verified = improvements.filter((i) => i.status === 'verified');
    const scores = verified
      .map((i) => i.effectivenessScore ?? 0)
      .filter((s) => s > 0);

    return {
      totalProblems: this.rcAnalyzer.getProblemHistory().length,
      totalRootCauses: this.rcAnalyzer.getRootCauses().length,
      totalImprovements: improvements.length,
      verifiedImprovements: verified.length,
      averageEffectiveness:
        scores.length > 0
          ? scores.reduce((a, b) => a + b, 0) / scores.length
          : 0,
    };
  }
}

let instance: LearningCycleManager | null = null;

export function getLearningCycleManager(
  config?: Partial<LearningCycleConfig>
): LearningCycleManager {
  if (!instance) {
    instance = new LearningCycleManager(config);
  }
  return instance;
}
