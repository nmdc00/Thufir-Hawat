/**
 * Core type definitions for Thufir
 */

// ============================================================================
// Market Types
// ============================================================================

export interface Market {
  id: string;
  question: string;
  description?: string;
  outcomes: string[];
  prices: Record<string, number>;
  volume?: number;
  liquidity?: number;
  endDate?: Date;
  category?: string;
  resolved?: boolean;
  resolution?: string;
  createdAt?: Date;
  platform: string;
  metadata?: Record<string, unknown>;
}

export interface OrderBook {
  marketId: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: Date;
}

export interface OrderBookLevel {
  price: number;
  size: number;
}

// ============================================================================
// Prediction Types
// ============================================================================

export type ConfidenceLevel = 'low' | 'medium' | 'high';

export interface Prediction {
  id: string;
  marketId: string;
  marketTitle: string;

  // Prediction details
  predictedOutcome: 'YES' | 'NO';
  predictedProbability: number;
  confidenceLevel: ConfidenceLevel;
  confidenceRaw: number;
  confidenceAdjusted: number;

  // Execution details
  executed: boolean;
  executionPrice?: number;
  positionSize?: number;

  // Reasoning
  reasoning: string;
  keyFactors: Factor[];
  intelIds: string[];

  // Metadata
  domain: string;
  createdAt: Date;

  // Outcome (filled when market resolves)
  outcome?: 'YES' | 'NO';
  outcomeTimestamp?: Date;
  pnl?: number;
  brierContribution?: number;
}

export interface Factor {
  factor: string;
  weight: number;
  source: string;
}

export interface Estimate {
  probability: number;
  confidence: ConfidenceLevel;
  reasoning: string;
  keyFactors: Factor[];
  uncertainties: string[];
}

export interface PositionSize {
  recommended: number;
  kelly: number;
  adjusted: number;
  maxAllowed: number;
}

// ============================================================================
// Calibration Types
// ============================================================================

export interface CalibrationStats {
  domain: string;
  totalPredictions: number;
  brierScore: number;
  accuracy: {
    overall: number;
    byConfidenceLevel: Record<ConfidenceLevel, number>;
  };
  calibrationCurve: CalibrationBucket[];
  recentTrend: 'improving' | 'stable' | 'declining';
}

export interface CalibrationBucket {
  bucket: string;
  predictedProbability: number;
  actualFrequency: number;
  count: number;
}

// ============================================================================
// Intel Types
// ============================================================================

export type IntelSourceType = 'news' | 'social' | 'data' | 'custom';

export interface IntelItem {
  id: string;
  title: string;
  content: string;
  source: string;
  sourceType: IntelSourceType;
  category: string;
  timestamp: Date;
  url?: string;
  metadata: Record<string, unknown>;

  // NLP enrichment
  entities?: string[];
  sentiment?: number;
  relevanceScore?: number;
}

export interface IntelSource {
  name: string;
  type: IntelSourceType;
  fetch(): Promise<IntelItem[]>;
  relevance(item: IntelItem, market: Market): number;
}

export interface RetrievalQuery {
  text: string;
  limit: number;
  from?: Date;
  to?: Date;
  categories?: string[];
  sources?: string[];
  minRelevance?: number;
}

// ============================================================================
// Execution Types
// ============================================================================

export interface OrderParams {
  marketId: string;
  outcome: 'YES' | 'NO';
  side: 'BUY' | 'SELL';
  price: number;
  amount: number;
  orderType: 'LIMIT' | 'MARKET';
}

export interface Order {
  id: string;
  params: OrderParams;
  to: string;
  data: string;
  value: string;
}

export interface SignedOrder extends Order {
  signature: string;
}

export interface OrderResult {
  success: boolean;
  orderId?: string;
  filledAmount?: number;
  averagePrice?: number;
  transactionHash?: string;
  error?: string;
}

export interface Position {
  marketId: string;
  marketTitle: string;
  outcome: 'YES' | 'NO';
  shares: number;
  averagePrice: number;
  currentPrice: number;
  value: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  realizedPnl?: number;
}

export interface Portfolio {
  positions: Position[];
  totalValue: number;
  totalCost: number;
  totalPnl: number;
  totalPnlPercent: number;
  cashBalance: number;
  totalEquity?: number;
}

export interface Balance {
  usdc: number;
  matic: number;
  usdcAddress: string;
}

// ============================================================================
// User Context Types
// ============================================================================

export interface UserContext {
  userId: string;
  preferences: UserPreferences;
  domainsOfInterest: string[];
  riskTolerance: 'conservative' | 'moderate' | 'aggressive';
  notificationSettings: NotificationSettings;
  conversationSummary?: string;
  updatedAt: Date;
}

export interface UserPreferences {
  defaultPositionSize?: number;
  autoExecuteThreshold?: number;
  briefingTime?: string;
  timezone?: string;
}

export interface NotificationSettings {
  dailyBriefing: boolean;
  tradeAlerts: boolean;
  highRelevanceIntel: boolean;
  portfolioAlerts: boolean;
  channels: string[];
}

// ============================================================================
// Analysis Types
// ============================================================================

export interface Analysis {
  market: Market;
  estimate: Estimate;
  currentPrice: number;
  edge: number;
  recommendation: 'BUY' | 'SELL' | 'HOLD';
  positionSize: PositionSize;
  intelUsed: IntelItem[];
  calibrationNote?: string;
}

export interface Briefing {
  date: Date;
  portfolioSummary: {
    totalValue: number;
    dayChange: number;
    dayChangePercent: number;
  };
  topOpportunities: Analysis[];
  recentNews: IntelItem[];
  upcomingResolutions: Market[];
  calibrationUpdate?: string;
}

// ============================================================================
// Config Types
// ============================================================================

export interface ThufirConfig {
  gateway: {
    port: number;
    bind: string;
  };
  agent: {
    model: string;
    fallbackModel: string;
    workspace: string;
  };
  wallet: {
    keystorePath: string;
    limits: {
      daily: number;
      perTrade: number;
      confirmationThreshold: number;
    };
    exposure: {
      maxPositionPercent: number;
      maxDomainPercent: number;
    };
  };
  hyperliquid?: {
    enabled?: boolean;
    baseUrl?: string;
    wsUrl?: string;
    accountAddress?: string;
    privateKey?: string;
    maxLeverage?: number;
    defaultSlippageBps?: number;
    symbols?: string[];
  };
  technical?: {
    enabled?: boolean;
    priceSource?: 'binance' | 'coinbase' | 'coingecko';
    symbols?: string[];
    timeframes?: Array<'1m' | '5m' | '15m' | '1h' | '4h' | '1d'>;
    indicators?: {
      rsi?: { period?: number; overbought?: number; oversold?: number };
      macd?: { fast?: number; slow?: number; signal?: number };
      bollingerBands?: { period?: number; stdDev?: number };
    };
    signals?: {
      minConfidence?: number;
      weights?: { technical?: number; news?: number; onChain?: number };
    };
    onChain?: { enabled?: boolean; coinglassApiKey?: string };
  };
  intel: {
    vectorDb: {
      type: string;
      path: string;
    };
    sources: Record<string, unknown>;
    roaming?: {
      enabled: boolean;
      allowSources: string[];
      allowTypes: Array<'news' | 'social' | 'market'>;
      minTrust: 'low' | 'medium' | 'high';
      socialOptIn: boolean;
    };
  };
  memory: {
    dbPath: string;
  };
}
