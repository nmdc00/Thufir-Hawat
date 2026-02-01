import { describe, expect, it, vi } from 'vitest';

import { THUFIR_TOOLS } from '../src/core/tool-schemas.js';
import { executeToolCall } from '../src/core/tool-executor.js';

vi.mock('../src/intel/store.js', () => ({
  searchIntel: () => [{ id: 'i1', title: 'Intel', source: 'rss', timestamp: 'now' }],
  listRecentIntel: () => [{ id: 'i2', title: 'Recent', source: 'rss', timestamp: 'now' }],
}));

vi.mock('../src/memory/calibration.js', () => ({
  listCalibrationSummaries: () => [],
}));

describe('Tool schemas', () => {
  it('defines valid schemas for all tools', () => {
    for (const tool of THUFIR_TOOLS) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.input_schema.type).toBe('object');
    }
  });
});

describe('Tool executor', () => {
  const mockContext = {
    config: { intel: { embeddings: { enabled: false } } },
    marketClient: {
      searchMarkets: vi.fn().mockResolvedValue([]),
      getMarket: vi.fn().mockResolvedValue({
        id: 'm1',
        question: 'Test',
        outcomes: ['YES', 'NO'],
        prices: { YES: 0.5, NO: 0.5 },
      }),
    },
  };

  it('executes market_search', async () => {
    const result = await executeToolCall(
      'market_search',
      { query: 'bitcoin', limit: 5 },
      mockContext as any
    );
    expect(result.success).toBe(true);
    expect(mockContext.marketClient.searchMarkets).toHaveBeenCalledWith('bitcoin', 5);
  });

  it('executes market_get', async () => {
    const result = await executeToolCall(
      'market_get',
      { market_id: 'm1' },
      mockContext as any
    );
    expect(result.success).toBe(true);
    expect(mockContext.marketClient.getMarket).toHaveBeenCalledWith('m1');
  });

  it('executes intel_recent', async () => {
    const result = await executeToolCall(
      'intel_recent',
      { limit: 2 },
      mockContext as any
    );
    expect(result.success).toBe(true);
  });

  it('executes calibration_stats', async () => {
    const result = await executeToolCall(
      'calibration_stats',
      {},
      mockContext as any
    );
    expect(result.success).toBe(true);
  });

  it('fails twitter_search without bearer', async () => {
    const result = await executeToolCall(
      'twitter_search',
      { query: 'polymarket', limit: 2 },
      mockContext as any
    );
    expect(result.success).toBe(false);
  });

  it('handles unknown tools', async () => {
    const result = await executeToolCall('unknown_tool', {}, mockContext as any);
    expect(result.success).toBe(false);
  });
});
