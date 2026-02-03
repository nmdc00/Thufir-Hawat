import { BollingerBands, MACD, RSI, SMA } from 'technicalindicators';

import type { ThufirConfig } from '../core/config.js';
import type { IndicatorResult, OHLCV, TechnicalSnapshot, Timeframe } from './types.js';

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(Math.max(value, min), max);
}

export function calculateIndicators(
  candles: OHLCV[],
  config: ThufirConfig
): IndicatorResult[] {
  if (candles.length < 10) {
    return [];
  }

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);
  const results: IndicatorResult[] = [];

  const rsiConfig = config.technical?.indicators?.rsi ?? {};
  const rsiPeriod = rsiConfig.period ?? 14;
  const rsi = RSI.calculate({ values: closes, period: rsiPeriod });
  const currentRsi = rsi[rsi.length - 1];
  if (currentRsi != null) {
    const overbought = rsiConfig.overbought ?? 70;
    const oversold = rsiConfig.oversold ?? 30;
    results.push({
      name: 'RSI',
      value: currentRsi,
      signal: currentRsi > overbought ? 'bearish' : currentRsi < oversold ? 'bullish' : 'neutral',
      strength: clamp(Math.abs(50 - currentRsi) / 50),
    });
  }

  const macdConfig = config.technical?.indicators?.macd ?? {};
  const macd = MACD.calculate({
    values: closes,
    fastPeriod: macdConfig.fast ?? 12,
    slowPeriod: macdConfig.slow ?? 26,
    signalPeriod: macdConfig.signal ?? 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const currentMacd = macd[macd.length - 1];
  if (
    currentMacd &&
    typeof currentMacd.MACD === 'number' &&
    typeof currentMacd.signal === 'number' &&
    typeof currentMacd.histogram === 'number'
  ) {
    results.push({
      name: 'MACD',
      value: [currentMacd.MACD, currentMacd.signal, currentMacd.histogram],
      signal: currentMacd.histogram > 0 ? 'bullish' : 'bearish',
      strength: clamp(Math.abs(currentMacd.histogram) / 5),
    });
  }

  const bbConfig = config.technical?.indicators?.bollingerBands ?? {};
  const bb = BollingerBands.calculate({
    values: closes,
    period: bbConfig.period ?? 20,
    stdDev: bbConfig.stdDev ?? 2,
  });
  const currentBb = bb[bb.length - 1];
  const currentPrice = closes[closes.length - 1];
  if (
    currentBb &&
    currentPrice &&
    typeof currentBb.lower === 'number' &&
    typeof currentBb.upper === 'number' &&
    typeof currentBb.middle === 'number'
  ) {
    const position = (currentPrice - currentBb.lower) / (currentBb.upper - currentBb.lower);
    results.push({
      name: 'Bollinger',
      value: [currentBb.lower, currentBb.middle, currentBb.upper],
      signal: position < 0.2 ? 'bullish' : position > 0.8 ? 'bearish' : 'neutral',
      strength: clamp(Math.abs(0.5 - position) * 2),
    });
  }

  const sma20 = SMA.calculate({ values: closes, period: 20 });
  const sma50 = SMA.calculate({ values: closes, period: 50 });
  const currentSma20 = sma20[sma20.length - 1];
  const currentSma50 = sma50[sma50.length - 1];
  if (currentSma20 != null && currentSma50 != null && currentPrice) {
    results.push({
      name: 'MA_Cross',
      value: [currentSma20, currentSma50],
      signal: currentSma20 > currentSma50 ? 'bullish' : 'bearish',
      strength: clamp(Math.abs(currentSma20 - currentSma50) / currentPrice * 10),
    });
  }

  if (highs.length > 0 && lows.length > 0 && volumes.length > 0) {
    const firstVolume = volumes[0] ?? 0;
    const lastVolume = volumes[volumes.length - 1] ?? 0;
    const volumeSlope = lastVolume - firstVolume;
    results.push({
      name: 'Volume_Trend',
      value: volumeSlope,
      signal: volumeSlope > 0 ? 'bullish' : volumeSlope < 0 ? 'bearish' : 'neutral',
      strength: clamp(Math.abs(volumeSlope) / Math.max(firstVolume || 1, 1)),
    });
  }

  return results;
}

export function summarizeIndicators(indicators: IndicatorResult[]): {
  bias: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  score: number;
} {
  if (indicators.length === 0) {
    return { bias: 'neutral', confidence: 0, score: 0 };
  }

  let scoreSum = 0;
  let strengthSum = 0;
  for (const indicator of indicators) {
    const direction =
      indicator.signal === 'bullish' ? 1 : indicator.signal === 'bearish' ? -1 : 0;
    scoreSum += direction * indicator.strength;
    strengthSum += indicator.strength;
  }

  const score = strengthSum > 0 ? scoreSum / strengthSum : 0;
  const confidence = clamp(Math.abs(score));
  const bias = score > 0.15 ? 'bullish' : score < -0.15 ? 'bearish' : 'neutral';
  return { bias, confidence, score };
}

export function buildTechnicalSnapshot(params: {
  symbol: string;
  timeframe: Timeframe;
  candles: OHLCV[];
  config: ThufirConfig;
}): TechnicalSnapshot {
  const indicators = calculateIndicators(params.candles, params.config);
  const summary = summarizeIndicators(indicators);
  const lastCandle = params.candles[params.candles.length - 1];
  return {
    symbol: params.symbol,
    timeframe: params.timeframe,
    timestamp: lastCandle?.timestamp ?? Date.now(),
    price: lastCandle?.close ?? 0,
    indicators,
    overallBias: summary.bias,
    confidence: summary.confidence,
  };
}
