import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Logger } from '../../src/core/logger.js';

const conversationChatMock = vi.hoisted(() => vi.fn(async () => 'ok'));
const llmMocks = vi.hoisted(() => {
  const mainComplete = vi.fn(async () => ({ content: 'main ok', model: 'main-test' }));
  const trivialComplete = vi.fn(async () => ({
    content: 'HEARTBEAT_OK',
    model: 'trivial-test',
  }));
  return {
    mainClient: {
      complete: mainComplete,
      meta: { provider: 'openai', model: 'main-test', kind: 'primary' },
    },
    trivialClient: {
      complete: trivialComplete,
      meta: { provider: 'local', model: 'trivial-test', kind: 'trivial' },
    },
    mainComplete,
    trivialComplete,
    useTrivial: false,
  };
});

vi.mock('../../src/core/llm.js', () => {
  return {
    createLlmClient: () => llmMocks.mainClient,
    createDecisionClient: () => llmMocks.mainClient,
    createDecisionFallbackClient: () => llmMocks.trivialClient,
    createExecutorClient: () => llmMocks.mainClient,
    createTrivialTaskClient: () => (llmMocks.useTrivial ? llmMocks.trivialClient : null),
    createAgenticExecutorClient: () => llmMocks.mainClient,
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
  beforeEach(() => {
    conversationChatMock.mockReset();
    conversationChatMock.mockResolvedValue('ok');
    llmMocks.mainComplete.mockReset();
    llmMocks.mainComplete.mockResolvedValue({ content: 'main ok', model: 'main-test' });
    llmMocks.trivialComplete.mockReset();
    llmMocks.trivialComplete.mockResolvedValue({
      content: 'HEARTBEAT_OK',
      model: 'trivial-test',
    });
    llmMocks.useTrivial = false;
  });

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

  it('routes heartbeat prompts through the trivial liveness path instead of conversation chat', async () => {
    llmMocks.useTrivial = true;
    llmMocks.trivialComplete.mockResolvedValueOnce({
      content: 'HEARTBEAT_OK',
      model: 'trivial-test',
    });

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

    expect(res).toBe('HEARTBEAT_OK');
    expect(conversationChatMock).not.toHaveBeenCalled();
    expect(llmMocks.trivialComplete).toHaveBeenCalledTimes(1);
    expect(llmMocks.mainComplete).not.toHaveBeenCalled();
    expect(llmMocks.trivialComplete.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'system',
          content: expect.stringContaining('Do not call tools'),
        }),
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining(prompt),
        }),
      ])
    );
    expect(llmMocks.trivialComplete.mock.calls[0]?.[1]).toMatchObject({
      timeoutMs: 30000,
      maxTokens: 96,
    });
  });

  it('falls back to the main LLM when the trivial client is unavailable', async () => {
    llmMocks.useTrivial = false;
    llmMocks.mainComplete.mockResolvedValueOnce({
      content: 'HEARTBEAT_ACTION: operator check required',
      model: 'main-test',
    });

    const { ThufirAgent } = await import('../../src/core/agent.js');
    const agent = new ThufirAgent({
      execution: { mode: 'paper', provider: 'hyperliquid' },
      hyperliquid: { enabled: true },
      wallet: { limits: { daily: 100, perTrade: 25, confirmationThreshold: 10 } },
      autonomy: { enabled: true, fullAuto: false },
      agent: { model: 'test', provider: 'openai' },
      notifications: { heartbeat: { enabled: true, timeoutMs: 4321 } },
    } as any, new Logger('error'));

    const res = await agent.handleHeartbeat('Read HEARTBEAT.md if it exists.');
    expect(res).toBe('HEARTBEAT_ACTION: operator check required');
    expect(llmMocks.mainComplete).toHaveBeenCalledTimes(1);
    expect(llmMocks.mainComplete.mock.calls[0]?.[1]).toMatchObject({ timeoutMs: 4321 });
    expect(conversationChatMock).not.toHaveBeenCalled();
  });

  it('fails closed on heartbeat timeout instead of returning the generic apology string', async () => {
    llmMocks.useTrivial = true;
    llmMocks.trivialComplete.mockRejectedValueOnce(
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
    expect(conversationChatMock).not.toHaveBeenCalled();
  });

  it('throttles repeated heartbeat warnings and degraded notifications', async () => {
    llmMocks.useTrivial = true;
    llmMocks.trivialComplete.mockRejectedValue(
      new Error('LLM request (local/trivial-test) timed out after 30000ms')
    );
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const { ThufirAgent } = await import('../../src/core/agent.js');
    const agent = new ThufirAgent({
      execution: { mode: 'paper', provider: 'hyperliquid' },
      hyperliquid: { enabled: true },
      wallet: { limits: { daily: 100, perTrade: 25, confirmationThreshold: 10 } },
      autonomy: { enabled: true, fullAuto: false },
      agent: { model: 'test', provider: 'openai' },
      notifications: { heartbeat: { enabled: true, degradedMode: 'notify' } },
    } as any, logger as any);

    const first = await agent.handleHeartbeat('Read HEARTBEAT.md if it exists.');
    const second = await agent.handleHeartbeat('Read HEARTBEAT.md if it exists.');

    expect(first).toMatch(/^HEARTBEAT_DEGRADED:/);
    expect(second).toBe('HEARTBEAT_OK');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
    expect(conversationChatMock).not.toHaveBeenCalled();
  });
});
