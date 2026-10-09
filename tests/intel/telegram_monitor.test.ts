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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RPCMessageToError } from 'telegram/errors/index.js';
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
    getMessages = vi.fn().mockResolvedValue([]);
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

describe('TelegramChannelMonitor connection recovery', () => {
  function rpcError() {
    return RPCMessageToError({ errorMessage: 'CONNECTION_NOT_INITED', errorCode: 400 } as any,
      { className: 'messages.GetHistory' } as any);
  }

  function setup() {
    const { monitor, onNewIntel } = makeMonitor();
    const client = {
      getMessages: vi.fn().mockResolvedValue([{ message: 'Gold futures rise as the dollar falls' }]),
      disconnect: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(true),
    };
    monitor.client = client;
    return { monitor, onNewIntel, client };
  }

  beforeEach(() => {
    storeIntelMock.mockReset().mockReturnValue(true);
    storeAndEnqueueMock.mockReset().mockReturnValue(true);
  });
  afterEach(() => vi.useRealTimers());

  it('recovers the actual GramJS RPCError and delivers the retried post to screening', async () => {
    const { monitor, client, onNewIntel } = setup();
    const error = rpcError();
    expect(error.message).toBe('400: CONNECTION_NOT_INITED (caused by messages.GetHistory)');
    client.getMessages.mockRejectedValueOnce(error);
    await monitor.pollAll(TEST_KEYWORDS, false);
    expect(client.disconnect).toHaveBeenCalledOnce();
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.getMessages).toHaveBeenCalledTimes(2);
    expect(storeAndEnqueueMock).toHaveBeenCalledOnce();
    expect(onNewIntel).toHaveBeenCalledOnce();
  });

  it('leaves ordinary RPC errors to the next poll without reconnecting', async () => {
    const { monitor, client } = setup();
    client.getMessages.mockRejectedValueOnce({ errorMessage: 'FLOOD_WAIT_120' });
    await monitor.pollAll(TEST_KEYWORDS, false);
    expect(client.disconnect).not.toHaveBeenCalled();
    expect(storeAndEnqueueMock).not.toHaveBeenCalled();
    await monitor.pollAll(TEST_KEYWORDS, false);
    expect(storeAndEnqueueMock).toHaveBeenCalledOnce();
  });

  it('bounds persistent initialization failures to one reconnect per poll across channels', async () => {
    const { monitor, client } = setup();
    monitor.entityObjects.set('second_channel', {});
    client.getMessages.mockRejectedValue(rpcError());
    await monitor.pollAll(TEST_KEYWORDS, false);
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.getMessages).toHaveBeenCalledTimes(2);
    await monitor.pollAll(TEST_KEYWORDS, false);
    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(client.getMessages).toHaveBeenCalledTimes(3);
    expect(storeAndEnqueueMock).not.toHaveBeenCalled();
  });

  it('retries a failed reconnect on the next poll before fetching again', async () => {
    const { monitor, client } = setup();
    client.getMessages.mockRejectedValueOnce(rpcError());
    client.connect.mockRejectedValueOnce(new Error('network unavailable'));
    await monitor.pollAll(TEST_KEYWORDS, false);
    expect(client.getMessages).toHaveBeenCalledOnce();
    await monitor.pollAll(TEST_KEYWORDS, false);
    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(storeAndEnqueueMock).toHaveBeenCalledOnce();
  });

  it('preserves seed suppression after recovery', async () => {
    const { monitor, client, onNewIntel } = setup();
    client.getMessages.mockRejectedValueOnce(rpcError());
    await monitor.pollAll(TEST_KEYWORDS, true);
    expect(storeIntelMock).toHaveBeenCalledOnce();
    expect(storeAndEnqueueMock).not.toHaveBeenCalled();
    expect(onNewIntel).not.toHaveBeenCalled();
  });

  it('does not reconnect after stopping during disconnect', async () => {
    const { monitor, client } = setup();
    let release!: () => void;
    client.disconnect.mockReturnValueOnce(new Promise<void>((resolve) => { release = resolve; }));
    client.getMessages.mockRejectedValueOnce(rpcError());
    const polling = monitor.pollAll(TEST_KEYWORDS, false);
    await vi.waitFor(() => expect(client.disconnect).toHaveBeenCalledOnce());
    await monitor.stop();
    release();
    await polling;
    expect(client.connect).not.toHaveBeenCalled();
    expect(storeAndEnqueueMock).not.toHaveBeenCalled();
  });

  it('resumes scheduled polling after recovery without registering duplicate event handlers', async () => {
    vi.useFakeTimers();
    const monitor = new TelegramChannelMonitor(makeConfig(), vi.fn()) as any;
    await monitor.start();
    const client = monitor.client;
    client.getMessages.mockRejectedValueOnce(rpcError())
      .mockResolvedValue([{ message: 'Gold futures rise as the dollar falls' }]);
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(client.connect).toHaveBeenCalledTimes(2); // startup + recovery
      expect(storeAndEnqueueMock).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(storeAndEnqueueMock).toHaveBeenCalledTimes(2);
      expect(client.addEventHandler).toHaveBeenCalledOnce();
    } finally {
      await monitor.stop();
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(storeAndEnqueueMock).toHaveBeenCalledTimes(2);
  });

  it('closes a connection that finishes reconnecting after stop', async () => {
    const { monitor, client } = setup();
    let release!: () => void;
    client.connect.mockReturnValueOnce(new Promise<void>((resolve) => { release = resolve; }));
    client.getMessages.mockRejectedValueOnce(rpcError());
    const polling = monitor.pollAll(TEST_KEYWORDS, false);
    await vi.waitFor(() => expect(client.connect).toHaveBeenCalledOnce());
    await monitor.stop();
    release();
    await polling;
    expect(client.disconnect).toHaveBeenCalledTimes(3); // recovery, stop, late connect cleanup
    expect(client.getMessages).toHaveBeenCalledOnce();
    expect(storeAndEnqueueMock).not.toHaveBeenCalled();
  });
});
