/**
 * 実験マネージャー
 *
 * 実験的取り組みのライフサイクル管理を担当
 */

import {
  getLogger,
  Experiment,
  ExperimentPhase,
  ExperimentMilestone,
  ExperimentResults,
} from '@auto-claude/core';
import { getDiscordNotifier, getApprovalGate } from '@auto-claude/notification';
import * as fs from 'fs';
import * as path from 'path';

const logger = getLogger('ExperimentManager');

const WORKSPACE_PATH = '/home/bacon/AutoClaudeKMP/workspace';
const SANDBOX_PATH = '/home/bacon/AutoClaudeKMP/sandbox/experiments';

export interface ExperimentConfig {
  maxConcurrentExperiments: number;
  maxResourceAllocation: number; // percentage
  autoArchiveAfterDays: number;
}

const DEFAULT_CONFIG: ExperimentConfig = {
  maxConcurrentExperiments: 3,
  maxResourceAllocation: 30, // 30%
  autoArchiveAfterDays: 90,
};

export interface ExperimentIdea {
  title: string;
  description: string;
  category: Experiment['category'];
  hypothesis: string;
  potentialBenefit: string;
  estimatedEffort: 'low' | 'medium' | 'high';
  priority: 'low' | 'medium' | 'high';
}

export interface ExperimentSummary {
  total: number;
  byPhase: Record<ExperimentPhase, number>;
  byCategory: Record<string, number>;
  totalResourceAllocation: number;
  recentlyCompleted: Experiment[];
}

// 実験アイデア候補リスト
const EXPERIMENT_IDEAS: ExperimentIdea[] = [
  // すぐ始められる実験
  {
    title: 'ローカルLLM活用（Ollama + Llama）',
    description: 'ローカルLLMをサブタスク実行に活用して、コスト削減とプライバシー向上',
    category: 'technology',
    hypothesis: 'サブタスクをローカルLLMで処理することで、APIコストを30%削減できる',
    potentialBenefit: 'コスト削減、レスポンス改善、プライバシー強化',
    estimatedEffort: 'medium',
    priority: 'high',
  },
  {
    title: 'Godotでシンプルなゲーム作成',
    description: 'ミニゲームを作成し、itch.ioで販売',
    category: 'monetization',
    hypothesis: 'シンプルなゲームでも月1000円程度の収益が見込める',
    potentialBenefit: '新規収益源、スキル習得',
    estimatedEffort: 'high',
    priority: 'medium',
  },
  {
    title: 'AIプロンプト集のGumroad販売',
    description: '効果的なプロンプトをまとめて販売',
    category: 'monetization',
    hypothesis: '専門的なプロンプト集は需要がある',
    potentialBenefit: '低労力での収益化',
    estimatedEffort: 'low',
    priority: 'high',
  },
  {
    title: '技術系YouTubeショート動画',
    description: '技術TIPSを短い動画で発信',
    category: 'monetization',
    hypothesis: 'ショート動画で技術層にリーチできる',
    potentialBenefit: '認知度向上、広告収入',
    estimatedEffort: 'medium',
    priority: 'low',
  },

  // 検討中の実験
  {
    title: 'Discord Botの有料販売',
    description: '便利なDiscord Botを開発して販売',
    category: 'monetization',
    hypothesis: 'ニッチな機能のBotには購入需要がある',
    potentialBenefit: '継続収益',
    estimatedEffort: 'medium',
    priority: 'medium',
  },
  {
    title: 'Notion/Obsidianテンプレート販売',
    description: '生産性向上テンプレートを販売',
    category: 'monetization',
    hypothesis: 'テンプレート市場は成長している',
    potentialBenefit: '低労力での継続収益',
    estimatedEffort: 'low',
    priority: 'medium',
  },

  // 技術実験
  {
    title: 'マルチエージェント構成の検証',
    description: '複数のAIエージェントを協調させる構成をテスト',
    category: 'technology',
    hypothesis: 'マルチエージェントで複雑なタスクを効率的に処理できる',
    potentialBenefit: '処理能力向上、品質改善',
    estimatedEffort: 'high',
    priority: 'medium',
  },
];

export class ExperimentManager {
  private readonly discord = getDiscordNotifier();
  private readonly approvalGate = getApprovalGate();
  private readonly config: ExperimentConfig;
  private readonly experiments: Map<string, Experiment> = new Map();
  private readonly ideas: ExperimentIdea[] = [...EXPERIMENT_IDEAS];

  constructor(config: Partial<ExperimentConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.loadExperiments();
  }

  /**
   * 新しい実験を作成
   */
  async createExperiment(
    idea: ExperimentIdea,
    resourceAllocation: number = 10
  ): Promise<Experiment> {
    // リソース制限チェック
    const currentAllocation = this.getTotalResourceAllocation();
    if (currentAllocation + resourceAllocation > this.config.maxResourceAllocation) {
      throw new Error(
        `リソース制限超過: 現在${currentAllocation}%、追加${resourceAllocation}%で上限${this.config.maxResourceAllocation}%を超過`
      );
    }

    // 同時実験数チェック
    const activeCount = this.getActiveExperiments().length;
    if (activeCount >= this.config.maxConcurrentExperiments) {
      throw new Error(
        `同時実験数上限: 現在${activeCount}件で上限${this.config.maxConcurrentExperiments}件に達しています`
      );
    }

    const experiment: Experiment = {
      id: `exp-${Date.now()}`,
      title: idea.title,
      description: idea.description,
      category: idea.category,
      phase: 'idea',
      hypothesis: idea.hypothesis,
      successCriteria: [],
      resourceAllocation,
      startedAt: new Date(),
      milestones: [],
      sandboxPath: path.join(SANDBOX_PATH, `exp-${Date.now()}`),
    };

    this.experiments.set(experiment.id, experiment);
    await this.saveExperiment(experiment);

    logger.info('Experiment created', {
      id: experiment.id,
      title: experiment.title,
    });

    return experiment;
  }

  /**
   * 実験のフェーズを進める
   */
  async advancePhase(experimentId: string): Promise<Experiment> {
    const experiment = this.experiments.get(experimentId);
    if (!experiment) {
      throw new Error(`Experiment not found: ${experimentId}`);
    }

    const phaseOrder: ExperimentPhase[] = [
      'idea',
      'planning',
      'sandbox',
      'trial',
      'evaluate',
      'adopted',
    ];

    const currentIndex = phaseOrder.indexOf(experiment.phase);
    if (currentIndex === -1 || currentIndex >= phaseOrder.length - 1) {
      throw new Error(`Cannot advance from phase: ${experiment.phase}`);
    }

    const nextPhase = phaseOrder[currentIndex + 1];

    // フェーズ別の処理
    switch (nextPhase) {
      case 'planning':
        // 計画フェーズへの移行
        experiment.successCriteria = await this.generateSuccessCriteria(experiment);
        experiment.milestones = await this.generateMilestones(experiment);
        break;

      case 'sandbox':
        // サンドボックス環境を準備
        await this.prepareSandbox(experiment);
        break;

      case 'trial':
        // 承認を求める
        const approved = await this.approvalGate.requestApproval({
          type: 'action',
          title: `実験「${experiment.title}」を本番試行へ移行`,
          description: `仮説: ${experiment.hypothesis}\n成功基準: ${experiment.successCriteria.join(', ')}`,
          riskLevel: 2,
        });

        if (!approved) {
          logger.info('Trial phase awaiting approval', { experimentId });
          return experiment;
        }
        break;

      case 'evaluate':
        // 結果を評価
        break;

      case 'adopted':
        // 本採用処理
        await this.adoptExperiment(experiment);
        break;
    }

    experiment.phase = nextPhase;
    await this.saveExperiment(experiment);

    logger.info('Experiment phase advanced', {
      id: experimentId,
      newPhase: nextPhase,
    });

    await this.discord.sendInfo(
      `実験フェーズ更新: ${experiment.title}`,
      `新しいフェーズ: ${nextPhase}`,
      'experiment_phase_update'
    );

    return experiment;
  }

  /**
   * 実験を中止
   */
  async abandonExperiment(
    experimentId: string,
    reason: string
  ): Promise<Experiment> {
    const experiment = this.experiments.get(experimentId);
    if (!experiment) {
      throw new Error(`Experiment not found: ${experimentId}`);
    }

    experiment.phase = 'abandoned';
    experiment.results = {
      outcome: 'failure',
      summary: `中止理由: ${reason}`,
      metrics: {},
      learnings: [reason],
    };

    await this.saveExperiment(experiment);

    logger.info('Experiment abandoned', {
      id: experimentId,
      reason,
    });

    await this.discord.sendWarning(
      `実験中止: ${experiment.title}`,
      reason,
      'experiment_aborted'
    );

    return experiment;
  }

  /**
   * 実験結果を記録
   */
  async recordResults(
    experimentId: string,
    results: ExperimentResults
  ): Promise<Experiment> {
    const experiment = this.experiments.get(experimentId);
    if (!experiment) {
      throw new Error(`Experiment not found: ${experimentId}`);
    }

    experiment.results = results;

    if (results.outcome === 'success') {
      experiment.phase = 'adopted';
    } else if (results.outcome === 'failure') {
      experiment.phase = 'abandoned';
    }

    await this.saveExperiment(experiment);

    logger.info('Experiment results recorded', {
      id: experimentId,
      outcome: results.outcome,
    });

    return experiment;
  }

  /**
   * マイルストーンを更新
   */
  async updateMilestone(
    experimentId: string,
    milestoneId: string,
    status: ExperimentMilestone['status'],
    notes?: string
  ): Promise<void> {
    const experiment = this.experiments.get(experimentId);
    if (!experiment) {
      throw new Error(`Experiment not found: ${experimentId}`);
    }

    const milestone = experiment.milestones.find(m => m.id === milestoneId);
    if (!milestone) {
      throw new Error(`Milestone not found: ${milestoneId}`);
    }

    milestone.status = status;
    if (status === 'completed') {
      milestone.completedAt = new Date();
    }
    if (notes) {
      milestone.notes = notes;
    }

    await this.saveExperiment(experiment);
  }

  /**
   * 実験アイデアをブレインストーミング
   */
  async brainstormIdeas(): Promise<ExperimentIdea[]> {
    logger.info('Brainstorming experiment ideas');

    // 新しいアイデアを生成（将来的にはAIで生成）
    const newIdeas: ExperimentIdea[] = [];

    // 既存のアイデアから未実験のものを優先順位付け
    const activeExperimentTitles = new Set(
      this.getActiveExperiments().map(e => e.title)
    );

    const availableIdeas = this.ideas.filter(
      idea => !activeExperimentTitles.has(idea.title)
    );

    // 優先度でソート
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    const sorted = availableIdeas.sort(
      (a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]
    );

    return sorted.slice(0, 5);
  }

  /**
   * 実験の日次チェック
   */
  async dailyCheck(): Promise<{
    active: number;
    needsAttention: string[];
    overdue: string[];
  }> {
    const needsAttention: string[] = [];
    const overdue: string[] = [];
    const now = new Date();

    for (const experiment of this.experiments.values()) {
      if (experiment.phase === 'adopted' || experiment.phase === 'abandoned') {
        continue;
      }

      // 期限切れマイルストーンをチェック
      for (const milestone of experiment.milestones) {
        if (
          milestone.status !== 'completed' &&
          new Date(milestone.targetDate) < now
        ) {
          overdue.push(`${experiment.title}: ${milestone.title}`);
        }
      }

      // 長期間進捗がない実験
      const daysSinceStart = Math.floor(
        (now.getTime() - experiment.startedAt.getTime()) / (1000 * 60 * 60 * 24)
      );

      if (experiment.phase === 'idea' && daysSinceStart > 7) {
        needsAttention.push(`${experiment.title}: アイデア段階で7日以上経過`);
      }
    }

    return {
      active: this.getActiveExperiments().length,
      needsAttention,
      overdue,
    };
  }

  // Helper methods

  private async generateSuccessCriteria(experiment: Experiment): Promise<string[]> {
    // 基本的な成功基準
    const criteria: string[] = [
      '仮説が検証される',
      '重大な問題が発生しない',
    ];

    if (experiment.category === 'monetization') {
      criteria.push('収益が発生する');
    }

    if (experiment.category === 'technology') {
      criteria.push('技術的な改善が測定される');
    }

    return criteria;
  }

  private async generateMilestones(experiment: Experiment): Promise<ExperimentMilestone[]> {
    const milestones: ExperimentMilestone[] = [];
    const now = new Date();

    // 基本的なマイルストーン
    milestones.push({
      id: `${experiment.id}-m1`,
      title: '初期セットアップ完了',
      targetDate: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000), // 1週間後
      status: 'pending',
    });

    milestones.push({
      id: `${experiment.id}-m2`,
      title: '中間レビュー',
      targetDate: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000), // 2週間後
      status: 'pending',
    });

    milestones.push({
      id: `${experiment.id}-m3`,
      title: '結果評価',
      targetDate: new Date(now.getTime() + 28 * 24 * 60 * 60 * 1000), // 4週間後
      status: 'pending',
    });

    return milestones;
  }

  private async prepareSandbox(experiment: Experiment): Promise<void> {
    if (experiment.sandboxPath) {
      await fs.promises.mkdir(experiment.sandboxPath, { recursive: true });
      logger.info('Sandbox prepared', { path: experiment.sandboxPath });
    }
  }

  private async adoptExperiment(experiment: Experiment): Promise<void> {
    // 本採用時の処理
    await this.discord.sendSuccess(
      `実験成功: ${experiment.title}`,
      `仮説: ${experiment.hypothesis}\n結果: ${experiment.results?.summary ?? '成功'}`,
      'experiment_success'
    );
  }

  private getTotalResourceAllocation(): number {
    let total = 0;
    for (const experiment of this.experiments.values()) {
      if (
        experiment.phase !== 'adopted' &&
        experiment.phase !== 'abandoned'
      ) {
        total += experiment.resourceAllocation;
      }
    }
    return total;
  }

  getActiveExperiments(): Experiment[] {
    return Array.from(this.experiments.values()).filter(
      e => e.phase !== 'adopted' && e.phase !== 'abandoned'
    );
  }

  getExperiment(id: string): Experiment | undefined {
    return this.experiments.get(id);
  }

  getAllExperiments(): Experiment[] {
    return Array.from(this.experiments.values());
  }

  getSummary(): ExperimentSummary {
    const experiments = Array.from(this.experiments.values());

    const byPhase: Record<ExperimentPhase, number> = {
      idea: 0,
      planning: 0,
      sandbox: 0,
      trial: 0,
      evaluate: 0,
      adopted: 0,
      abandoned: 0,
    };

    const byCategory: Record<string, number> = {};

    for (const exp of experiments) {
      byPhase[exp.phase]++;
      byCategory[exp.category] = (byCategory[exp.category] ?? 0) + 1;
    }

    const recentlyCompleted = experiments
      .filter(e => e.phase === 'adopted' || e.phase === 'abandoned')
      .filter(e => e.results)
      .slice(-5);

    return {
      total: experiments.length,
      byPhase,
      byCategory,
      totalResourceAllocation: this.getTotalResourceAllocation(),
      recentlyCompleted,
    };
  }

  private async loadExperiments(): Promise<void> {
    const dir = path.join(WORKSPACE_PATH, 'experiments');
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      const files = await fs.promises.readdir(dir);

      for (const file of files) {
        if (file.endsWith('.json')) {
          try {
            const content = await fs.promises.readFile(
              path.join(dir, file),
              'utf-8'
            );
            const experiment = JSON.parse(content) as Experiment;
            experiment.startedAt = new Date(experiment.startedAt);
            this.experiments.set(experiment.id, experiment);
          } catch {
            // 無視
          }
        }
      }

      logger.info('Experiments loaded', { count: this.experiments.size });
    } catch {
      // ディレクトリがない場合は無視
    }
  }

  private async saveExperiment(experiment: Experiment): Promise<void> {
    const dir = path.join(WORKSPACE_PATH, 'experiments');
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(
      path.join(dir, `${experiment.id}.json`),
      JSON.stringify(experiment, null, 2)
    );
  }
}

// シングルトンインスタンス
let managerInstance: ExperimentManager | null = null;

export function getExperimentManager(
  config?: Partial<ExperimentConfig>
): ExperimentManager {
  if (!managerInstance) {
    managerInstance = new ExperimentManager(config);
  }
  return managerInstance;
}
