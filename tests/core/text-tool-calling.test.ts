import { describe, expect, it, vi, beforeEach } from 'vitest';

import { AgenticOpenAiClient } from '../../src/core/llm.js';

// ---------------------------------------------------------------------------
// Mock node-fetch so no real HTTP calls are made
// ---------------------------------------------------------------------------
vi.mock('node-fetch', () => ({
  default: vi.fn(),
}));

import fetch from 'node-fetch';

const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Mock tool-executor so we control tool results without side-effects
// ---------------------------------------------------------------------------
vi.mock('../../src/core/tool-executor.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    executeToolCall: vi.fn().mockResolvedValue({ success: true, data: { mock: true } }),
  };
});

import { executeToolCall } from '../../src/core/tool-executor.js';

const executeToolCallMock = executeToolCall as unknown as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal config with proxy enabled (triggers text-based tool calling) */
function makeProxyConfig(overrides: Record<string, unknown> = {}) {
  return {
    agent: {
      model: 'gpt-5.1',
      openaiModel: 'gpt-5.1',
      provider: 'openai',
      useProxy: true,
      proxyBaseUrl: 'http://localhost:8317',
      useResponsesApi: true,
      identityPromptMode: 'minimal',
      internalPromptMode: 'minimal',
      ...overrides,
    },
  } as any;
}

/** Build a minimal config WITHOUT proxy (uses native tool calling) */
function makeDirectConfig(overrides: Record<string, unknown> = {}) {
  return {
    agent: {
      model: 'gpt-5.1',
      openaiModel: 'gpt-5.1',
      provider: 'openai',
      useProxy: false,
      apiBaseUrl: 'https://api.openai.com',
      identityPromptMode: 'minimal',
      internalPromptMode: 'minimal',
      ...overrides,
    },
  } as any;
}

const toolContext = {
  config: { intel: { embeddings: { enabled: false } } } as any,
  marketClient: {} as any,
};

/** Simulate a Responses API text-only response */
function responsesTextReply(text: string) {
  return {
    ok: true,
    json: async () => ({
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text }],
        },
      ],
    }),
  };
}

/** Simulate a chat completions text-only response */
function chatCompletionsTextReply(text: string) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: text } }],
    }),
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe('Text-based tool calling (AgenticOpenAiClient with proxy)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    executeToolCallMock.mockReset();
    executeToolCallMock.mockResolvedValue({ success: true, data: { mock: true } });
  });

  // -----------------------------------------------------------------------
  // Basic flow
  // -----------------------------------------------------------------------

  it('returns text directly when model produces no <tool_call> blocks', async () => {
    fetchMock.mockResolvedValueOnce(responsesTextReply('Hello! How can I help?'));

    const client = new AgenticOpenAiClient(makeProxyConfig(), toolContext);
    const result = await client.complete([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
    ]);

    expect(result.content).toBe('Hello! How can I help?');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(executeToolCallMock).not.toHaveBeenCalled();
  });

  it('parses a single <tool_call>, executes, and returns final text', async () => {
    const firstResponse = responsesTextReply(
      'Let me check your portfolio.\n\n<tool_call>\n{"name": "get_portfolio", "arguments": {}}\n</tool_call>'
    );
    const secondResponse = responsesTextReply(
      'Your portfolio has 1000 USDC equity.'
    );

    fetchMock
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce(secondResponse);

    executeToolCallMock.mockResolvedValueOnce({
      success: true,
      data: { equity: 1000, positions: [] },
    });

    const client = new AgenticOpenAiClient(makeProxyConfig(), toolContext);
    const result = await client.complete([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'Show my portfolio' },
    ]);

    expect(result.content).toBe('Your portfolio has 1000 USDC equity.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(executeToolCallMock).toHaveBeenCalledTimes(1);
    expect(executeToolCallMock).toHaveBeenCalledWith(
      'get_portfolio',
      {},
      toolContext
    );
  });

  it('parses multiple <tool_call> blocks in a single response', async () => {
    const firstResponse = responsesTextReply(
      [
        'Let me check multiple things.',
        '<tool_call>',
        '{"name": "get_portfolio", "arguments": {}}',
        '</tool_call>',
        '<tool_call>',
        '{"name": "current_time", "arguments": {"timezone": "UTC"}}',
        '</tool_call>',
      ].join('\n')
    );
    const secondResponse = responsesTextReply(
      'Here are your results.'
    );

    fetchMock
      .mockResolvedValueOnce(firstResponse)
      .mockResolvedValueOnce(secondResponse);

    executeToolCallMock
      .mockResolvedValueOnce({ success: true, data: { equity: 500 } })
      .mockResolvedValueOnce({ success: true, data: { time: '2026-02-15T12:00:00Z' } });

    const client = new AgenticOpenAiClient(makeProxyConfig(), toolContext);
    const result = await client.complete([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'Give me status' },
    ]);

    expect(result.content).toBe('Here are your results.');
    expect(executeToolCallMock).toHaveBeenCalledTimes(2);
    expect(executeToolCallMock).toHaveBeenCalledWith('get_portfolio', {}, toolContext);
    expect(executeToolCallMock).toHaveBeenCalledWith(
      'current_time',
      { timezone: 'UTC' },
      toolContext
    );
  });

  // -----------------------------------------------------------------------
  // Multi-turn tool loops
  // -----------------------------------------------------------------------

  it('handles multi-turn tool calling (tool call -> result -> another tool call -> final)', async () => {
    const turn1 = responsesTextReply(
      '<tool_call>\n{"name": "get_portfolio", "arguments": {}}\n</tool_call>'
    );
    const turn2 = responsesTextReply(
      '<tool_call>\n{"name": "perp_positions", "arguments": {}}\n</tool_call>'
    );
    const turn3 = responsesTextReply('All clear.');

    fetchMock
      .mockResolvedValueOnce(turn1)
      .mockResolvedValueOnce(turn2)
      .mockResolvedValueOnce(turn3);

    executeToolCallMock
      .mockResolvedValueOnce({ success: true, data: { equity: 1000 } })
      .mockResolvedValueOnce({ success: true, data: [] });

    const client = new AgenticOpenAiClient(makeProxyConfig(), toolContext);
    const result = await client.complete(
      [{ role: 'user', content: 'Check everything' }],
      { maxToolCalls: 10 }
    );

    expect(result.content).toBe('All clear.');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(executeToolCallMock).toHaveBeenCalledTimes(2);
  });

  it('stops at maxToolCalls limit', async () => {
    // Model keeps returning tool calls every iteration
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        responsesTextReply(
          '<tool_call>\n{"name": "current_time", "arguments": {}}\n</tool_call>'
        )
      )
    );

    executeToolCallMock.mockResolvedValue({
      success: true,
      data: { time: 'now' },
    });

    const client = new AgenticOpenAiClient(makeProxyConfig(), toolContext);
    const result = await client.complete(
      [{ role: 'user', content: 'Loop forever' }],
      { maxToolCalls: 3 }
    );

    expect(result.content).toContain('unable to complete');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(executeToolCallMock).toHaveBeenCalledTimes(3);
  });

  // -----------------------------------------------------------------------
  // Tool results fed back correctly
  // -----------------------------------------------------------------------

  it('feeds tool results back as <tool_result> user messages', async () => {
    fetchMock
      .mockResolvedValueOnce(
        responsesTextReply(
          '<tool_call>\n{"name": "get_portfolio", "arguments": {}}\n</tool_call>'
        )
      )
      .mockResolvedValueOnce(responsesTextReply('Done.'));

    executeToolCallMock.mockResolvedValueOnce({
      success: true,
      data: { equity: 42 },
    });

    const client = new AgenticOpenAiClient(makeProxyConfig(), toolContext);
    await client.complete([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'Go' },
    ]);

    // Inspect the second fetch call's body to verify tool results are in the input
    const secondCallBody = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body ?? '{}');
    const input = secondCallBody.input ?? [];

    // Find the user message containing tool results
    const toolResultMsg = input.find(
      (m: any) =>
        m.role === 'user' &&
        m.content?.some((c: any) => c.text?.includes('<tool_result'))
    );
    expect(toolResultMsg).toBeDefined();

    const text = toolResultMsg.content[0].text;
    expect(text).toContain('<tool_result name="get_portfolio">');
    expect(text).toContain('"equity":42');
    expect(text).toContain('</tool_result>');
  });

  it('handles tool execution failures gracefully', async () => {
    fetchMock
      .mockResolvedValueOnce(
        responsesTextReply(
          '<tool_call>\n{"name": "get_portfolio", "arguments": {}}\n</tool_call>'
        )
      )
      .mockResolvedValueOnce(
        responsesTextReply('Sorry, I could not retrieve your portfolio.')
      );

    executeToolCallMock.mockResolvedValueOnce({
      success: false,
      error: 'Connection refused',
    });

    const client = new AgenticOpenAiClient(makeProxyConfig(), toolContext);
    const result = await client.complete([
      { role: 'user', content: 'Show portfolio' },
    ]);

    expect(result.content).toContain('could not retrieve');

    // Verify the error was fed back properly
    const secondCallBody = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body ?? '{}');
    const input = secondCallBody.input ?? [];
    const toolResultMsg = input.find(
      (m: any) =>
        m.role === 'user' &&
        m.content?.some((c: any) => c.text?.includes('tool_result'))
    );
    expect(toolResultMsg).toBeDefined();
    const text = toolResultMsg.content[0].text;
    expect(text).toContain('"error":"Connection refused"');
  });

  // -----------------------------------------------------------------------
  // System prompt injection
  // -----------------------------------------------------------------------

  it('injects tool definitions into the system prompt (instructions)', async () => {
    fetchMock.mockResolvedValueOnce(responsesTextReply('Hi'));

    const client = new AgenticOpenAiClient(makeProxyConfig(), toolContext);
    await client.complete([
      { role: 'system', content: 'You are Thufir.' },
      { role: 'user', content: 'Hello' },
    ]);

    const callBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body ?? '{}');
    const instructions = callBody.instructions ?? '';

    // Tool definitions should be in the instructions
    expect(instructions).toContain('Available Tools');
    expect(instructions).toContain('<tool_call>');
    expect(instructions).toContain('get_portfolio');
    expect(instructions).toContain('current_time');
    expect(instructions).toContain('intel_search');

    // Original system content should also be present
    expect(instructions).toContain('You are Thufir.');
  });

  it('does NOT send tools parameter in API body when using text-based calling', async () => {
    fetchMock.mockResolvedValueOnce(responsesTextReply('Hi'));

    const client = new AgenticOpenAiClient(makeProxyConfig(), toolContext);
    await client.complete([
      { role: 'user', content: 'Hello' },
    ]);

    const callBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body ?? '{}');
    expect(callBody.tools).toBeUndefined();
  });

  it('creates a system message with tools when none exists in input', async () => {
    fetchMock.mockResolvedValueOnce(responsesTextReply('Hi'));

    const client = new AgenticOpenAiClient(makeProxyConfig(), toolContext);
    await client.complete([
      { role: 'user', content: 'Hello' },
    ]);

    const callBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body ?? '{}');
    const instructions = callBody.instructions ?? '';
    expect(instructions).toContain('Available Tools');
  });

  // -----------------------------------------------------------------------
  // Parsing edge cases
  // -----------------------------------------------------------------------

  it('handles <tool_call> with markdown code fences inside', async () => {
    fetchMock
      .mockResolvedValueOnce(
        responsesTextReply(
          '<tool_call>\n```json\n{"name": "current_time", "arguments": {"timezone": "EST"}}\n```\n</tool_call>'
        )
      )
      .mockResolvedValueOnce(responsesTextReply('The time is 5pm EST.'));

    executeToolCallMock.mockResolvedValueOnce({
      success: true,
      data: { time: '17:00' },
    });

    const client = new AgenticOpenAiClient(makeProxyConfig(), toolContext);
    const result = await client.complete([
      { role: 'user', content: 'What time is it?' },
    ]);

    expect(result.content).toBe('The time is 5pm EST.');
    expect(executeToolCallMock).toHaveBeenCalledWith(
      'current_time',
      { timezone: 'EST' },
      toolContext
    );
  });

  it('skips malformed <tool_call> blocks and treats response as text', async () => {
    fetchMock.mockResolvedValueOnce(
      responsesTextReply(
        'Here is my answer.\n<tool_call>\nnot valid json\n</tool_call>'
      )
    );

    const client = new AgenticOpenAiClient(makeProxyConfig(), toolContext);
    const result = await client.complete([
      { role: 'user', content: 'Hello' },
    ]);

    // Malformed tool call is skipped, so no tool calls parsed → returned as text
    expect(result.content).toContain('Here is my answer.');
    expect(executeToolCallMock).not.toHaveBeenCalled();
  });

  it('handles <tool_call> with missing arguments field', async () => {
    fetchMock
      .mockResolvedValueOnce(
        responsesTextReply(
          '<tool_call>\n{"name": "get_portfolio"}\n</tool_call>'
        )
      )
      .mockResolvedValueOnce(responsesTextReply('Got it.'));

    executeToolCallMock.mockResolvedValueOnce({
      success: true,
      data: { equity: 100 },
    });

    const client = new AgenticOpenAiClient(makeProxyConfig(), toolContext);
    const result = await client.complete([
      { role: 'user', content: 'Check' },
    ]);

    expect(result.content).toBe('Got it.');
    // Should be called with empty arguments object
    expect(executeToolCallMock).toHaveBeenCalledWith('get_portfolio', {}, toolContext);
  });

  // -----------------------------------------------------------------------
  // Chat completions path (useResponsesApi: false, useProxy: true)
  // -----------------------------------------------------------------------

  it('works with chat completions path when proxy is enabled', async () => {
    fetchMock
      .mockResolvedValueOnce(
        chatCompletionsTextReply(
          '<tool_call>\n{"name": "current_time", "arguments": {}}\n</tool_call>'
        )
      )
      .mockResolvedValueOnce(chatCompletionsTextReply('It is noon.'));

    executeToolCallMock.mockResolvedValueOnce({
      success: true,
      data: { time: '12:00' },
    });

    const client = new AgenticOpenAiClient(
      makeProxyConfig({ useResponsesApi: false }),
      toolContext
    );
    const result = await client.complete([
      { role: 'user', content: 'Time?' },
    ]);

    expect(result.content).toBe('It is noon.');
    expect(executeToolCallMock).toHaveBeenCalledTimes(1);

    // Verify it used chat completions endpoint
    const url = fetchMock.mock.calls[0]?.[0] ?? '';
    expect(url).toContain('/v1/chat/completions');
  });

  // -----------------------------------------------------------------------
  // Proxy disabled → native tool calling (not text-based)
  // -----------------------------------------------------------------------

  it('uses native tool calling when proxy is disabled', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: 'No tools needed.',
              tool_calls: undefined,
            },
          },
        ],
      }),
    });

    const client = new AgenticOpenAiClient(makeDirectConfig(), toolContext);
    const result = await client.complete([
      { role: 'user', content: 'Hello' },
    ]);

    expect(result.content).toBe('No tools needed.');

    // Verify it sent the tools parameter in the body (native calling)
    const callBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body ?? '{}');
    expect(callBody.tools).toBeDefined();
    expect(Array.isArray(callBody.tools)).toBe(true);
    expect(callBody.tools.length).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  it('throws on non-OK HTTP response', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });

    const client = new AgenticOpenAiClient(makeProxyConfig(), toolContext);
    await expect(
      client.complete([{ role: 'user', content: 'Hello' }])
    ).rejects.toThrow(/LLM request failed/);
  });

  it('throws on Responses API error in response body', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        error: { message: 'Model not found' },
      }),
    });

    const client = new AgenticOpenAiClient(makeProxyConfig(), toolContext);
    await expect(
      client.complete([{ role: 'user', content: 'Hello' }])
    ).rejects.toThrow(/Model not found/);
  });

  it('returns empty content when chat completions returns null choices (without proxy)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: null }),
    });

    const client = new AgenticOpenAiClient(makeDirectConfig(), toolContext);
    const result = await client.complete([
      { role: 'user', content: 'Hello' },
    ]);

    expect(result.content).toBe('');
  });
});

// ===========================================================================
// Unit tests for the helper functions (parseTextToolCalls, etc.)
// ===========================================================================
// These functions are module-private, so we test them indirectly through the
// client's behavior above. However, we can test specific parsing scenarios.

describe('Text tool calling - parsing edge cases via integration', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    executeToolCallMock.mockReset();
    executeToolCallMock.mockResolvedValue({ success: true, data: {} });
  });

  it('handles tool call with extra whitespace', async () => {
    fetchMock
      .mockResolvedValueOnce(
        responsesTextReply(
          '  <tool_call>  \n  {"name":"get_portfolio","arguments":{}}  \n  </tool_call>  '
        )
      )
      .mockResolvedValueOnce(responsesTextReply('Done.'));

    const client = new AgenticOpenAiClient(makeProxyConfig(), toolContext);
    const result = await client.complete([
      { role: 'user', content: 'Go' },
    ]);

    expect(result.content).toBe('Done.');
    expect(executeToolCallMock).toHaveBeenCalledTimes(1);
  });

  it('handles tool call with complex nested arguments', async () => {
    const args = {
      symbol: 'ETH',
      side: 'buy',
      size: 0.1,
      order_type: 'limit',
      price: 2500.50,
      leverage: 5,
      reduce_only: false,
      reasoning: 'Breakout above resistance',
    };
    fetchMock
      .mockResolvedValueOnce(
        responsesTextReply(
          `<tool_call>\n${JSON.stringify({ name: 'perp_place_order', arguments: args })}\n</tool_call>`
        )
      )
      .mockResolvedValueOnce(responsesTextReply('Order placed.'));

    executeToolCallMock.mockResolvedValueOnce({
      success: true,
      data: { orderId: '123' },
    });

    const client = new AgenticOpenAiClient(makeProxyConfig(), toolContext);
    const result = await client.complete([
      { role: 'user', content: 'Buy ETH' },
    ]);

    expect(result.content).toBe('Order placed.');
    expect(executeToolCallMock).toHaveBeenCalledWith(
      'perp_place_order',
      args,
      toolContext
    );
  });

  it('mixed text and tool calls — text before/after tool calls preserved in conversation', async () => {
    const response1 = 'Checking now...\n<tool_call>\n{"name": "current_time", "arguments": {}}\n</tool_call>\nStand by.';
    fetchMock
      .mockResolvedValueOnce(responsesTextReply(response1))
      .mockResolvedValueOnce(responsesTextReply('All done.'));

    executeToolCallMock.mockResolvedValueOnce({
      success: true,
      data: { time: 'now' },
    });

    const client = new AgenticOpenAiClient(makeProxyConfig(), toolContext);
    const result = await client.complete([
      { role: 'user', content: 'What time?' },
    ]);

    expect(result.content).toBe('All done.');

    // The full assistant message (with tool_call blocks) should be in the second call's input
    const secondBody = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body ?? '{}');
    const assistantMsg = (secondBody.input ?? []).find(
      (m: any) =>
        m.role === 'assistant' &&
        m.content?.some((c: any) => c.text?.includes('Checking now'))
    );
    expect(assistantMsg).toBeDefined();
  });
});
