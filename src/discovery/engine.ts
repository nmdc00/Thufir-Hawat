import type { ThufirConfig } from '../core/config.js';
import { storeDecisionArtifact } from '../memory/decision_artifacts.js';
import type { SignalCluster, SignalPrimitive } from './types.js';
import {
  signalPriceVolRegime,
  signalCrossAssetDivergence,
  signalHyperliquidFundingOISkew,
  signalHyperliquidOrderflowImbalance,
} from './signals.js';
import { generateHypotheses } from './hypotheses.js';
import { mapExpressionPlan } from './expressions.js';

function clusterSignals(symbol: string, signals: Array<SignalPrimitive | null>): SignalCluster {
  const flat = signals.filter((s): s is NonNullable<typeof s> => !!s);
  const biasScore = flat.reduce((acc, s) => acc + (s.directionalBias === 'up' ? 1 : s.directionalBias === 'down' ? -1 : 0), 0);
  const directionalBias = biasScore > 0 ? 'up' : biasScore < 0 ? 'down' : 'neutral';
  const confidence = flat.length ? Math.min(1, flat.reduce((a, b) => a + b.confidence, 0) / flat.length) : 0;
  const timeHorizon = flat[0]?.timeHorizon ?? 'hours';
  return {
    id: `cluster_${symbol}_${Date.now()}`,
    symbol,
    signals: flat,
    directionalBias,
    confidence,
    timeHorizon,
  };
}

export async function runDiscovery(config: ThufirConfig): Promise<{
  clusters: SignalCluster[];
  hypotheses: ReturnType<typeof generateHypotheses>;
  expressions: ReturnType<typeof mapExpressionPlan>[];
}> {
  const symbols = config.hyperliquid?.symbols ?? ['BTC', 'ETH'];
  const formatted = symbols.map((s) => `${s}/USDT`);

  const priceSignals = await Promise.all(formatted.map((symbol) => signalPriceVolRegime(config, symbol)));
  const crossSignals = await signalCrossAssetDivergence(config, formatted);
  const fundingSignals = await Promise.all(
    formatted.map((symbol) => signalHyperliquidFundingOISkew(config, symbol))
  );
  const orderflowSignals = await Promise.all(
    formatted.map((symbol) => signalHyperliquidOrderflowImbalance(config, symbol))
  );

  const clusters = formatted.map((symbol, idx) => {
    const matchingCross = crossSignals.filter((s) => s.symbol === symbol);
    return clusterSignals(symbol, [
      priceSignals[idx] ?? null,
      fundingSignals[idx] ?? null,
      orderflowSignals[idx] ?? null,
      ...matchingCross,
    ]);
  });

  const hypotheses = clusters.flatMap((cluster) => {
    const items = generateHypotheses(cluster);
    for (const hyp of items) {
      storeDecisionArtifact({
        source: 'discovery',
        kind: 'hypothesis',
        marketId: cluster.symbol,
        fingerprint: hyp.id,
        payload: hyp,
      });
    }
    return items;
  });

  const expressions = hypotheses.map((hyp) => {
    const cluster = clusters.find((c) => c.id === hyp.clusterId)!;
    const expr = mapExpressionPlan(config, cluster, hyp);
    storeDecisionArtifact({
      source: 'discovery',
      kind: 'expression',
      marketId: cluster.symbol,
      fingerprint: expr.id,
      payload: expr,
    });
    return expr;
  });

  for (const cluster of clusters) {
    storeDecisionArtifact({
      source: 'discovery',
      kind: 'signal_cluster',
      marketId: cluster.symbol,
      fingerprint: cluster.id,
      payload: cluster,
    });
  }

  return { clusters, hypotheses, expressions };
}
