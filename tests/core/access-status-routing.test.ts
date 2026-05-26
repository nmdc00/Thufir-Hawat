import { describe, it, expect, vi } from 'vitest';

import { Logger } from '../../src/core/logger.js';

const conversationChatMock = vi.hoisted(() => vi.fn(async () => 'ok'));

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

vi.mock('../../src/core/conversation.js', () => ({
  ConversationHandler: class {
    constructor() {}
    async chat(sender: string, message: string, onProgress?: unknown, options?: unknown) {
      return conversationChatMock(sender, message, onProgress, options);
    }
  },
}));

vi.mock('../../src/execution/wallet/limits_db.js', () => ({
  DbSpendingLimitEnforcer: class {},
}));

describe('access status routing', () => {
  it('does not return access status for natural-language tool-access questions', async () => {
    const { ThufirAgent } = await import('../../src/core/agent.js');
    const agent = new ThufirAgent({
      execution: { mode: 'live', provider: 'hyperliquid' },
      hyperliquid: { enabled: true },
      wallet: { limits: { daily: 100, perTrade: 25, confirmationThreshold: 10 } },
      autonomy: { enabled: false },
      agent: { model: 'test', provider: 'local' },
    } as any, new Logger('error'));

    const res = await agent.handleMessage('u', 'How is the tool access?');
    expect(res).not.toMatch(/Access status/i);
  }, 20000);

  it('returns access status only for explicit /access_status command', async () => {
    const { ThufirAgent } = await import('../../src/core/agent.js');
    const agent = new ThufirAgent({
      execution: { mode: 'live', provider: 'hyperliquid' },
      hyperliquid: { enabled: true },
      wallet: { limits: { daily: 100, perTrade: 25, confirmationThreshold: 10 } },
      autonomy: { enabled: false },
      agent: { model: 'test', provider: 'local' },
    } as any, new Logger('error'));

    const res = await agent.handleMessage('u', '/access_status');
    expect(res).toMatch(/Access status/i);
  });

  it('routes heartbeat prompts through heartbeat mode instead of generic chat defaults', async () => {
    conversationChatMock.mockReset();
    conversationChatMock.mockResolvedValue('ok');

    const { ThufirAgent } = await import('../../src/core/agent.js');
    const agent = new ThufirAgent({
      execution: { mode: 'paper', provider: 'hyperliquid' },
      hyperliquid: { enabled: true },
      wallet: { limits: { daily: 100, perTrade: 25, confirmationThreshold: 10 } },
      autonomy: { enabled: true, fullAuto: false },
      agent: { model: 'test', provider: 'local' },
    } as any, new Logger('error'));

    const prompt = 'If you execute any action, monitor open position risk.';
    const res = await agent.handleMessage('__heartbeat__', prompt);

    expect(res).toBe('ok');
    expect(conversationChatMock).toHaveBeenCalledWith(
      '__heartbeat__',
      prompt,
      undefined,
      expect.objectContaining({
        mode: 'heartbeat',
        timeoutMs: 10000,
        storeHistory: false,
      })
    );
  });

  it('fails closed on heartbeat timeout instead of returning the generic apology string', async () => {
    conversationChatMock.mockReset();
    conversationChatMock.mockRejectedValueOnce(
      new Error('LLM request (openai/gpt-5.4) timed out after 120000ms')
    );

    const { ThufirAgent } = await import('../../src/core/agent.js');
    const agent = new ThufirAgent({
      execution: { mode: 'paper', provider: 'hyperliquid' },
      hyperliquid: { enabled: true },
      wallet: { limits: { daily: 100, perTrade: 25, confirmationThreshold: 10 } },
      autonomy: { enabled: true, fullAuto: false },
      agent: { model: 'test', provider: 'openai' },
      notifications: { heartbeat: { enabled: true, degradedMode: 'ok' } },
    } as any, new Logger('error'));

    const res = await agent.handleMessage('__heartbeat__', 'Read HEARTBEAT.md if it exists.');
    expect(res).toBe('HEARTBEAT_OK');
    expect(res).not.toContain('Sorry, I encountered an error');
  });
});
