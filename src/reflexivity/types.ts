export type CatalystType =
  | 'macro'
  | 'earnings'
  | 'unlock'
  | 'upgrade'
  | 'regulatory'
  | 'exchange'
  | 'stablecoin'
  | 'other';

export type CatalystEntry = {
  id: string;
  type: CatalystType;
  symbols: string[]; // ['ETH','BTC'] or ['*']
  scheduledUtc?: string; // ISO-8601 for scheduled catalysts
  description?: string;
  tags?: string[];

  // Stochastic catalysts (no fixed time)
  monitorQueries?: string[];
  sources?: string[];
};

export type UpcomingCatalyst = CatalystEntry & {
  scheduledMs?: number | null;
  secondsToEvent?: number | null;
};

export type NarrativeSnapshotV1 = {
  schemaVersion: '1';
  symbol: string;
  asofUtc: string;
  consensusNarrative: string;
  consensusClaims: string[];
  impliedAssumptions: string[];
  dissentingViews: string[];
  unanimityScore: number; // [0,1]
  exhaustionScore: number; // [0,1]
  evidenceIntelIds: string[];
  notes?: string;
};

export type ReflexivityScores = {
  crowdingScore: number; // [0,1]
  fragilityScore: number; // [0,1]
  catalystProximityScore: number; // [0,1]
  setupScore: number; // [0,1]
};

export type ReflexivitySetupV1 = {
  schemaVersion: '1';
  symbol: string; // e.g. 'ETH/USDT'
  baseSymbol: string; // e.g. 'ETH'
  asofUtc: string;
  timeHorizon: 'minutes' | 'hours' | 'days';

  consensusNarrative: string;
  keyAssumptions: string[];
  fragilityDrivers: string[];
  catalysts: Array<{
    id: string;
    type: CatalystType;
    scheduledUtc?: string;
    secondsToEvent?: number | null;
    description?: string;
  }>;

  directionalBias: 'up' | 'down' | 'neutral';
  confidence: number; // [0,1]
  scores: ReflexivityScores;
  metrics: Record<string, number>;

  imWrongIf: string[];
  evidenceIntelIds: string[];
};

