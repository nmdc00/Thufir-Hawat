import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/intel/store.js', () => ({
  searchIntel: vi.fn(() => []),
  listRecentIntel: () => [],
}));

import { ToolRegistry } from '../src/core/tools.js';
import { searchIntel } from '../src/intel/store.js';

describe('ToolRegistry', () => {
  it('caches tool results within TTL', async () => {
    const registry = new ToolRegistry({ defaultTtlMs: 10_000 });
    const ctx = { config: { intel: { sources: {} } }, marketClient: {} } as any;

    await registry.run('intel.search', ctx, { query: 'abc', limit: 3 });
    await registry.run('intel.search', ctx, { query: 'abc', limit: 3 });

    expect(vi.mocked(searchIntel)).toHaveBeenCalledTimes(1);
  });
});
