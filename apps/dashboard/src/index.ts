import { getLogger, configureGlobalLogging, LogLevel } from '@auto-claude/core';
import { DashboardServer } from './server.js';

const logger = getLogger('dashboard');

async function main(): Promise<void> {
  configureGlobalLogging({
    level: LogLevel.INFO,
  });

  logger.info('Starting dashboard server...');

  const port = parseInt(process.env.DASHBOARD_PORT ?? '3000', 10);
  const host = process.env.DASHBOARD_HOST ?? '0.0.0.0';

  const server = new DashboardServer({ port, host });
  server.start();

  logger.info(`Dashboard available at http://${host}:${port}`);
  logger.info('Also accessible via Tailscale if configured');
}

main().catch((error) => {
  console.error('Failed to start dashboard:', error);
  process.exit(1);
});
