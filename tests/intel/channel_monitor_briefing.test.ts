/**
 * Channel monitor two-stage briefing filter (gateway logic) unit tests
 *
 * Tests the callback wired into TelegramChannelMonitor.onBreakingNews:
 *   Stage 1 — infoLlm pre-screen (YES/NO relevance)
 *   Stage 2 — primaryAgent.handleMessage (only on YES)
 *
 * Covers:
 * - infoLlm YES → handleMessage called with text and source in prompt
 * - infoLlm NO → handleMessage never called
 * - infoLlm throws → fail-safe: no handleMessage, no crash
 * - infoLlm returns garbage → treated as NO
 * - handleMessage returns BREAKING_OK sentinel → no Telegram send
 * - handleMessage returns real content → sends to all allowedChatIds
 * - telegram is null → no crash after YES gate
 * - handleMessage throws → error logged, no crash
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getExecutionContext, withExecutionContextIfMissing } from '../../src/core/llm_infra.js';

// ---------------------------------------------------------------------------
// Helpers — build the callback the same way gateway/index.ts does
// ---------------------------------------------------------------------------

type InfoLlm = { complete: (msgs: any[], opts?: any) => Promise<{ content: string }> };
type PrimaryAgent = {
  getInfoLlm: () => InfoLlm | undefined;
  getLlm: () => InfoLlm;
  handleMessage: (session: string, prompt: string) => Promise<string | null>;
};
type Telegram = { sendMessage: (chatId: string, msg: string) => Promise<void> };

interface Config {
  channels: {
    telegram: {
      monitor?: { eventDrivenScanEnabled?: boolean };
      allowedChatIds?: number[];
    };
  };
}

function buildCallback(
  primaryAgent: PrimaryAgent,
  telegram: Telegram | null,
  config: Config,
  maybeRunEventDrivenScan = vi.fn().mockResolvedValue(undefined),
  logger = { warn: vi.fn(), info: vi.fn() },
) {
  return async (itemCount: number, text: string, source: string): Promise<void> => {
    if (config.channels.telegram.monitor?.eventDrivenScanEnabled !== false) {
      await maybeRunEventDrivenScan('intel', itemCount);
    }

    const infoLlm = primaryAgent.getInfoLlm() ?? primaryAgent.getLlm();
    let relevant = false;
    try {
      const screen = await withExecutionContextIfMissing(
        {
          mode: 'LIGHT_REASONING',
          critical: false,
          reason: 'telegram_monitor_relevance',
          source: 'gateway',
        },
        () =>
          infoLlm.complete([
            {
              role: 'user',
              content:
                `Relevance filter for a trading system. Does this news have a direct, immediate impact on tradeable assets (crypto perps, oil, gold, FX)?\n\nNews: ${text.slice(0, 500)}\n\nReply YES or NO only.`,
            },
          ], { temperature: 0 })
      );
      relevant = screen.content.trim().toUpperCase().startsWith('YES');
    } catch {
      return;
    }

    if (!relevant || !telegram) return;

    const prompt =
      `Breaking news from @${source}:\n\n${text}\n\n` +
      `Analyse the market impact. Use intel_recent for context. ` +
      `If there is a concrete implication for an open position or watchlist market, state it clearly. ` +
      `If not actionable, reply BREAKING_OK.`;
    try {
      const response = await primaryAgent.handleMessage('__channel_monitor__', prompt);
      if (!response?.trim() || response.trim().toUpperCase().startsWith('BREAKING_OK')) return;
      for (const chatId of config.channels.telegram.allowedChatIds ?? []) {
        await telegram.sendMessage(String(chatId), response).catch(() => {});
      }
    } catch (err) {
      logger.warn('TelegramChannelMonitor: briefing call failed', err);
    }
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CHAT_IDS = [111111, 222222];

function makeConfig(overrides: Partial<Config['channels']['telegram']> = {}): Config {
  return {
    channels: {
      telegram: {
        monitor: { eventDrivenScanEnabled: true },
        allowedChatIds: CHAT_IDS,
        ...overrides,
      },
    },
  };
}

function makeInfoLlm(answer: string): InfoLlm {
  return { complete: vi.fn().mockResolvedValue({ content: answer }) };
}

function makePrimaryAgent(infoLlm: InfoLlm | undefined, handleMessageResult: string | null = 'Oil short is the play — Hormuz reopening removes supply risk premium.') {
  return {
    getInfoLlm: vi.fn().mockReturnValue(infoLlm),
    getLlm: vi.fn().mockReturnValue(makeInfoLlm('YES')),
    handleMessage: vi.fn().mockResolvedValue(handleMessageResult),
  };
}

function makeTelegram(): { bot: Telegram; sendMessage: ReturnType<typeof vi.fn> } {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  return { bot: { sendMessage }, sendMessage };
}

const BREAKING_TEXT = 'Iran announces Strait of Hormuz is fully open to shipping traffic';
const SOURCE = 'marketfeed';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('channel monitor briefing — two-stage filter', () => {
  let agent: ReturnType<typeof makePrimaryAgent>;
  let tg: ReturnType<typeof makeTelegram>;

  beforeEach(() => {
    agent = makePrimaryAgent(makeInfoLlm('YES'));
    tg = makeTelegram();
  });

  it('calls handleMessage when infoLlm returns YES', async () => {
    const cb = buildCallback(agent, tg.bot, makeConfig());
    await cb(1, BREAKING_TEXT, SOURCE);
    expect(agent.handleMessage).toHaveBeenCalledOnce();
    expect(agent.handleMessage).toHaveBeenCalledWith('__channel_monitor__', expect.stringContaining(BREAKING_TEXT));
  });

  it('includes source in prompt passed to handleMessage', async () => {
    const cb = buildCallback(agent, tg.bot, makeConfig());
    await cb(1, BREAKING_TEXT, SOURCE);
    const [, prompt] = agent.handleMessage.mock.calls[0];
    expect(prompt).toContain(`@${SOURCE}`);
  });

  it('does NOT call handleMessage when infoLlm returns NO', async () => {
    agent = makePrimaryAgent(makeInfoLlm('NO'));
    const cb = buildCallback(agent, tg.bot, makeConfig());
    await cb(1, BREAKING_TEXT, SOURCE);
    expect(agent.handleMessage).not.toHaveBeenCalled();
  });

  it('does NOT call handleMessage when infoLlm returns garbage', async () => {
    agent = makePrimaryAgent(makeInfoLlm('MAYBE'));
    const cb = buildCallback(agent, tg.bot, makeConfig());
    await cb(1, BREAKING_TEXT, SOURCE);
    expect(agent.handleMessage).not.toHaveBeenCalled();
  });

  it('does NOT call handleMessage when infoLlm throws — fail-safe', async () => {
    const failingInfoLlm: InfoLlm = { complete: vi.fn().mockRejectedValue(new Error('timeout')) };
    agent = makePrimaryAgent(failingInfoLlm);
    const cb = buildCallback(agent, tg.bot, makeConfig());
    await expect(cb(1, BREAKING_TEXT, SOURCE)).resolves.toBeUndefined();
    expect(agent.handleMessage).not.toHaveBeenCalled();
  });

  it('falls back to getLlm when getInfoLlm returns undefined', async () => {
    const fallbackLlm = makeInfoLlm('YES');
    agent = { getInfoLlm: vi.fn().mockReturnValue(undefined), getLlm: vi.fn().mockReturnValue(fallbackLlm), handleMessage: vi.fn().mockResolvedValue('Relevant analysis.') };
    const cb = buildCallback(agent, tg.bot, makeConfig());
    await cb(1, BREAKING_TEXT, SOURCE);
    expect(fallbackLlm.complete).toHaveBeenCalledOnce();
    expect(agent.handleMessage).toHaveBeenCalledOnce();
  });

  it('runs the relevance pre-screen under LIGHT_REASONING execution context', async () => {
    const observedContexts: Array<ReturnType<typeof getExecutionContext>> = [];
    const contextualInfoLlm: InfoLlm = {
      complete: vi.fn().mockImplementation(async () => {
        observedContexts.push(getExecutionContext());
        return { content: 'YES' };
      }),
    };
    agent = makePrimaryAgent(contextualInfoLlm);
    const cb = buildCallback(agent, tg.bot, makeConfig());

    await cb(1, BREAKING_TEXT, SOURCE);

    expect(observedContexts).toHaveLength(1);
    expect(observedContexts[0]).toMatchObject({
      mode: 'LIGHT_REASONING',
      critical: false,
      reason: 'telegram_monitor_relevance',
      source: 'gateway',
    });
  });

  it('sends handleMessage response to all allowedChatIds', async () => {
    const cb = buildCallback(agent, tg.bot, makeConfig());
    await cb(1, BREAKING_TEXT, SOURCE);
    expect(tg.sendMessage).toHaveBeenCalledTimes(CHAT_IDS.length);
    expect(tg.sendMessage).toHaveBeenCalledWith(String(CHAT_IDS[0]), expect.any(String));
    expect(tg.sendMessage).toHaveBeenCalledWith(String(CHAT_IDS[1]), expect.any(String));
  });

  it('does NOT send when handleMessage returns BREAKING_OK sentinel', async () => {
    agent = makePrimaryAgent(makeInfoLlm('YES'), 'BREAKING_OK');
    const cb = buildCallback(agent, tg.bot, makeConfig());
    await cb(1, BREAKING_TEXT, SOURCE);
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it('does NOT send when handleMessage returns lowercase breaking_ok', async () => {
    agent = makePrimaryAgent(makeInfoLlm('YES'), 'breaking_ok — nothing actionable here');
    const cb = buildCallback(agent, tg.bot, makeConfig());
    await cb(1, BREAKING_TEXT, SOURCE);
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it('does NOT send when handleMessage returns empty string', async () => {
    agent = makePrimaryAgent(makeInfoLlm('YES'), '');
    const cb = buildCallback(agent, tg.bot, makeConfig());
    await cb(1, BREAKING_TEXT, SOURCE);
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it('does NOT send when handleMessage returns null', async () => {
    agent = makePrimaryAgent(makeInfoLlm('YES'), null);
    const cb = buildCallback(agent, tg.bot, makeConfig());
    await cb(1, BREAKING_TEXT, SOURCE);
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it('does not crash when telegram is null (YES gate passed)', async () => {
    const cb = buildCallback(agent, null, makeConfig());
    await expect(cb(1, BREAKING_TEXT, SOURCE)).resolves.toBeUndefined();
    expect(agent.handleMessage).not.toHaveBeenCalled();
  });

  it('logs warning and does not crash when handleMessage throws', async () => {
    agent.handleMessage.mockRejectedValue(new Error('LLM timeout'));
    const logger = { warn: vi.fn(), info: vi.fn() };
    const cb = buildCallback(agent, tg.bot, makeConfig(), undefined, logger);
    await expect(cb(1, BREAKING_TEXT, SOURCE)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('briefing call failed'),
      expect.any(Error),
    );
  });

  it('YES accepts "YES — this is relevant" (prefix match)', async () => {
    agent = makePrimaryAgent(makeInfoLlm('YES — oil markets will be affected'));
    const cb = buildCallback(agent, tg.bot, makeConfig());
    await cb(1, BREAKING_TEXT, SOURCE);
    expect(agent.handleMessage).toHaveBeenCalledOnce();
  });
});
