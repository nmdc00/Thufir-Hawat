import type { ThufirConfig } from './config.js';
import { PolymarketMarketClient } from '../execution/polymarket/markets.js';
import { listUnresolvedPredictions } from '../memory/predictions.js';
import { recordOutcome } from '../memory/calibration.js';

export async function resolveOutcomes(
  config: ThufirConfig,
  limit = 25
): Promise<number> {
  let updated = 0;
  const marketClient = new PolymarketMarketClient(config);
  const unresolved = listUnresolvedPredictions(limit);
  for (const prediction of unresolved) {
    try {
      const market = await marketClient.getMarket(prediction.marketId);
      if (!market.resolved || !market.resolution) {
        continue;
      }
      const outcome =
        market.resolution.toUpperCase() === 'YES' ? 'YES' : 'NO';
      recordOutcome({
        id: prediction.id,
        outcome,
      });
      updated += 1;
    } catch {
      // ignore per-market failures
    }
  }
  return updated;
}
