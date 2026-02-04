import { getLogger, configureGlobalLogging, LogLevel } from '@auto-claude/core';
import { getOrchestrator } from './orchestrator.js';

const logger = getLogger('main');

async function main(): Promise<void> {
  // ログ設定
  configureGlobalLogging({
    level: LogLevel.INFO,
    logDir: '/home/bacon/AutoClaudeKMP/workspace/logs',
  });

  logger.info('AutoClaudeKMP starting...');

  const orchestrator = getOrchestrator();

  try {
    await orchestrator.start();

    // メインループ（プロセスを維持）
    logger.info('System running. Press Ctrl+C to stop.');

    // 無限ループで待機
    await new Promise<void>(() => {});
  } catch (error) {
    logger.critical('Fatal error', { error });
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Failed to start:', error);
  process.exit(1);
});
