import type { SignalCluster, Hypothesis } from './types.js';

export function generateHypotheses(cluster: SignalCluster): Hypothesis[] {
  const direction =
    cluster.directionalBias === 'up' ? 'upside continuation' : cluster.directionalBias === 'down' ? 'downside continuation' : 'mean reversion';
  const opposite =
    cluster.directionalBias === 'up' ? 'reversion down' : cluster.directionalBias === 'down' ? 'reversion up' : 'continuation';

  const baseId = `${cluster.symbol}_${Date.now()}`;

  return [
    {
      id: `hyp_${baseId}_trend`,
      clusterId: cluster.id,
      pressureSource: `Regime shift + flow pressure on ${cluster.symbol}`,
      expectedExpression: `${cluster.symbol} sees ${direction} within ${cluster.timeHorizon}`,
      timeHorizon: cluster.timeHorizon,
      invalidation: `Volatility compresses and price fails to hold direction`,
      tradeMap: `Directional perp with tight invalidation`,
      riskNotes: ['Liquidity cliffs', 'Funding flip', 'News shock against bias'],
    },
    {
      id: `hyp_${baseId}_revert`,
      clusterId: cluster.id,
      pressureSource: `Crowded positioning on ${cluster.symbol}`,
      expectedExpression: `${cluster.symbol} sees ${opposite} within ${cluster.timeHorizon}`,
      timeHorizon: cluster.timeHorizon,
      invalidation: `Price breaks through recent extremes with volume`,
      tradeMap: `Contrarian perp or reduced exposure`,
      riskNotes: ['Trend acceleration', 'Stop cascade'],
    },
  ];
}
