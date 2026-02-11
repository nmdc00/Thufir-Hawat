import type { ThufirConfig } from './config.js';
import { createMarketClient } from '../execution/market-client.js';
import { listUnresolvedPredictions } from '../memory/predictions.js';
import { recordOutcome } from '../memory/calibration.js';

export async function resolveOutcomes(
  _config: ThufirConfig,
  limit = 25
): Promise<number> {
  let updated = 0;
  const marketClient = createMarketClient(_config);
  if (!marketClient.isAvailable()) {
    return 0;
  }
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
