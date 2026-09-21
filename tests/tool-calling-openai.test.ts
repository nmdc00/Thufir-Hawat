import { describe, expect, it, vi, beforeEach } from 'vitest';

import { AgenticOpenAiClient } from '../src/core/llm.js';

vi.mock('node-fetch', () => {
  return {
    default: vi.fn(),
  };
});

import fetch from 'node-fetch';

const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;

describe('AgenticOpenAiClient tool calling', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('executes tool calls and returns final text', async () => {
    const responses = [
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: {
                    name: 'intel_recent',
                    arguments: '{"limit":1}',
                  },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            message: {
              content: 'Latest intel: ...',
            },
          },
        ],
      },
    ];

    fetchMock.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: async () => responses.shift(),
      })
    );

    const client = new AgenticOpenAiClient(
      {
        agent: {
          model: 'gpt-4o-mini',
          openaiModel: 'gpt-4o-mini',
          provider: 'openai',
          apiBaseUrl: 'https://api.openai.com',
        },
      } as any,
      {
        config: { intel: { embeddings: { enabled: false } } } as any,
        marketClient: {} as any,
      }
    );

    const result = await client.complete(
      [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'What is new?' },
      ],
      { temperature: 0.2, maxToolCalls: 3 }
    );

    expect(result.content).toContain('Latest intel');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const secondCallBody = JSON.parse(fetchMock.mock.calls[1][1]?.body ?? '{}');
    const toolMessages = secondCallBody.messages.filter((msg: any) => msg.role === 'tool');
    expect(toolMessages.length).toBeGreaterThan(0);
  });

  it('collects launchdock streaming text and tool calls', async () => {
    const streams = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"intel_recent"}}]}}]}\n\n' +
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"arguments":"{\\"limit\\":1}"}}]}}]}\n\n' +
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-2","type":"function","function":{"name":"current_time","arguments":"{\\"timezone\\":\\"UTC\\"}"}}]}}]}\n\n' +
        'data: [DONE]\n\n',
      'data: {"choices":[{"delta":{"content":"Latest intel: ..."}}]}\n\n' +
        'data: [DONE]\n\n',
    ];
    fetchMock.mockImplementation(() => Promise.resolve({
      ok: true,
      text: async () => streams.shift() ?? '',
    }));

    const client = new AgenticOpenAiClient(
      {
        agent: {
          model: 'gpt-5.6-luna',
          openaiModel: 'gpt-5.6-luna',
          provider: 'openai',
          useProxy: true,
          useResponsesApi: false,
          proxyBaseUrl: 'http://localhost:8090',
        },
      } as any,
      {
        config: { intel: { embeddings: { enabled: false } } } as any,
        marketClient: {} as any,
      }
    );

    const result = await client.complete([{ role: 'user', content: 'What is new?' }], { maxToolCalls: 3 });

    expect(result.content).toContain('Latest intel');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(fetchMock.mock.calls[0][1]?.body ?? '{}');
    expect(firstBody.stream).toBe(true);
  });
});
