import { RiskLevel, getLogger } from '@auto-claude/core';

const logger = getLogger('safety:boundary-guard');

export interface BoundaryViolation {
  type: BoundaryViolationType;
  description: string;
  severity: RiskLevel;
  blocked: boolean;
  timestamp: Date;
}

export enum BoundaryViolationType {
  VM_ESCAPE = 'vm_escape',
  SELF_REPLICATION = 'self_replication',
  PRIVILEGE_ESCALATION = 'privilege_escalation',
  UNAUTHORIZED_NETWORK = 'unauthorized_network',
  FILE_SYSTEM_ESCAPE = 'file_system_escape',
  PROCESS_MANIPULATION = 'process_manipulation',
}

export interface BoundaryConfig {
  allowedPaths: string[];
  blockedCommands: string[];
  allowedNetworkHosts: string[];
  maxFileSize: number;
}

export class BoundaryGuard {
  private config: BoundaryConfig;
  private violations: BoundaryViolation[] = [];

  constructor(config: Partial<BoundaryConfig> = {}) {
    this.config = {
      allowedPaths: config.allowedPaths ?? [
        '/home/bacon/AutoClaudeKMP',
        '/tmp',
      ],
      blockedCommands: config.blockedCommands ?? [
        'rm -rf /',
        'sudo',
        'su ',
        'chmod 777',
        'chown',
        'dd if=',
        'mkfs',
        'fdisk',
        ':(){:|:&};:',
        'curl | sh',
        'wget | sh',
        'nc -e',
        'ncat -e',
      ],
      allowedNetworkHosts: config.allowedNetworkHosts ?? [
        'api.anthropic.com',
        'discord.com',
        'github.com',
        'api.github.com',
      ],
      maxFileSize: config.maxFileSize ?? 100 * 1024 * 1024,
    };
    logger.info('BoundaryGuard initialized');
  }

  checkPath(path: string): BoundaryViolation | null {
    const isAllowed = this.config.allowedPaths.some(
      (allowedPath) => path.startsWith(allowedPath)
    );

    if (!isAllowed) {
      const violation: BoundaryViolation = {
        type: BoundaryViolationType.FILE_SYSTEM_ESCAPE,
        description: `Attempted access to unauthorized path: ${path}`,
        severity: RiskLevel.CRITICAL,
        blocked: true,
        timestamp: new Date(),
      };
      this.recordViolation(violation);
      return violation;
    }

    return null;
  }

  checkCommand(command: string): BoundaryViolation | null {
    const normalizedCommand = command.toLowerCase();

    for (const blocked of this.config.blockedCommands) {
      if (normalizedCommand.includes(blocked.toLowerCase())) {
        const violation: BoundaryViolation = {
          type: BoundaryViolationType.PRIVILEGE_ESCALATION,
          description: `Blocked command detected: ${command}`,
          severity: RiskLevel.CRITICAL,
          blocked: true,
          timestamp: new Date(),
        };
        this.recordViolation(violation);
        return violation;
      }
    }

    // 自己複製チェック
    if (this.detectSelfReplication(command)) {
      const violation: BoundaryViolation = {
        type: BoundaryViolationType.SELF_REPLICATION,
        description: `Self-replication attempt detected: ${command}`,
        severity: RiskLevel.CRITICAL,
        blocked: true,
        timestamp: new Date(),
      };
      this.recordViolation(violation);
      return violation;
    }

    return null;
  }

  checkNetworkAccess(host: string): BoundaryViolation | null {
    const isAllowed = this.config.allowedNetworkHosts.some(
      (allowed) => host.includes(allowed)
    );

    if (!isAllowed) {
      const violation: BoundaryViolation = {
        type: BoundaryViolationType.UNAUTHORIZED_NETWORK,
        description: `Network access to unauthorized host: ${host}`,
        severity: RiskLevel.HIGH,
        blocked: false,
        timestamp: new Date(),
      };
      this.recordViolation(violation);
      return violation;
    }

    return null;
  }

  private detectSelfReplication(command: string): boolean {
    const replicationPatterns = [
      /fork\s*\(/,
      /clone\s*\(/,
      /spawn.*AutoClaude/i,
      /cp.*orchestrator/i,
      /scp.*AutoClaude/i,
      /rsync.*AutoClaude/i,
    ];

    return replicationPatterns.some((pattern) => pattern.test(command));
  }

  private recordViolation(violation: BoundaryViolation): void {
    this.violations.push(violation);
    logger.critical('Boundary violation detected', violation);
  }

  getViolations(): BoundaryViolation[] {
    return [...this.violations];
  }

  getRecentViolations(hours: number = 24): BoundaryViolation[] {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    return this.violations.filter((v) => v.timestamp >= cutoff);
  }

  clearViolations(): void {
    this.violations = [];
  }

  addAllowedPath(path: string): void {
    if (!this.config.allowedPaths.includes(path)) {
      this.config.allowedPaths.push(path);
      logger.info('Added allowed path', { path });
    }
  }

  addAllowedHost(host: string): void {
    if (!this.config.allowedNetworkHosts.includes(host)) {
      this.config.allowedNetworkHosts.push(host);
      logger.info('Added allowed host', { host });
    }
  }
}

let instance: BoundaryGuard | null = null;

export function getBoundaryGuard(config?: Partial<BoundaryConfig>): BoundaryGuard {
  if (!instance) {
    instance = new BoundaryGuard(config);
  }
  return instance;
}
