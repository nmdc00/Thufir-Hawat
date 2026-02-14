import { describe, it, expect } from 'vitest';

import { createTrivialTaskClient } from '../../src/core/llm.js';

describe('createTrivialTaskClient config guards', () => {
  it('uses an Anthropic model when trivialTaskProvider=anthropic but model is Ollama-style default', () => {
    const client = createTrivialTaskClient({
      agent: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-5-20251101',
        fallbackModel: 'claude-3-5-haiku-20241022',
        trivial: { enabled: true, temperature: 0.2, timeoutMs: 1000, maxTokens: 64 },
        trivialTaskProvider: 'anthropic',
        trivialTaskModel: 'qwen2.5:1.5b-instruct',
      },
      gateway: { port: 18789, bind: 'loopback' },
      execution: { mode: 'paper', provider: 'hyperliquid' },
    } as any);

    expect(client).not.toBeNull();
    // createTrivialTaskClient wraps the real client; unwrap the limiter to inspect meta.
    const meta = (client as any).inner?.meta;
    expect(meta?.provider).toBe('anthropic');
    expect(String(meta?.model ?? '')).toMatch(/claude/i);
  });

  it('uses an OpenAI model when trivialTaskProvider=openai but model is Ollama-style default', () => {
    const client = createTrivialTaskClient({
      agent: {
        provider: 'openai',
        model: 'gpt-5.2',
        openaiModel: 'gpt-5.2',
        trivial: { enabled: true, temperature: 0.2, timeoutMs: 1000, maxTokens: 64 },
        trivialTaskProvider: 'openai',
        trivialTaskModel: 'qwen2.5:1.5b-instruct',
      },
      gateway: { port: 18789, bind: 'loopback' },
      execution: { mode: 'paper', provider: 'hyperliquid' },
    } as any);

    expect(client).not.toBeNull();
    const meta = (client as any).inner?.meta;
    expect(meta?.provider).toBe('openai');
    expect(String(meta?.model ?? '')).not.toMatch(/qwen2\.5/i);
  });
});
