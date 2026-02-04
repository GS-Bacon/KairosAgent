import { RiskLevel, getLogger, generateId, sleep } from '@auto-claude/core';
import type { ApprovalRequest } from '@auto-claude/core';
import { getDiscordNotifier } from './discord.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

const logger = getLogger('notification:approval');

export interface ApprovalGateConfig {
  requestDir: string;
  defaultTimeoutMs: number;
  autoApproveRiskLevel: RiskLevel;
}

export interface RequestApprovalOptions {
  type: ApprovalRequest['type'];
  title: string;
  description: string;
  riskLevel: RiskLevel;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
}

export class ApprovalGate {
  private config: ApprovalGateConfig;
  private pendingRequests: Map<string, ApprovalRequest> = new Map();
  private discord = getDiscordNotifier();

  constructor(config: Partial<ApprovalGateConfig> = {}) {
    this.config = {
      requestDir: config.requestDir ?? '/home/bacon/AutoClaudeKMP/workspace/approvals',
      defaultTimeoutMs: config.defaultTimeoutMs ?? 24 * 60 * 60 * 1000,
      autoApproveRiskLevel: config.autoApproveRiskLevel ?? RiskLevel.LOW,
    };

    this.ensureRequestDir();
    this.loadPendingRequests();
    logger.info('ApprovalGate initialized');
  }

  private ensureRequestDir(): void {
    if (!existsSync(this.config.requestDir)) {
      mkdirSync(this.config.requestDir, { recursive: true });
    }
  }

  private loadPendingRequests(): void {
    const indexFile = join(this.config.requestDir, 'pending.json');

    if (existsSync(indexFile)) {
      try {
        const data = JSON.parse(readFileSync(indexFile, 'utf-8'));
        for (const request of data) {
          request.createdAt = new Date(request.createdAt);
          request.expiresAt = new Date(request.expiresAt);
          this.pendingRequests.set(request.id, request);
        }
      } catch (error) {
        logger.error('Failed to load pending requests', { error });
      }
    }
  }

  private savePendingRequests(): void {
    const indexFile = join(this.config.requestDir, 'pending.json');
    const data = Array.from(this.pendingRequests.values());

    try {
      writeFileSync(indexFile, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      logger.error('Failed to save pending requests', { error });
    }
  }

  async requestApproval(options: RequestApprovalOptions): Promise<boolean> {
    // 低リスクは自動承認
    if (options.riskLevel <= this.config.autoApproveRiskLevel) {
      logger.info('Auto-approved low risk action', { title: options.title });
      return true;
    }

    const request: ApprovalRequest = {
      id: generateId('approval'),
      type: options.type,
      title: options.title,
      description: options.description,
      riskLevel: options.riskLevel,
      requiredApprovals: options.riskLevel >= RiskLevel.CRITICAL ? 2 : 1,
      approvals: [],
      rejections: [],
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + (options.timeoutMs ?? this.config.defaultTimeoutMs)),
      status: 'pending',
      metadata: options.metadata,
    };

    this.pendingRequests.set(request.id, request);
    this.savePendingRequests();

    // Discord通知
    await this.discord.send({
      type: options.riskLevel >= RiskLevel.CRITICAL ? 'critical' : 'warning',
      title: `承認リクエスト: ${options.title}`,
      description: options.description,
      fields: [
        { name: 'ID', value: request.id, inline: true },
        { name: 'リスクレベル', value: `Level ${options.riskLevel}`, inline: true },
        { name: 'タイプ', value: options.type, inline: true },
        { name: '有効期限', value: request.expiresAt.toISOString() },
      ],
    });

    logger.info('Approval request created', {
      id: request.id,
      title: options.title,
      riskLevel: options.riskLevel,
    });

    return false;
  }

  async waitForApproval(
    requestId: string,
    checkIntervalMs: number = 5000
  ): Promise<boolean> {
    while (true) {
      const request = this.pendingRequests.get(requestId);

      if (!request) {
        return false;
      }

      if (request.status === 'approved') {
        return true;
      }

      if (request.status === 'rejected') {
        return false;
      }

      if (new Date() >= request.expiresAt) {
        request.status = 'expired';
        this.savePendingRequests();
        return false;
      }

      await sleep(checkIntervalMs);
    }
  }

  approve(requestId: string, approvedBy: string = 'human'): boolean {
    const request = this.pendingRequests.get(requestId);

    if (!request || request.status !== 'pending') {
      return false;
    }

    request.approvals.push(approvedBy);

    if (request.approvals.length >= request.requiredApprovals) {
      request.status = 'approved';
      logger.info('Request approved', { id: requestId, approvedBy });

      this.discord.sendSuccess(`承認: ${request.title}`, `承認者: ${approvedBy}`);
    }

    this.savePendingRequests();
    return true;
  }

  reject(requestId: string, rejectedBy: string = 'human', reason?: string): boolean {
    const request = this.pendingRequests.get(requestId);

    if (!request || request.status !== 'pending') {
      return false;
    }

    request.rejections.push(rejectedBy);
    request.status = 'rejected';

    logger.info('Request rejected', { id: requestId, rejectedBy, reason });

    this.discord.sendError(
      `拒否: ${request.title}`,
      reason ?? `拒否者: ${rejectedBy}`
    );

    this.savePendingRequests();
    return true;
  }

  getPendingRequests(): ApprovalRequest[] {
    const now = new Date();
    const pending: ApprovalRequest[] = [];

    for (const request of this.pendingRequests.values()) {
      if (request.status === 'pending' && request.expiresAt > now) {
        pending.push(request);
      }
    }

    return pending;
  }

  getRequest(requestId: string): ApprovalRequest | undefined {
    return this.pendingRequests.get(requestId);
  }

  cleanupExpired(): number {
    const now = new Date();
    let cleaned = 0;

    for (const [id, request] of this.pendingRequests.entries()) {
      if (request.status === 'pending' && request.expiresAt <= now) {
        request.status = 'expired';
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.savePendingRequests();
      logger.info('Cleaned up expired requests', { count: cleaned });
    }

    return cleaned;
  }
}

let instance: ApprovalGate | null = null;

export function getApprovalGate(config?: Partial<ApprovalGateConfig>): ApprovalGate {
  if (!instance) {
    instance = new ApprovalGate(config);
  }
  return instance;
}
