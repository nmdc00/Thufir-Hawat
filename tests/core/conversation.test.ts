import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/intel/vectorstore.js', () => ({
  IntelVectorStore: class {
    async query() {
      return [{ id: 'i1', score: 0.9 }];
    }
  },
}));

vi.mock('../../src/intel/store.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../src/intel/store.js'
  );
  return {
    ...actual,
    listIntelByIds: () => [
      {
        id: 'i1',
        title: 'Semantic hit',
        source: 'TestSource',
        sourceType: 'news',
        timestamp: '2026-01-26T00:00:00Z',
      },
    ],
    listRecentIntel: () => [],
  };
});

vi.mock('../../src/memory/db.js', () => ({
  openDatabase: () => ({
    prepare: () => ({
      get: () => undefined,
      all: () => [],
      run: () => ({}),
    }),
    exec: () => undefined,
    pragma: () => undefined,
  }),
}));

const userPreferences: Record<string, any> = {};

vi.mock('../../src/memory/user.js', () => ({
  getUserContext: () => ({ preferences: userPreferences }),
  updateUserContext: (_userId: string, updates: any) => {
    Object.assign(userPreferences, updates.preferences ?? {});
  },
}));

vi.mock('../../src/memory/session_store.js', () => ({
  SessionStore: class {
    getSummary() {
      return 'Summary';
    }
    async compactIfNeeded() {
      return;
    }
    buildContextMessages() {
      return [];
    }
    appendEntry() {
      return;
    }
    getSessionId() {
      return 's1';
    }
    clearSession() {
      return;
    }
  },
}));

vi.mock('../../src/memory/chat.js', () => ({
  storeChatMessage: () => 'm1',
  listChatMessagesByIds: () => [
    {
      id: 'm1',
      role: 'user',
      content: 'Old message',
      createdAt: '2026-01-26T00:00:00Z',
      sessionId: 's1',
    },
  ],
  clearChatMessages: () => undefined,
  pruneChatMessages: () => 0,
}));

vi.mock('../../src/memory/chat_vectorstore.js', () => ({
  ChatVectorStore: class {
    async add() {
      return true;
    }
    async query() {
      return [{ id: 'm1', score: 0.9 }];
    }
  },
}));

describe('ConversationHandler', () => {
  it('injects semantic intel context when embeddings enabled', async () => {
    const { ConversationHandler } = await import('../../src/core/conversation.js');
    const llm = {
      complete: vi.fn(async (messages: Array<{ role: string; content: string }>) => {
        return { content: 'ok', model: 'test' };
      }),
    };
    const marketClient = {
      searchMarkets: vi.fn(async () => []),
    };

    const config = {
      intel: { embeddings: { enabled: true } },
    } as any;

    const handler = new ConversationHandler(llm as any, marketClient as any, config);
    const response = await handler.chat('user', 'Hello');
    expect(response).toContain('ok');

    const systemMessage = (llm.complete as any).mock.calls[0][0][0].content;
    expect(systemMessage).toContain('Relevant Intel (semantic search)');
  }, 25000);

  it('injects semantic chat context when memory embeddings enabled', async () => {
    const { ConversationHandler } = await import('../../src/core/conversation.js');
    const llm = {
      complete: vi.fn(async () => ({ content: 'ok', model: 'test' })),
    };
    const marketClient = { searchMarkets: vi.fn(async () => []) };
    const config = {
      intel: { embeddings: { enabled: false } },
      memory: { embeddings: { enabled: true } },
    } as any;

    const handler = new ConversationHandler(llm as any, marketClient as any, config);
    userPreferences.intelAlertsConfigured = true;
    userPreferences.intelAlertsPending = undefined;
    await handler.chat('user', 'Hello');
    const calls = (llm.complete as any).mock.calls;
    if (calls.length === 0) {
      throw new Error('LLM was not called');
    }
    const systemMessage = calls[0][0][0].content;
    expect(systemMessage).toContain('Relevant Past Conversation');
  });

  it('prompts to set intel alerts when not configured', async () => {
    const { ConversationHandler } = await import('../../src/core/conversation.js');
    const llm = {
      complete: vi.fn(async () => ({ content: 'ok', model: 'test' })),
    };
    const marketClient = { searchMarkets: vi.fn(async () => []) };
    const config = { notifications: { intelAlerts: { enabled: false } } } as any;

    const handler = new ConversationHandler(llm as any, marketClient as any, config);
    userPreferences.intelAlertsConfigured = false;
    userPreferences.intelAlertsPrompted = false;
    const reply = await handler.chat('user', 'Hello');
    expect(reply).toContain('set up intel alerts');
  });
});
