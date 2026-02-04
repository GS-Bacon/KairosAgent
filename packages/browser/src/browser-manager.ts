import { getLogger, sleep } from '@auto-claude/core';

const logger = getLogger('browser');

export interface BrowserConfig {
  headless: boolean;
  timeout: number;
  authStoragePath: string;
}

export interface PageResult {
  success: boolean;
  content?: string;
  screenshot?: Buffer;
  error?: string;
  url?: string;
}

export class BrowserManager {
  private config: BrowserConfig;
  private browser: unknown | null = null;
  private context: unknown | null = null;

  constructor(config: Partial<BrowserConfig> = {}) {
    this.config = {
      headless: config.headless ?? true,
      timeout: config.timeout ?? 30000,
      authStoragePath: config.authStoragePath ?? '/home/bacon/AutoClaudeKMP/auth/browser-state.json',
    };
    logger.info('BrowserManager initialized', { headless: this.config.headless });
  }

  async initialize(): Promise<void> {
    if (this.browser) return;

    try {
      const { chromium } = await import('playwright');

      this.browser = await chromium.launch({
        headless: this.config.headless,
      });

      // 認証状態を読み込む（存在する場合）
      const { existsSync } = await import('fs');
      if (existsSync(this.config.authStoragePath)) {
        this.context = await (this.browser as any).newContext({
          storageState: this.config.authStoragePath,
        });
      } else {
        this.context = await (this.browser as any).newContext();
      }

      logger.info('Browser initialized');
    } catch (error) {
      logger.error('Failed to initialize browser', { error });
      throw error;
    }
  }

  async navigateTo(url: string): Promise<PageResult> {
    await this.initialize();

    try {
      const page = await (this.context as any).newPage();

      await page.goto(url, {
        timeout: this.config.timeout,
        waitUntil: 'domcontentloaded',
      });

      const content = await page.content();
      const finalUrl = page.url();

      await page.close();

      return {
        success: true,
        content,
        url: finalUrl,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Navigation failed', { url, error: errorMessage });

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  async takeScreenshot(url: string): Promise<PageResult> {
    await this.initialize();

    try {
      const page = await (this.context as any).newPage();

      await page.goto(url, {
        timeout: this.config.timeout,
        waitUntil: 'networkidle',
      });

      const screenshot = await page.screenshot({ fullPage: true });

      await page.close();

      return {
        success: true,
        screenshot,
        url,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Screenshot failed', { url, error: errorMessage });

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  async executeScript<T>(url: string, script: string): Promise<T | null> {
    await this.initialize();

    try {
      const page = await (this.context as any).newPage();

      await page.goto(url, {
        timeout: this.config.timeout,
        waitUntil: 'domcontentloaded',
      });

      const result = await page.evaluate(script);

      await page.close();

      return result as T;
    } catch (error) {
      logger.error('Script execution failed', { url, error });
      return null;
    }
  }

  async clickAndWait(
    url: string,
    selector: string,
    waitForSelector?: string
  ): Promise<PageResult> {
    await this.initialize();

    try {
      const page = await (this.context as any).newPage();

      await page.goto(url, {
        timeout: this.config.timeout,
        waitUntil: 'domcontentloaded',
      });

      await page.click(selector);

      if (waitForSelector) {
        await page.waitForSelector(waitForSelector, {
          timeout: this.config.timeout,
        });
      } else {
        await sleep(1000);
      }

      const content = await page.content();
      const finalUrl = page.url();

      await page.close();

      return {
        success: true,
        content,
        url: finalUrl,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Click action failed', { url, selector, error: errorMessage });

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  async saveAuthState(): Promise<void> {
    if (!this.context) return;

    try {
      const { mkdirSync, existsSync } = await import('fs');
      const { dirname } = await import('path');

      const dir = dirname(this.config.authStoragePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      await (this.context as any).storageState({
        path: this.config.authStoragePath,
      });

      logger.info('Auth state saved');
    } catch (error) {
      logger.error('Failed to save auth state', { error });
    }
  }

  async close(): Promise<void> {
    if (this.context) {
      await (this.context as any).close();
      this.context = null;
    }

    if (this.browser) {
      await (this.browser as any).close();
      this.browser = null;
    }

    logger.info('Browser closed');
  }

  isInitialized(): boolean {
    return this.browser !== null;
  }
}

let instance: BrowserManager | null = null;

export function getBrowserManager(config?: Partial<BrowserConfig>): BrowserManager {
  if (!instance) {
    instance = new BrowserManager(config);
  }
  return instance;
}
