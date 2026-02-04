import { getLogger, generateId, RiskLevel } from '@auto-claude/core';
import { getClaudeCLI } from '@auto-claude/ai-router';
import { getApprovalGate } from '@auto-claude/notification';
import { getBackupManager } from '@auto-claude/backup';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { RootCause, ProcessImprovement } from './types.js';
import { getRootCauseAnalyzer } from './root-cause-analyzer.js';

const logger = getLogger('self-improve:process');

export interface ProcessImproverConfig {
  workspaceDir: string;
  verificationDelayDays: number;
}

export class ProcessImprover {
  private config: ProcessImproverConfig;
  private improvements: ProcessImprovement[] = [];
  private claudeCLI = getClaudeCLI();
  private approvalGate = getApprovalGate();
  private backupManager = getBackupManager();

  constructor(config: Partial<ProcessImproverConfig> = {}) {
    this.config = {
      workspaceDir: config.workspaceDir ?? '/home/bacon/AutoClaudeKMP/workspace',
      verificationDelayDays: config.verificationDelayDays ?? 7,
    };

    this.ensureDirectories();
    this.loadImprovements();
    logger.info('ProcessImprover initialized');
  }

  private ensureDirectories(): void {
    if (!existsSync(this.config.workspaceDir)) {
      mkdirSync(this.config.workspaceDir, { recursive: true });
    }
  }

  private getImprovementsPath(): string {
    return join(this.config.workspaceDir, 'IMPROVEMENTS.jsonl');
  }

  private loadImprovements(): void {
    const path = this.getImprovementsPath();

    if (existsSync(path)) {
      try {
        const content = readFileSync(path, 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean);
        this.improvements = lines.map((line) => {
          const imp = JSON.parse(line);
          if (imp.appliedAt) imp.appliedAt = new Date(imp.appliedAt);
          if (imp.verifiedAt) imp.verifiedAt = new Date(imp.verifiedAt);
          return imp as ProcessImprovement;
        });
      } catch (error) {
        logger.error('Failed to load improvements', { error });
      }
    }
  }

  private saveImprovement(improvement: ProcessImprovement): void {
    const path = this.getImprovementsPath();
    const line = JSON.stringify(improvement) + '\n';
    appendFileSync(path, line, 'utf-8');
  }

  private updateImprovementsFile(): void {
    const path = this.getImprovementsPath();
    const content = this.improvements.map((i) => JSON.stringify(i)).join('\n') + '\n';
    writeFileSync(path, content, 'utf-8');
  }

  async proposeImprovement(rootCause: RootCause): Promise<ProcessImprovement> {
    const pastImprovements = this.findSimilarImprovements(rootCause);
    const successfulOnes = pastImprovements.filter(
      (i) => i.status === 'verified' && (i.effectivenessScore ?? 0) > 0.7
    );

    const prompt = `以下の根本原因を解決するプロセス改善を提案してください。

## 根本原因
- カテゴリ: ${rootCause.category}
- 説明: ${rootCause.description}
- 確信度: ${rootCause.confidence}
- 根拠: ${rootCause.evidence.join(', ')}

## 過去の成功した改善例
${successfulOnes.map((i) => `- ${i.description}: ${i.implementation}`).join('\n') || 'なし'}

## 回答形式（JSON）
{
  "type": "add" | "modify" | "remove",
  "target": "process" | "code" | "config" | "strategy" | "knowledge",
  "description": "改善の概要",
  "implementation": "具体的な実装内容",
  "expectedOutcome": "期待される効果",
  "verificationMethod": "効果の検証方法"
}

単なる修正ではなく、同じ問題が二度と起きないようにするプロセス改善を考えてください。
JSONのみを返してください。`;

    try {
      const result = await this.claudeCLI.executeTask({
        prompt,
        allowedTools: ['Read', 'Grep'],
        timeout: 2 * 60 * 1000,
      });

      if (!result.success) {
        throw new Error(result.error ?? 'Failed to generate improvement');
      }

      const jsonMatch = result.output.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Failed to parse improvement response');
      }

      const proposal = JSON.parse(jsonMatch[0]);

      const improvement: ProcessImprovement = {
        id: generateId('imp'),
        rootCauseId: rootCause.problemId,
        type: proposal.type,
        target: proposal.target,
        description: proposal.description,
        implementation: proposal.implementation,
        expectedOutcome: proposal.expectedOutcome,
        verificationMethod: proposal.verificationMethod,
        status: 'proposed',
      };

      this.improvements.push(improvement);
      this.saveImprovement(improvement);

      logger.info('Improvement proposed', {
        id: improvement.id,
        description: improvement.description,
      });

      return improvement;
    } catch (error) {
      logger.error('Failed to propose improvement', { error });
      throw error;
    }
  }

  private findSimilarImprovements(rootCause: RootCause): ProcessImprovement[] {
    return this.improvements.filter((i) => {
      const relatedCause = getRootCauseAnalyzer()
        .getRootCauses()
        .find((rc) => rc.problemId === i.rootCauseId);

      return relatedCause?.category === rootCause.category;
    });
  }

  async implementImprovement(improvementId: string): Promise<void> {
    const improvement = this.improvements.find((i) => i.id === improvementId);

    if (!improvement) {
      throw new Error(`Improvement not found: ${improvementId}`);
    }

    if (improvement.status !== 'proposed' && improvement.status !== 'approved') {
      throw new Error(`Improvement cannot be implemented: status=${improvement.status}`);
    }

    // 承認リクエスト
    if (improvement.status === 'proposed') {
      const approved = await this.approvalGate.requestApproval({
        type: 'action',
        title: `プロセス改善: ${improvement.description}`,
        description: improvement.implementation,
        riskLevel: RiskLevel.MEDIUM,
      });

      if (!approved) {
        // 承認待ちに入るので、ここでは終了
        logger.info('Improvement awaiting approval', { id: improvementId });
        return;
      }

      improvement.status = 'approved';
    }

    // バックアップ作成
    await this.backupManager.createRestorePoint(`improvement_${improvement.id}`);

    try {
      // 改善を実装
      await this.applyImprovement(improvement);

      improvement.status = 'implemented';
      improvement.appliedAt = new Date();
      this.updateImprovementsFile();

      logger.info('Improvement implemented', { id: improvementId });
    } catch (error) {
      logger.error('Failed to implement improvement', { error, id: improvementId });
      improvement.status = 'failed';
      this.updateImprovementsFile();
      throw error;
    }
  }

  private async applyImprovement(improvement: ProcessImprovement): Promise<void> {
    switch (improvement.target) {
      case 'process':
        await this.updateProcessDocumentation(improvement);
        break;
      case 'code':
        await this.applyCodeChange(improvement);
        break;
      case 'config':
        await this.updateConfiguration(improvement);
        break;
      case 'strategy':
        await this.updateStrategy(improvement);
        break;
      case 'knowledge':
        await this.updateKnowledgeBase(improvement);
        break;
    }
  }

  private async updateProcessDocumentation(improvement: ProcessImprovement): Promise<void> {
    const processFile = join(this.config.workspaceDir, 'PROCESSES.md');

    let content = '';
    if (existsSync(processFile)) {
      content = readFileSync(processFile, 'utf-8');
    } else {
      content = '# プロセスドキュメント\n\n';
    }

    content += `\n## ${improvement.description}\n\n`;
    content += `追加日: ${new Date().toISOString()}\n\n`;
    content += improvement.implementation + '\n';

    writeFileSync(processFile, content, 'utf-8');
  }

  private async applyCodeChange(improvement: ProcessImprovement): Promise<void> {
    // Claude CLIでコード変更を実行
    const result = await this.claudeCLI.executeTask({
      prompt: `以下の改善を実装してください。必要なコード変更を行ってください。

改善内容: ${improvement.implementation}

期待される効果: ${improvement.expectedOutcome}`,
      allowedTools: ['Read', 'Write', 'Edit', 'Grep', 'Glob'],
      timeout: 5 * 60 * 1000,
    });

    if (!result.success) {
      throw new Error(result.error ?? 'Code change failed');
    }
  }

  private async updateConfiguration(improvement: ProcessImprovement): Promise<void> {
    const configNote = join(this.config.workspaceDir, 'CONFIG_CHANGES.md');

    let content = '';
    if (existsSync(configNote)) {
      content = readFileSync(configNote, 'utf-8');
    }

    content += `\n## ${improvement.description}\n`;
    content += `日時: ${new Date().toISOString()}\n`;
    content += `変更内容: ${improvement.implementation}\n`;

    writeFileSync(configNote, content, 'utf-8');
  }

  private async updateStrategy(improvement: ProcessImprovement): Promise<void> {
    const strategyDir = join(this.config.workspaceDir, 'strategies');

    if (!existsSync(strategyDir)) {
      mkdirSync(strategyDir, { recursive: true });
    }

    const strategyFile = join(strategyDir, `strategy_${Date.now()}.md`);

    const content = `# ${improvement.description}

## 実装
${improvement.implementation}

## 期待される効果
${improvement.expectedOutcome}

## 検証方法
${improvement.verificationMethod}
`;

    writeFileSync(strategyFile, content, 'utf-8');
  }

  private async updateKnowledgeBase(improvement: ProcessImprovement): Promise<void> {
    const knowledgeFile = join(this.config.workspaceDir, 'KNOWLEDGE.md');

    let content = '';
    if (existsSync(knowledgeFile)) {
      content = readFileSync(knowledgeFile, 'utf-8');
    } else {
      content = '# ナレッジベース\n\n';
    }

    content += `\n## ${improvement.description}\n\n`;
    content += improvement.implementation + '\n';

    writeFileSync(knowledgeFile, content, 'utf-8');
  }

  async verifyImprovement(improvementId: string): Promise<number> {
    const improvement = this.improvements.find((i) => i.id === improvementId);

    if (!improvement) {
      throw new Error(`Improvement not found: ${improvementId}`);
    }

    if (improvement.status !== 'implemented') {
      return -1;
    }

    const appliedAt = improvement.appliedAt;
    if (!appliedAt) {
      return -1;
    }

    const daysSince = Math.floor(
      (Date.now() - appliedAt.getTime()) / (1000 * 60 * 60 * 24)
    );

    if (daysSince < this.config.verificationDelayDays) {
      return -1; // まだ検証には早い
    }

    // 同じカテゴリの問題が再発したか確認
    const rcAnalyzer = getRootCauseAnalyzer();
    const relatedCause = rcAnalyzer
      .getRootCauses()
      .find((rc) => rc.problemId === improvement.rootCauseId);

    if (!relatedCause) {
      improvement.effectivenessScore = 1.0;
      improvement.verifiedAt = new Date();
      improvement.status = 'verified';
      this.updateImprovementsFile();
      return 1.0;
    }

    const recentProblems = rcAnalyzer.getRecentProblems(this.config.verificationDelayDays);
    const relatedProblems = recentProblems.filter((p) => {
      const causes = rcAnalyzer
        .getRootCauses()
        .filter((rc) => rc.problemId === p.id);
      return causes.some((c) => c.category === relatedCause.category);
    });

    // 効果スコアを計算
    const effectivenessScore =
      relatedProblems.length === 0
        ? 1.0
        : Math.max(0, 1 - relatedProblems.length * 0.2);

    improvement.effectivenessScore = effectivenessScore;
    improvement.verifiedAt = new Date();
    improvement.status = effectivenessScore > 0.5 ? 'verified' : 'failed';

    this.updateImprovementsFile();

    logger.info('Improvement verified', {
      id: improvementId,
      effectivenessScore,
      status: improvement.status,
    });

    return effectivenessScore;
  }

  getImprovements(): ProcessImprovement[] {
    return [...this.improvements];
  }

  getPendingImprovements(): ProcessImprovement[] {
    return this.improvements.filter(
      (i) => i.status === 'proposed' || i.status === 'approved'
    );
  }

  getImplementedImprovements(): ProcessImprovement[] {
    return this.improvements.filter((i) => i.status === 'implemented');
  }

  getVerifiedImprovements(): ProcessImprovement[] {
    return this.improvements.filter((i) => i.status === 'verified');
  }
}

let instance: ProcessImprover | null = null;

export function getProcessImprover(
  config?: Partial<ProcessImproverConfig>
): ProcessImprover {
  if (!instance) {
    instance = new ProcessImprover(config);
  }
  return instance;
}
