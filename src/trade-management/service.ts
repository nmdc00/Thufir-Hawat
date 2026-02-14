import type { ThufirConfig } from '../core/config.js';
import type { LlmClient } from '../core/llm.js';
import { Logger } from '../core/logger.js';
import type { MarketClient } from '../execution/market-client.js';
import type { ExecutionAdapter } from '../execution/executor.js';
import { TradeMonitor } from './monitor.js';

export class TradeManagementService {
  private monitor: TradeMonitor | null = null;
  private logger: Logger;

  constructor(
    private params: {
      config: ThufirConfig;
      marketClient: MarketClient;
      executor: ExecutionAdapter;
      llm?: LlmClient;
      logger?: Logger;
    }
  ) {
    this.logger = params.logger ?? new Logger('info');
  }

  start(): void {
    if (this.monitor) return;
    if (this.params.config.tradeManagement?.enabled !== true) {
      this.logger.info('Trade management disabled');
      return;
    }
    this.monitor = new TradeMonitor({
      config: this.params.config,
      marketClient: this.params.marketClient,
      executor: this.params.executor,
      llm: this.params.llm,
      logger: this.logger,
    });
    this.monitor.start();
    this.logger.info('Trade management service started');
  }

  stop(): void {
    if (!this.monitor) return;
    this.monitor.stop();
    this.monitor = null;
    this.logger.info('Trade management service stopped');
  }
}

