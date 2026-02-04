import type { ThufirConfig } from '../core/config.js';
import type { TechnicalSnapshot, TradeSignal, Timeframe } from './types.js';
import { getNewsSentiment } from './news.js';
import { getOnChainSnapshot } from './onchain.js';
import { getSignalWeights } from '../memory/learning.js';

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(Math.max(value, min), max);
}

function calculateTechnicalScore(snapshot: TechnicalSnapshot): {
  score: number;
  reasoning: string[];
} {
  if (snapshot.indicators.length === 0) {
    return { score: 0, reasoning: ['Insufficient candle data for indicators.'] };
  }

  let sum = 0;
  let strengthSum = 0;
  const reasoning: string[] = [];
  for (const indicator of snapshot.indicators) {
    const dir =
      indicator.signal === 'bullish' ? 1 : indicator.signal === 'bearish' ? -1 : 0;
    sum += dir * indicator.strength;
    strengthSum += indicator.strength;
    reasoning.push(
      `${indicator.name}: ${indicator.signal} (${indicator.strength.toFixed(2)})`
    );
  }
  const score = strengthSum > 0 ? sum / strengthSum : 0;
  return { score, reasoning };
}

export async function buildTradeSignal(params: {
  config: ThufirConfig;
  snapshot: TechnicalSnapshot;
  timeframe: Timeframe;
}): Promise<TradeSignal> {
  const { config, snapshot } = params;
  const learned = getSignalWeights('global');
  const weights = learned ?? config.technical?.signals?.weights;
  const technicalWeight = weights?.technical ?? 0.5;
  const newsWeight = weights?.news ?? 0.3;
  const onChainWeight = weights?.onChain ?? 0.2;

  const technicalScore = calculateTechnicalScore(snapshot);
  const news = getNewsSentiment(snapshot.symbol);
  const onChain = await getOnChainSnapshot(config, snapshot.symbol);

  const combined =
    technicalScore.score * technicalWeight +
    news.sentiment * newsWeight +
    onChain.score * onChainWeight;

  const signalsAligned =
    Math.sign(technicalScore.score) === Math.sign(news.sentiment) &&
    Math.sign(technicalScore.score) === Math.sign(onChain.score);

  const confidence = signalsAligned ? Math.abs(combined) : Math.abs(combined) * 0.5;
  const direction =
    combined > 0.2 ? 'long' : combined < -0.2 ? 'short' : 'neutral';

  const entryPrice = snapshot.price;
  const stopLossDistance = 0.02;
  const stopLoss =
    direction === 'long'
      ? entryPrice * (1 - stopLossDistance)
      : entryPrice * (1 + stopLossDistance);
  const takeProfit =
    direction === 'long'
      ? [entryPrice * 1.02, entryPrice * 1.04, entryPrice * 1.06]
      : [entryPrice * 0.98, entryPrice * 0.96, entryPrice * 0.94];

  const firstTarget = takeProfit[0] ?? entryPrice;
  const riskRewardRatio =
    direction === 'neutral'
      ? 0
      : Math.abs(firstTarget - entryPrice) / Math.abs(entryPrice - stopLoss);

  const positionSize = clamp(confidence) * 0.05;

  return {
    symbol: snapshot.symbol,
    direction,
    confidence: clamp(confidence),
    timeframe: snapshot.timeframe,
    technicalScore: technicalScore.score,
    newsScore: news.sentiment,
    onChainScore: onChain.score,
    entryPrice,
    stopLoss,
    takeProfit,
    riskRewardRatio,
    positionSize,
    technicalReasoning: technicalScore.reasoning,
    newsReasoning: news.reasoning,
    onChainReasoning: onChain.reasoning,
  };
}
