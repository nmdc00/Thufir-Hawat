/**
 * TelegramChannelMonitor unit tests
 *
 * Covers:
 * - isConfigured() returns false when monitor is disabled or missing fields
 * - isConfigured() returns true when all required fields are present
 * - Every new non-seed post reaches screening regardless of keywords
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
const storeAndEnqueueMock = vi.fn().mockReturnValue(true);
vi.mock('../../src/intel/news_screening.js', () => ({
  storeIntelAndEnqueueNewsScreenJob: (...args: unknown[]) => storeAndEnqueueMock(...args),
  storeIntelAndMarkNewsScreenUnsampled: (...args: unknown[]) => storeAndEnqueueMock(...args),
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
  onNewIntel = vi.fn(),
) {
  const monitor = new TelegramChannelMonitor(config, onNewIntel) as any;
  monitor.channelMap = new Map([[CHANNEL_ID, 'marketfeed']]);
  monitor.entityObjects = new Map([['marketfeed', {}]]);
  return { monitor, onNewIntel };
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
    storeAndEnqueueMock.mockClear();
    storeAndEnqueueMock.mockReturnValue(true);
  });

  it('stores intel for any new message from a monitored channel', async () => {
    const { monitor } = makeMonitor();
    await monitor.handleMessage(makeEvent('Oil markets update: WTI up 0.5%'), TEST_KEYWORDS);
    expect(storeAndEnqueueMock).toHaveBeenCalledOnce();
    const arg = storeAndEnqueueMock.mock.calls[0][0];
    expect(arg.sourceType).toBe('social');
    expect(arg.category).toBe('market_news');
    expect(arg.source).toBe('@marketfeed');
  });

  it('enqueues a non-keyword gold move and a keyword post using their stored intel IDs', async () => {
    const { monitor, onNewIntel } = makeMonitor();
    const gold = 'Gold down nearly 1% in early trading';
    const blockade = 'US Navy will begin blockading ships entering Strait of Hormuz';
    await monitor.handleMessage(makeEvent(gold), TEST_KEYWORDS);
    const goldId = storeAndEnqueueMock.mock.calls[0][0].id;
    await monitor.handleMessage(makeEvent(blockade), TEST_KEYWORDS);
    const blockadeId = storeAndEnqueueMock.mock.calls[1][0].id;
    expect(onNewIntel).toHaveBeenCalledTimes(2);
    expect(onNewIntel).toHaveBeenNthCalledWith(1, goldId, 'marketfeed', expect.objectContaining({ intelId: goldId, text: gold }));
    expect(onNewIntel).toHaveBeenNthCalledWith(2, blockadeId, 'marketfeed', expect.objectContaining({ intelId: blockadeId, matchedKeyword: 'blockad' }));
  });

  it('does not await slow enqueue work before returning from message handling', async () => {
    let resolveEnqueue!: () => void;
    const enqueue = vi.fn(() => new Promise<void>((resolve) => { resolveEnqueue = resolve; }));
    const { monitor } = makeMonitor(makeConfig(), enqueue);
    await monitor.handleMessage(makeEvent('Gold up 0.3%'), TEST_KEYWORDS);
    expect(enqueue).toHaveBeenCalledOnce();
    resolveEnqueue();
  });

  it('silently drops duplicate messages (storeIntel returns false)', async () => {
    storeAndEnqueueMock.mockReturnValue(false);
    const { monitor, onNewIntel } = makeMonitor();
    await monitor.handleMessage(makeEvent('US sanctions on Iran widened'), TEST_KEYWORDS);
    expect(onNewIntel).not.toHaveBeenCalled();
  });

  it('skips empty messages', async () => {
    const { monitor } = makeMonitor();
    await monitor.handleMessage(makeEvent('   '), TEST_KEYWORDS);
    expect(storeAndEnqueueMock).not.toHaveBeenCalled();
  });

  it('ignores messages with no channelId in peerId (DMs, groups)', async () => {
    const { monitor, onNewIntel } = makeMonitor();
    await monitor.handleMessage(
      makeEvent('war breaking emergency sanctions', null),
      TEST_KEYWORDS,
    );
    expect(storeAndEnqueueMock).not.toHaveBeenCalled();
    expect(onNewIntel).not.toHaveBeenCalled();
  });

  it('ignores messages from an unknown channel ID', async () => {
    const { monitor, onNewIntel } = makeMonitor();
    await monitor.handleMessage(
      makeEvent('war breaking emergency sanctions', BigInt(999)),
      TEST_KEYWORDS,
    );
    expect(storeIntelMock).not.toHaveBeenCalled();
    expect(storeAndEnqueueMock).not.toHaveBeenCalled();
    expect(onNewIntel).not.toHaveBeenCalled();
  });

  it('retains configured keywords for diagnostics without requiring a match', async () => {
    const config = makeConfig({ breakingNewsKeywords: ['fomc'] });
    const enqueue = vi.fn();
    const monitor = new TelegramChannelMonitor(config, enqueue) as any;
    monitor.channelMap = new Map([[CHANNEL_ID, 'marketfeed']]);
    await monitor.handleMessage(makeEvent('Gold down 1.1 percent'), new Set(['fomc']));
    expect(enqueue).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Seed behaviour (processMessage with seed=true)
// ---------------------------------------------------------------------------

describe('TelegramChannelMonitor seed behaviour', () => {
  beforeEach(() => {
    storeIntelMock.mockClear();
    storeIntelMock.mockReturnValue(true);
    storeAndEnqueueMock.mockClear();
    storeAndEnqueueMock.mockReturnValue(true);
  });

  it('stores item during seed but does NOT enqueue screening', async () => {
    const { monitor, onNewIntel } = makeMonitor();
    await monitor.processMessage('war breaking emergency', 'marketfeed', TEST_KEYWORDS, /* seed */ true);
    expect(storeIntelMock).toHaveBeenCalledOnce();
    expect(storeAndEnqueueMock).not.toHaveBeenCalled();
    expect(onNewIntel).not.toHaveBeenCalled();
  });
});
