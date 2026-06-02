export type DashboardMode = 'paper' | 'live' | 'combined';
export type DashboardTimeframe = 'day' | 'period' | 'all' | 'custom';

export type DashboardPayload = {
  meta: {
    generatedAt: string;
    mode: DashboardMode;
    timeframe: DashboardTimeframe;
    period: string | null;
    from: string | null;
    to: string | null;
    recordCounts?: {
      perpTrades?: number;
      journals?: number;
      openPaperPositions?: number;
      alerts?: number;
    };
  };
  sections: {
    equityCurve: {
      points: Array<{
        timestamp: string;
        equity: number;
      }>;
      summary: {
        startEquity: number | null;
        endEquity: number | null;
        returnPct: number | null;
        maxDrawdownPct: number | null;
      };
    };
    openPositions: {
      rows: Array<Record<string, unknown>>;
      summary: {
        totalUnrealizedPnlUsd: number;
        longCount: number;
        shortCount: number;
      };
    };
    tradeLog: {
      rows: Array<Record<string, unknown>>;
    };
    promotionGates: {
      rows: Array<Record<string, unknown>>;
    };
    policyState: {
      observationMode: boolean;
      leverageCap: number | null;
      drawdownCapRemainingUsd: number | null;
      tradesRemainingToday: number | null;
      updatedAt: string | null;
    };
    performanceBreakdown: {
      bySignalClass: Array<Record<string, unknown>>;
      byRegime: Array<Record<string, unknown>>;
      bySession: Array<Record<string, unknown>>;
    };
    predictionAccuracy?: Record<string, unknown>;
    learningAudit?: Record<string, unknown>;
    learningObservability?: Record<string, unknown>;
    closeLearning?: {
      finalizer: Record<string, number>;
      closeEvents: Record<string, number>;
      tradeCloses: {
        total: number;
        recent: Array<Record<string, unknown>>;
      };
      reflections: Record<string, number>;
      regretCases: {
        total: number;
        byType: Array<Record<string, unknown>>;
      };
      policyLearning: {
        activeAdjustments: Array<Record<string, unknown>>;
        promotionEvents: Array<Record<string, unknown>>;
      };
    };
  };
};

export type ConversationSession = {
  sessionId: string;
  messageCount: number;
  firstMessage: string;
  startedAt: string;
  lastMessageAt: string;
};

export type ConversationsListResponse = {
  sessions: ConversationSession[];
};

export type ConversationThreadResponse = {
  sessionId: string;
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    createdAt: string;
  }>;
};

export type LogsResponse = {
  entries: Array<Record<string, unknown>>;
  total: number;
};
