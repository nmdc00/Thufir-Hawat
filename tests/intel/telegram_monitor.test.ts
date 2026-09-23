/**
 * TelegramChannelMonitor unit tests
 *
 * Covers:
 * - isConfigured() returns false when monitor is disabled or missing fields
 * - isConfigured() returns true when all required fields are present
 * - Breaking-news keywords trigger onBreakingNews(itemCount, text, source)
 * - Non-breaking messages are stored but do NOT trigger callback
 * - Duplicate messages (same title+url) are silently dropped
 * - Seed messages are stored but do NOT trigger callback
 * - Messages from non-monitored channels (wrong ID, DMs) are ignored
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramChannelMonitor } from '../../src/intel/telegram_monitor.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const storeIntelMock = vi.fn().mockReturnValue(true); // true = new item
vi.mock('../../src/intel/store.js', () => ({
  storeIntel: (...args: unknown[]) => storeIntelMock(...args),
}));

vi.mock('../../src/core/logger.js', () => ({
  Logger: class {
    info(): void {}
    warn(): void {}
    error(): void {}
  },
}));

vi.mock('telegram', () => ({
  TelegramClient: class {
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn().mockResolvedValue(undefined);
    addEventHandler = vi.fn();
    getEntity = vi.fn().mockResolvedValue({ id: BigInt(123), username: 'marketfeed', title: 'Market Feed' });
    session = { save: () => 'mock-session-string' };
  },
}));

vi.mock('telegram/sessions/index.js', () => ({
  StringSession: class {
    constructor(public s: string) {}
  },
}));

vi.mock('telegram/events/index.js', () => ({
  NewMessage: class {},
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CHANNEL_ID = BigInt(123);

function makeConfig(overrides: Record<string, unknown> = {}): any {
  return {
    channels: {
      telegram: {
        monitor: {
          enabled: true,
          apiId: 12345,
          apiHash: 'abc123',
          phone: '+441234567890',
          sessionString: 'mock-session',
          channels: ['marketfeed'],
          breakingNewsKeywords: [],
          eventDrivenScanEnabled: true,
          ...overrides,
        },
      },
    },
  };
}

const TEST_KEYWORDS = new Set([
  'blockad', 'sanction', 'war', 'nuclear', 'crash', 'default', 'emergency',
  'breaking', 'tariff', 'invad', 'attack', 'missile', 'hormuz', 'strait',
]);

function makeMonitor(
  config = makeConfig(),
  onBreakingNews = vi.fn().mockResolvedValue(undefined),
) {
  const monitor = new TelegramChannelMonitor(config, onBreakingNews) as any;
  monitor.channelMap = new Map([[CHANNEL_ID, 'marketfeed']]);
  monitor.entityObjects = new Map([['marketfeed', {}]]);
  return { monitor, onBreakingNews };
}

function makeEvent(text: string, channelId: bigint | null = CHANNEL_ID) {
  return {
    message: {
      message: text,
      peerId: channelId != null ? { channelId } : {},
    },
  };
}

// ---------------------------------------------------------------------------
// isConfigured()
// ---------------------------------------------------------------------------

describe('TelegramChannelMonitor.isConfigured', () => {
  it('returns false when monitor is disabled', () => {
    const m = new TelegramChannelMonitor(makeConfig({ enabled: false }), vi.fn());
    expect(m.isConfigured()).toBe(false);
  });

  it('returns false when sessionString is empty', () => {
    const m = new TelegramChannelMonitor(makeConfig({ sessionString: '' }), vi.fn());
    expect(m.isConfigured()).toBe(false);
  });

  it('returns false when channels is empty', () => {
    const m = new TelegramChannelMonitor(makeConfig({ channels: [] }), vi.fn());
    expect(m.isConfigured()).toBe(false);
  });

  it('returns false when apiId is missing', () => {
    const m = new TelegramChannelMonitor(makeConfig({ apiId: undefined }), vi.fn());
    expect(m.isConfigured()).toBe(false);
  });

  it('returns true when all required fields are present', () => {
    const m = new TelegramChannelMonitor(makeConfig(), vi.fn());
    expect(m.isConfigured()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleMessage (via internal access)
// ---------------------------------------------------------------------------

describe('TelegramChannelMonitor message handling', () => {
  beforeEach(() => {
    storeIntelMock.mockClear();
    storeIntelMock.mockReturnValue(true);
  });

  it('stores intel for any new message from a monitored channel', async () => {
    const { monitor } = makeMonitor();
    await monitor.handleMessage(makeEvent('Oil markets update: WTI up 0.5%'), TEST_KEYWORDS);
    expect(storeIntelMock).toHaveBeenCalledOnce();
    const arg = storeIntelMock.mock.calls[0][0];
    expect(arg.sourceType).toBe('social');
    expect(arg.category).toBe('market_news');
    expect(arg.source).toBe('@marketfeed');
  });

  it('does NOT call onBreakingNews for routine market update', async () => {
    const { monitor, onBreakingNews } = makeMonitor();
    await monitor.handleMessage(makeEvent('Gold up 0.3% in early trading'), TEST_KEYWORDS);
    expect(onBreakingNews).not.toHaveBeenCalled();
  });

  it('passes itemCount=1, full text, and source to onBreakingNews on keyword match', async () => {
    const { monitor, onBreakingNews } = makeMonitor();
    const text = 'US Navy will begin blockading all ships entering Strait of Hormuz';
    await monitor.handleMessage(makeEvent(text), TEST_KEYWORDS);
    expect(onBreakingNews).toHaveBeenCalledOnce();
    expect(onBreakingNews).toHaveBeenCalledWith(1, text, 'marketfeed', expect.objectContaining({
      intelId: expect.any(String), source: '@marketfeed', text, matchedKeyword: 'blockad', receivedAtMs: expect.any(Number),
    }));
    expect(onBreakingNews.mock.calls[0][3].intelId).toBe(storeIntelMock.mock.calls[0][0].id);
  });

  it('passes correct source for "tariff" keyword', async () => {
    const { monitor, onBreakingNews } = makeMonitor();
    const text = 'Trump announces 145% tariff on all Chinese imports effective immediately';
    await monitor.handleMessage(makeEvent(text), TEST_KEYWORDS);
    expect(onBreakingNews).toHaveBeenCalledWith(1, text, 'marketfeed', expect.objectContaining({ matchedKeyword: 'tariff' }));
  });

  it('passes full text (not a preview) to onBreakingNews', async () => {
    const { monitor, onBreakingNews } = makeMonitor();
    const longText = 'BREAKING: ' + 'x'.repeat(400);
    await monitor.handleMessage(makeEvent(longText), TEST_KEYWORDS);
    expect(onBreakingNews).toHaveBeenCalledOnce();
    const [, receivedText] = onBreakingNews.mock.calls[0];
    expect(receivedText).toBe(longText);
    expect(receivedText.length).toBeGreaterThan(200);
  });

  it('is case-insensitive for keyword matching', async () => {
    const { monitor, onBreakingNews } = makeMonitor();
    await monitor.handleMessage(makeEvent('BREAKING: market crash imminent'), TEST_KEYWORDS);
    expect(onBreakingNews).toHaveBeenCalledWith(1, 'BREAKING: market crash imminent', 'marketfeed', expect.objectContaining({ source: '@marketfeed' }));
  });

  it('silently drops duplicate messages (storeIntel returns false)', async () => {
    storeIntelMock.mockReturnValue(false);
    const { monitor, onBreakingNews } = makeMonitor();
    await monitor.handleMessage(makeEvent('US sanctions on Iran widened'), TEST_KEYWORDS);
    expect(onBreakingNews).not.toHaveBeenCalled();
  });

  it('skips empty messages', async () => {
    const { monitor } = makeMonitor();
    await monitor.handleMessage(makeEvent('   '), TEST_KEYWORDS);
    expect(storeIntelMock).not.toHaveBeenCalled();
  });

  it('ignores messages with no channelId in peerId (DMs, groups)', async () => {
    const { monitor, onBreakingNews } = makeMonitor();
    await monitor.handleMessage(
      makeEvent('war breaking emergency sanctions', null),
      TEST_KEYWORDS,
    );
    expect(storeIntelMock).not.toHaveBeenCalled();
    expect(onBreakingNews).not.toHaveBeenCalled();
  });

  it('ignores messages from an unknown channel ID', async () => {
    const { monitor, onBreakingNews } = makeMonitor();
    await monitor.handleMessage(
      makeEvent('war breaking emergency sanctions', BigInt(999)),
      TEST_KEYWORDS,
    );
    expect(storeIntelMock).not.toHaveBeenCalled();
    expect(onBreakingNews).not.toHaveBeenCalled();
  });

  it('respects custom breakingNewsKeywords from config', async () => {
    const config = makeConfig({ breakingNewsKeywords: ['fomc', 'rate hike'] });
    const onBreakingNews = vi.fn().mockResolvedValue(undefined);
    const monitor = new TelegramChannelMonitor(config, onBreakingNews) as any;
    monitor.channelMap = new Map([[CHANNEL_ID, 'marketfeed']]);

    const keywords = new Set(['blockade', 'sanctions', 'war', 'fomc', 'rate hike']);
    const text = 'FOMC surprises with 50bps cut';
    await monitor.handleMessage(makeEvent(text), keywords);
    expect(onBreakingNews).toHaveBeenCalledWith(1, text, 'marketfeed', expect.objectContaining({ matchedKeyword: 'fomc' }));
  });
});

// ---------------------------------------------------------------------------
// Seed behaviour (processMessage with seed=true)
// ---------------------------------------------------------------------------

describe('TelegramChannelMonitor seed behaviour', () => {
  beforeEach(() => {
    storeIntelMock.mockClear();
    storeIntelMock.mockReturnValue(true);
  });

  it('stores item during seed but does NOT invoke onBreakingNews', async () => {
    const { monitor, onBreakingNews } = makeMonitor();
    await monitor.processMessage('war breaking emergency', 'marketfeed', TEST_KEYWORDS, /* seed */ true);
    expect(storeIntelMock).toHaveBeenCalledOnce();
    expect(onBreakingNews).not.toHaveBeenCalled();
  });
});
