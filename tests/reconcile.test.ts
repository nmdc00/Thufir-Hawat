import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/memory/portfolio.js', () => ({
  getCashBalance: () => 120,
}));

vi.mock('../src/execution/wallet/manager.js', () => ({
  loadWallet: () => ({ provider: {} }),
}));

vi.mock('../src/execution/wallet/balances.js', () => ({
  getWalletBalances: () => ({ usdc: 150, matic: 0, usdcAddress: '0x0' }),
}));

import { reconcileBalances } from '../src/core/reconcile.js';

describe('reconcileBalances', () => {
  it('computes delta between ledger and chain', async () => {
    const result = await reconcileBalances({ config: {} as any, password: 'pw' });
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.ledgerCash).toBe(120);
    expect(result.chainUsdc).toBe(150);
    expect(result.delta).toBe(30);
  });
});
