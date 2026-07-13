import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fetch from 'node-fetch';

import { TelegramAdapter } from '../../src/interface/telegram.js';

vi.mock('node-fetch', () => ({ default: vi.fn() }));

describe('TelegramAdapter polling resilience', () => {
  const originalEnv = { ...process.env };
  const fetchMock = vi.mocked(fetch);

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    process.env.THUFIR_TELEGRAM_POLL_TIMEOUT_MS = '1000';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.useRealTimers();
  });

  it('aborts a hung getUpdates request and reschedules instead of stalling forever', async () => {
    // Simulate a network hang: the request never settles on its own, only when aborted.
    fetchMock.mockImplementation((_url: any, init?: any) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('The user aborted a request.');
          error.name = 'AbortError';
          reject(error);
        });
      }) as any;
    });

    const adapter = new TelegramAdapter({
      channels: {
        telegram: {
          token: 'token',
          allowedChatIds: [],
          pollingInterval: 5,
        },
      },
    } as any);

    adapter.startPolling(async () => {});

    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Before the timeout, the loop is still waiting on the hung request.
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Once the poll-fetch timeout elapses, the request aborts, the loop's catch
    // block runs, and `finally` reschedules — proving it doesn't hang forever.
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
