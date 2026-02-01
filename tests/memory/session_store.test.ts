import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionStore } from '../../src/memory/session_store.js';

describe('SessionStore', () => {
  it('creates sessions and stores summaries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-sessions-'));
    const config = {
      memory: { sessionsPath: dir, maxHistoryMessages: 2, compactAfterTokens: 10, keepRecentMessages: 1 },
    } as any;

    const llm = {
      complete: async () => ({ content: 'Summary text', model: 'test' }),
    };

    const store = new SessionStore(config);
    const userId = 'user-1';
    store.appendEntry(userId, {
      type: 'message',
      role: 'user',
      content: 'Hello world',
      timestamp: new Date().toISOString(),
    });
    store.appendEntry(userId, {
      type: 'message',
      role: 'assistant',
      content: 'Hi there',
      timestamp: new Date().toISOString(),
    });
    store.appendEntry(userId, {
      type: 'message',
      role: 'user',
      content: 'More history',
      timestamp: new Date().toISOString(),
    });

    await store.compactIfNeeded({
      userId,
      llm: llm as any,
      maxMessages: 2,
      compactAfterTokens: 1,
      keepRecent: 1,
    });

    expect(store.getSummary(userId)).toBe('Summary text');
    const context = store.buildContextMessages(userId, 2);
    expect(context.length).toBeLessThanOrEqual(1);
  });

  it('lists sessions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-sessions-'));
    const config = { memory: { sessionsPath: dir } } as any;
    const store = new SessionStore(config);
    store.getSessionId('user-a');
    store.getSessionId('user-b');
    const sessions = store.listSessions();
    expect(sessions.length).toBe(2);
  });
});
