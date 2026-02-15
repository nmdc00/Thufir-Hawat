import { describe, it, expect, vi } from 'vitest';

import { ThufirAgent } from '../../src/core/agent.js';

vi.mock('../../src/core/llm.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../src/core/llm.js');
  const stubClient = {
    complete: async () => ({ content: 'CHAT_OK', model: 'test' }),
  };

  class StubOrchestratorClient {
    // The agent treats this as an LLM client; only .complete is required.
    complete = stubClient.complete;
  }

  return {
    ...actual,
    createLlmClient: () => stubClient,
    createExecutorClient: () => stubClient,
    createTrivialTaskClient: () => null,
    createAgenticExecutorClient: () => stubClient,
    OrchestratorClient: StubOrchestratorClient,
    clearIdentityCache: () => {},
  };
});

vi.mock('../../src/core/autonomous.js', () => ({
  AutonomousManager: class {
    on() {
      return this;
    }
    start() {}
    stop() {}
  },
}));

vi.mock('../../src/trade-management/service.js', () => ({
  TradeManagementService: class {
    start() {}
    stop() {}
  },
}));

vi.mock('../../src/execution/wallet/limits_db.js', () => ({
  DbSpendingLimitEnforcer: class {},
}));

vi.mock('../../src/execution/market-client.js', () => ({
  createMarketClient: () => ({ isAvailable: () => true }),
}));

vi.mock('../../src/core/conversation.js', () => ({
  ConversationHandler: class {
    async chat() {
      return 'CHAT_OK';
    }
  },
}));

describe('access question routing', () => {
  it('does not hijack trade questions with the access report', async () => {
    const agent = new ThufirAgent({
      execution: { mode: 'paper', provider: 'hyperliquid' },
      hyperliquid: { enabled: true },
      wallet: { limits: { daily: 100, perTrade: 25, confirmationThreshold: 10 } },
      autonomy: { enabled: false },
      agent: { model: 'test', provider: 'local' },
    } as any);

    const out = await agent.handleMessage('cli', 'can you trade?');
    expect(out).toBe('CHAT_OK');
    expect(out).not.toContain('Access status (Markets):');
  });

  it('does not hijack tools questions with the access report', async () => {
    const agent = new ThufirAgent({
      execution: { mode: 'paper', provider: 'hyperliquid' },
      hyperliquid: { enabled: true },
      wallet: { limits: { daily: 100, perTrade: 25, confirmationThreshold: 10 } },
      autonomy: { enabled: false },
      agent: { model: 'test', provider: 'local' },
    } as any);

    const out = await agent.handleMessage('cli', 'o, now can you access your tools?');
    expect(out).toBe('CHAT_OK');
    expect(out).not.toContain('Access status (Markets):');
  });

  it('exposes access report via /access', async () => {
    const agent = new ThufirAgent({
      execution: { mode: 'paper', provider: 'hyperliquid' },
      hyperliquid: { enabled: true },
      wallet: { limits: { daily: 100, perTrade: 25, confirmationThreshold: 10 } },
      autonomy: { enabled: false },
      agent: { model: 'test', provider: 'local' },
    } as any);

    const out = await agent.handleMessage('cli', '/access');
    expect(out).toContain('Access status (Markets):');
  });
});
