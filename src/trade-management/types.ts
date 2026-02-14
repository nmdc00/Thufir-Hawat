export type TradeSide = 'buy' | 'sell';

export type TradeExitReason =
  | 'stop_loss'
  | 'take_profit'
  | 'time_stop'
  | 'trailing_stop'
  | 'liquidation_guard'
  | 'manual'
  | 'dust'
  | 'orphan_default';

export type TradeEnvelope = {
  tradeId: string;
  hypothesisId: string | null;
  symbol: string;
  side: TradeSide;

  entryPrice: number;
  size: number;
  leverage: number | null;
  notionalUsd: number | null;
  marginUsd: number | null;

  stopLossPct: number;
  takeProfitPct: number;
  maxHoldSeconds: number;
  trailingStopPct: number | null;
  trailingActivationPct: number;
  maxLossUsd: number | null;

  proposed: {
    stopLossPct: number;
    takeProfitPct: number;
    maxHoldSeconds: number;
    trailingStopPct: number | null;
    trailingActivationPct: number;
  } | null;

  thesis: string | null;
  signalKinds: string[];
  invalidation: string | null;
  catalystId: string | null;
  narrativeSnapshot: string | null;

  highWaterPrice: number | null; // longs
  lowWaterPrice: number | null; // shorts
  trailingActivated: boolean;
  fundingSinceOpenUsd: number | null;

  closePending: boolean;
  closePendingReason: string | null;
  closePendingAt: string | null;

  entryCloid: string | null;
  entryFeesUsd: number | null;

  enteredAt: string;
  expiresAt: string;

  tpOid: string | null;
  slOid: string | null;

  status: 'open' | 'closed';
};

export type TradeCloseRecord = {
  tradeId: string;
  symbol: string;
  exitPrice: number;
  exitReason: TradeExitReason;
  pnlUsd: number;
  pnlPct: number;
  holdDurationSeconds: number;
  fundingPaidUsd: number;
  feesUsd: number;
  closedAt: string;
};

export type TradeReflection = {
  tradeId: string;
  thesisCorrect: boolean;
  timingCorrect: boolean;
  exitReasonAppropriate: boolean;
  whatWorked: string;
  whatFailed: string;
  lessonForNextTrade: string;
};
