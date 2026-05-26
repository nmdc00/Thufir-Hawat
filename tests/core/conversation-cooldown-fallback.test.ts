import { describe, expect, it, vi } from 'vitest';

const runOrchestratorMock = vi.fn(async () => ({
  response: '',
  state: {
    plan: null,
    toolExecutions: [],
    criticResult: null,
    mode: 'trade',
  },
  summary: { fragility: null },
}));
const appendEntryMock = vi.hoisted(() => vi.fn());
const compactIfNeededMock = vi.hoisted(() => vi.fn(async () => undefined));
const buildContextMessagesMock = vi.hoisted(() => vi.fn(() => []));
const storeChatMessageMock = vi.hoisted(() => vi.fn(() => 'm1'));
const chatVectorAddMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../../src/intel/vectorstore.js', () => ({
  IntelVectorStore: class {
    async query() {
      return [];
    }
  },
}));

vi.mock('../../src/intel/store.js', () => ({
  listIntelByIds: () => [],
  listRecentIntel: () => [],
}));

vi.mock('../../src/memory/db.js', () => ({
  openDatabase: () => ({
    prepare: () => ({ get: () => undefined, all: () => [], run: () => ({}) }),
    exec: () => undefined,
    pragma: () => undefined,
  }),
}));

vi.mock('../../src/memory/user.js', () => ({
  getUserContext: () => ({ preferences: { intelAlertsConfigured: true } }),
  updateUserContext: () => undefined,
}));

vi.mock('../../src/memory/session_store.js', () => ({
  SessionStore: class {
    getSummary() {
      return null;
    }
    async compactIfNeeded(...args: unknown[]) {
      return compactIfNeededMock(...args);
    }
    buildContextMessages(...args: unknown[]) {
      return buildContextMessagesMock(...args);
    }
    appendEntry(...args: unknown[]) {
      return appendEntryMock(...args);
    }
    getSessionId() {
      return 's1';
    }
    clearSession() {}
    getPlan() {
      return null;
    }
    setPlan() {}
    clearPlan() {}
  },
}));

vi.mock('../../src/memory/chat.js', () => ({
  storeChatMessage: (...args: unknown[]) => storeChatMessageMock(...args),
  listChatMessagesByIds: () => [],
  clearChatMessages: () => undefined,
  pruneChatMessages: () => 0,
}));

vi.mock('../../src/memory/chat_vectorstore.js', () => ({
  ChatVectorStore: class {
    async add(...args: unknown[]) {
      return chatVectorAddMock(...args);
    }
    async query() {
      return [];
    }
  },
}));

vi.mock('../../src/agent/orchestrator/orchestrator.js', () => ({
  runOrchestrator: runOrchestratorMock,
}));

vi.mock('../../src/core/tool-executor.js', () => ({
  executeToolCall: async (name: string) => {
    if (name === 'get_portfolio') {
      return { success: true, data: { summary: { available_balance: 1.2345 } } };
    }
    if (name === 'get_positions') {
      return { success: true, data: { positions: [{ symbol: 'BTC' }] } };
    }
    if (name === 'get_open_orders') {
      return { success: true, data: { orders: [] } };
    }
    return { success: true, data: {} };
  },
}));

describe('ConversationHandler cooldown fallback', () => {
  it('returns deterministic non-empty response when orchestrator synthesis is empty', async () => {
    runOrchestratorMock.mockClear();
    runOrchestratorMock.mockResolvedValue({
      response: '',
      state: {
        plan: null,
        toolExecutions: [],
        criticResult: null,
        mode: 'trade',
      },
      summary: { fragility: null },
    });
    const { ConversationHandler } = await import('../../src/core/conversation.js');
    const llm = { complete: vi.fn(async () => ({ content: 'ok', model: 'test' })) } as any;
    const marketClient = { searchMarkets: vi.fn(async () => []) } as any;
    const config = {
      execution: { mode: 'live', provider: 'hyperliquid' },
      agent: { useOrchestrator: true },
      autonomy: { fullAuto: true },
    } as any;

    const handler = new ConversationHandler(llm, marketClient, config);
    const reply = await handler.chat('user', 'Can you monitor the position?');

    expect(reply).toContain('Monitoring is still active');
    expect(reply).toContain('perp position');
    expect(reply.trim().length).toBeGreaterThan(0);
  });

  it('uses autonomous execution origin for heartbeat and chat origin for normal messages', async () => {
    runOrchestratorMock.mockClear();
    runOrchestratorMock.mockResolvedValue({
      response: 'ok',
      state: {
        plan: null,
        toolExecutions: [],
        criticResult: null,
        mode: 'trade',
      },
      summary: { fragility: null },
    });

    const { ConversationHandler } = await import('../../src/core/conversation.js');
    const llm = { complete: vi.fn(async () => ({ content: 'ok', model: 'test' })) } as any;
    const marketClient = { searchMarkets: vi.fn(async () => []) } as any;
    const config = {
      execution: { mode: 'live', provider: 'hyperliquid' },
      agent: { useOrchestrator: true },
      autonomy: { fullAuto: true },
    } as any;

    const handler = new ConversationHandler(llm, marketClient, config);
    await handler.chat('__heartbeat__', 'Read heartbeat');
    await handler.chat('user', 'Buy BTC now');

    expect(runOrchestratorMock).toHaveBeenCalledTimes(2);
    expect(runOrchestratorMock.mock.calls[0]?.[2]).toMatchObject({
      executionOrigin: 'autonomous',
      allowTradeMutations: true,
    });
    expect(runOrchestratorMock.mock.calls[1]?.[2]).toMatchObject({
      executionOrigin: 'chat',
      allowTradeMutations: true,
    });
  });

  it('allows autonomous reduce-only trade confirmations when full auto is disabled', async () => {
    runOrchestratorMock.mockClear();
    let observedReduceOnly = false;
    let observedIncrease = true;
    runOrchestratorMock.mockImplementationOnce(async (_goal: string, ctx: any) => {
      observedReduceOnly = await ctx.onConfirmation(
        'Execute perp_place_order?',
        'perp_place_order',
        { symbol: 'BTC', side: 'sell', size: 0.1, reduce_only: true }
      );
      observedIncrease = await ctx.onConfirmation(
        'Execute perp_place_order?',
        'perp_place_order',
        { symbol: 'BTC', side: 'buy', size: 0.1, reduce_only: false }
      );
      return {
        response: 'ok',
        state: {
          plan: null,
          toolExecutions: [],
          criticResult: null,
          mode: 'trade',
        },
        summary: { fragility: null },
      };
    });

    const { ConversationHandler } = await import('../../src/core/conversation.js');
    const llm = { complete: vi.fn(async () => ({ content: 'ok', model: 'test' })) } as any;
    const marketClient = { searchMarkets: vi.fn(async () => []) } as any;
    const config = {
      execution: { mode: 'live', provider: 'hyperliquid' },
      agent: { useOrchestrator: true },
      autonomy: { fullAuto: false },
    } as any;

    const handler = new ConversationHandler(llm, marketClient, config);
    await handler.chat('__heartbeat__', 'Manage position risk.');
    expect(observedReduceOnly).toBe(true);
    expect(observedIncrease).toBe(false);
  });

  it('suppresses repeated planning progress updates while preserving stage transitions', async () => {
    runOrchestratorMock.mockClear();
    runOrchestratorMock.mockImplementationOnce(async (_goal: string, ctx: any) => {
      const update = ctx?.onUpdate as ((state: any) => void) | undefined;
      update?.({ plan: null, toolExecutions: [] });
      update?.({ plan: null, toolExecutions: [] });
      update?.({ plan: { complete: false }, toolExecutions: [] });
      update?.({ plan: { complete: false }, toolExecutions: [] });
      update?.({
        plan: { complete: false },
        toolExecutions: [{ toolName: 'perp_market_get' }],
      });
      update?.({
        plan: { complete: true },
        toolExecutions: [{ toolName: 'perp_market_get' }],
      });
      return {
        response: 'ok',
        state: {
          plan: { complete: true },
          toolExecutions: [{ toolName: 'perp_market_get' }],
          criticResult: null,
          mode: 'trade',
        },
        summary: { fragility: null },
      };
    });

    const { ConversationHandler } = await import('../../src/core/conversation.js');
    const llm = { complete: vi.fn(async () => ({ content: 'ok', model: 'test' })) } as any;
    const marketClient = { searchMarkets: vi.fn(async () => []) } as any;
    const config = {
      execution: { mode: 'live', provider: 'hyperliquid' },
      agent: { useOrchestrator: true },
      autonomy: { fullAuto: true },
    } as any;
    const onProgress = vi.fn(async () => undefined);

    const handler = new ConversationHandler(llm, marketClient, config);
    await handler.chat('user', 'Run a quick check', onProgress);

    const progressMessages = onProgress.mock.calls.map((call) => String(call[0]));
    expect(progressMessages.filter((m) => m.includes('analyzing request')).length).toBe(1);
    expect(progressMessages.filter((m) => m.includes('building execution plan')).length).toBe(1);
    expect(progressMessages.some((m) => m.includes('running perp_market_get'))).toBe(true);
    expect(progressMessages.filter((m) => m.includes('finalizing response')).length).toBe(1);
  });
  it('forces heartbeat to HEARTBEAT_OK when no verified mutating tool execution exists', async () => {
    runOrchestratorMock.mockClear();
    runOrchestratorMock.mockResolvedValueOnce({
      response: 'HEARTBEAT_ACTION: Opened BTC long in paper mode.',
      state: {
        plan: null,
        toolExecutions: [
          {
            toolName: 'perp_analyze',
            input: { symbol: 'BTC' },
            result: { success: true, data: { direction: 'up' } },
            timestamp: new Date().toISOString(),
            durationMs: 1,
            cached: false,
          },
        ],
        criticResult: null,
        mode: 'trade',
      },
      summary: { fragility: null },
    });

    const { ConversationHandler } = await import('../../src/core/conversation.js');
    const llm = { complete: vi.fn(async () => ({ content: 'ok', model: 'test' })) } as any;
    const marketClient = { searchMarkets: vi.fn(async () => []) } as any;
    const config = {
      execution: { mode: 'paper', provider: 'hyperliquid' },
      agent: { useOrchestrator: true },
      autonomy: { fullAuto: true },
    } as any;

    const handler = new ConversationHandler(llm, marketClient, config);
    const reply = await handler.chat('__heartbeat__', 'Read HEARTBEAT.md if it exists.');
    expect(reply.trim()).toBe('HEARTBEAT_OK');
  });

  it('keeps HEARTBEAT_ACTION when mutating tool execution is verified', async () => {
    runOrchestratorMock.mockClear();
    runOrchestratorMock.mockResolvedValueOnce({
      response: 'Opened BTC long in paper mode.',
      state: {
        plan: null,
        toolExecutions: [
          {
            toolName: 'perp_place_order',
            input: { symbol: 'BTC', side: 'buy', size: 0.01 },
            result: { success: true, data: { message: 'Paper order filled (oid=123).' } },
            timestamp: new Date().toISOString(),
            durationMs: 1,
            cached: false,
          },
        ],
        criticResult: null,
        mode: 'trade',
      },
      summary: { fragility: null },
    });

    const { ConversationHandler } = await import('../../src/core/conversation.js');
    const llm = { complete: vi.fn(async () => ({ content: 'ok', model: 'test' })) } as any;
    const marketClient = { searchMarkets: vi.fn(async () => []) } as any;
    const config = {
      execution: { mode: 'paper', provider: 'hyperliquid' },
      agent: { useOrchestrator: true },
      autonomy: { fullAuto: true },
    } as any;

    const handler = new ConversationHandler(llm, marketClient, config);
    const reply = await handler.chat('__heartbeat__', 'Read HEARTBEAT.md if it exists.');
    expect(reply.startsWith('HEARTBEAT_ACTION:')).toBe(true);
  });

  it('passes the heartbeat timeout through to the LLM call', async () => {
    appendEntryMock.mockClear();
    compactIfNeededMock.mockClear();
    buildContextMessagesMock.mockClear();
    storeChatMessageMock.mockClear();
    chatVectorAddMock.mockClear();

    const { ConversationHandler } = await import('../../src/core/conversation.js');
    const llm = {
      complete: vi.fn(async () => ({ content: 'HEARTBEAT_OK', model: 'test' })),
    } as any;
    const marketClient = { searchMarkets: vi.fn(async () => []) } as any;
    const config = {
      execution: { mode: 'paper', provider: 'hyperliquid' },
      agent: { useOrchestrator: false, alwaysIncludeTime: false },
      notifications: { heartbeat: { storeHistory: false } },
    } as any;

    const handler = new ConversationHandler(llm, marketClient, config);
    await handler.chat(
      '__heartbeat__',
      'Read HEARTBEAT.md if it exists.',
      undefined,
      { mode: 'heartbeat', timeoutMs: 4321, storeHistory: false }
    );

    expect(llm.complete).toHaveBeenCalledTimes(1);
    expect(llm.complete.mock.calls[0]?.[1]).toMatchObject({ timeoutMs: 4321 });
    expect(compactIfNeededMock).not.toHaveBeenCalled();
    expect(buildContextMessagesMock).not.toHaveBeenCalled();
  });

  it('does not persist heartbeat chat history when storeHistory is false', async () => {
    appendEntryMock.mockClear();
    compactIfNeededMock.mockClear();
    buildContextMessagesMock.mockClear();
    storeChatMessageMock.mockClear();
    chatVectorAddMock.mockClear();

    const { ConversationHandler } = await import('../../src/core/conversation.js');
    const llm = {
      complete: vi.fn(async () => ({ content: 'HEARTBEAT_OK', model: 'test' })),
    } as any;
    const marketClient = { searchMarkets: vi.fn(async () => []) } as any;
    const config = {
      execution: { mode: 'paper', provider: 'hyperliquid' },
      agent: { useOrchestrator: false, alwaysIncludeTime: false },
      notifications: { heartbeat: { storeHistory: false } },
    } as any;

    const handler = new ConversationHandler(llm, marketClient, config);
    await handler.chat(
      '__heartbeat__',
      'Read HEARTBEAT.md if it exists.',
      undefined,
      { mode: 'heartbeat', storeHistory: false }
    );

    expect(appendEntryMock).not.toHaveBeenCalled();
    expect(storeChatMessageMock).not.toHaveBeenCalled();
    expect(chatVectorAddMock).not.toHaveBeenCalled();
  });
});
