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
});
