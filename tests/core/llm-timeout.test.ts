import { describe, expect, it } from 'vitest';

import type { ChatMessage, LlmClient } from '../../src/core/llm.js';
import { wrapWithInfra } from '../../src/core/llm.js';

describe('wrapWithInfra timeout', () => {
  it('fails a hung provider call after timeout', async () => {
    const neverClient: LlmClient = {
      meta: { provider: 'anthropic', model: 'claude-test' },
      complete: async (_messages: ChatMessage[]) =>
        await new Promise(() => {
          // Intentional hang
        }),
    };

    const wrapped = wrapWithInfra(
      neverClient,
      {
        agent: {
          workspace: '/tmp/thufir-test',
          llmBudget: { enabled: false },
          identityPromptMode: 'minimal',
          internalPromptMode: 'minimal',
        },
      } as any
    );

    await expect(
      wrapped.complete(
        [{ role: 'user', content: 'ping' }],
        {
          timeoutMs: 20,
        }
      )
    ).rejects.toThrow(/timed out/i);
  });

  it('preserves trivial local timeout instead of inheriting the global LLM timeout', async () => {
    const previous = process.env.THUFIR_LLM_TIMEOUT_MS;
    process.env.THUFIR_LLM_TIMEOUT_MS = '120000';

    const seen: number[] = [];
    const trivialClient: LlmClient = {
      meta: { provider: 'local', model: 'qwen2.5:1.5b-instruct', kind: 'trivial' },
      complete: async (_messages: ChatMessage[], options) => {
        seen.push(options?.timeoutMs ?? -1);
        return { content: 'ok', model: 'qwen2.5:1.5b-instruct' };
      },
    };

    const wrapped = wrapWithInfra(
      trivialClient,
      {
        agent: {
          workspace: '/tmp/thufir-test',
          llmBudget: { enabled: false },
          identityPromptMode: 'minimal',
          internalPromptMode: 'minimal',
          trivial: {
            enabled: true,
            timeoutMs: 12000,
            localSoftTimeoutMs: 12000,
            fallbackTimeoutMs: 12000,
          },
        },
      } as any
    );

    try {
      await wrapped.complete([{ role: 'user', content: 'ping' }]);
      expect(seen).toEqual([12000]);
    } finally {
      if (previous === undefined) {
        delete process.env.THUFIR_LLM_TIMEOUT_MS;
      } else {
        process.env.THUFIR_LLM_TIMEOUT_MS = previous;
      }
    }
  });

  it('preserves trivial remote fallback timeout instead of inheriting the global LLM timeout', async () => {
    const previous = process.env.THUFIR_LLM_TIMEOUT_MS;
    process.env.THUFIR_LLM_TIMEOUT_MS = '120000';

    const seen: number[] = [];
    const trivialClient: LlmClient = {
      meta: { provider: 'openai', model: 'gpt-5.1', kind: 'trivial' },
      complete: async (_messages: ChatMessage[], options) => {
        seen.push(options?.timeoutMs ?? -1);
        return { content: 'ok', model: 'gpt-5.1' };
      },
    };

    const wrapped = wrapWithInfra(
      trivialClient,
      {
        agent: {
          workspace: '/tmp/thufir-test',
          llmBudget: { enabled: false },
          identityPromptMode: 'minimal',
          internalPromptMode: 'minimal',
          trivial: {
            enabled: true,
            timeoutMs: 12000,
            localSoftTimeoutMs: 12000,
            fallbackTimeoutMs: 9000,
          },
        },
      } as any
    );

    try {
      await wrapped.complete([{ role: 'user', content: 'ping' }]);
      expect(seen).toEqual([9000]);
    } finally {
      if (previous === undefined) {
        delete process.env.THUFIR_LLM_TIMEOUT_MS;
      } else {
        process.env.THUFIR_LLM_TIMEOUT_MS = previous;
      }
    }
  });
});
