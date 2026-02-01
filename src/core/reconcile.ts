import type { ThufirConfig } from './config.js';
import { getCashBalance } from '../memory/portfolio.js';
import { loadWallet } from '../execution/wallet/manager.js';
import { getWalletBalances } from '../execution/wallet/balances.js';

export async function reconcileBalances(params: {
  config: ThufirConfig;
  password: string;
}): Promise<
  | {
      ledgerCash: number;
      chainUsdc: number;
      delta: number;
      deltaPercent: number;
    }
  | { error: string }
> {
  const ledgerCash = getCashBalance();
  const wallet = loadWallet(params.config, params.password);
  const balances = await getWalletBalances(wallet);
  if (!balances) {
    return { error: 'Wallet provider not configured; cannot fetch on-chain balance.' };
  }

  const chainUsdc = balances.usdc ?? 0;
  const delta = chainUsdc - ledgerCash;
  const deltaPercent = ledgerCash === 0 ? 0 : (delta / ledgerCash) * 100;

  return {
    ledgerCash,
    chainUsdc,
    delta,
    deltaPercent,
  };
}
