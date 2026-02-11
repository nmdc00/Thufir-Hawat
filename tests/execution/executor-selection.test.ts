import { describe, it, expect, vi } from 'vitest';

import { ThufirAgent } from '../../src/core/agent.js';

vi.mock('../../src/core/llm.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/core/llm.js'
  );
  const stubClient = {
    complete: async () => ({ content: 'ok', model: 'test' }),
  };
  return {
    ...actual,
    createLlmClient: () => stubClient,
    createExecutorClient: () => stubClient,
    createTrivialTaskClient: () => null,
    createAgenticExecutorClient: () => stubClient,
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

vi.mock('../../src/execution/wallet/limits_db.js', () => ({
  DbSpendingLimitEnforcer: class {},
}));

describe('executor selection', () => {
  it('selects hyperliquid live executor when provider is hyperliquid', () => {
    const agent = new ThufirAgent({
      execution: { mode: 'live', provider: 'hyperliquid' },
      hyperliquid: { enabled: true },
      wallet: { limits: { daily: 100, perTrade: 25, confirmationThreshold: 10 } },
      autonomy: { enabled: false },
      agent: { model: 'test', provider: 'local' },
    } as any);
    expect((agent as any).executor?.constructor?.name).toContain('HyperliquidLiveExecutor');
  });

  it('falls back to paper executor when not live', () => {
    const agent = new ThufirAgent({
      execution: { mode: 'paper', provider: 'hyperliquid' },
      hyperliquid: { enabled: true },
      wallet: { limits: { daily: 100, perTrade: 25, confirmationThreshold: 10 } },
      autonomy: { enabled: false },
      agent: { model: 'test', provider: 'local' },
    } as any);
    expect((agent as any).executor?.constructor?.name).toContain('PaperExecutor');
  });
});
