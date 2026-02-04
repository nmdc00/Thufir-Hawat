export type MarketPlatform = string;
export type MarketKind = 'prediction' | 'perp';

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
  platform: MarketPlatform;
  kind?: MarketKind;
  symbol?: string;
  markPrice?: number;
  metadata?: Record<string, unknown>;
}
