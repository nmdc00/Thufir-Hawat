import type { Market } from '../execution/markets.js';
import type { StoredIntel } from '../intel/store.js';

export interface MentatSignals {
  system: string;
  markets: Market[];
  intel: StoredIntel[];
  generatedAt: string;
}

export interface DetectorResult {
  score: number;
  signals: string[];
  details: Record<string, unknown>;
}

export interface DetectorBundle {
  leverage: DetectorResult;
  coupling: DetectorResult;
  illiquidity: DetectorResult;
  consensus: DetectorResult;
  irreversibility: DetectorResult;
  overall: number;
}

export interface SystemMap {
  nodes: string[];
  edges: Array<{ from: string; to: string; relation: string }>;
}

export interface MentatAssumptionInput {
  statement: string;
  dependencies?: string[] | null;
  evidence_for?: string[] | null;
  evidence_against?: string[] | null;
  stress_score?: number | null;
  last_tested?: string | null;
}

export interface MentatMechanismInput {
  name: string;
  causal_chain?: string[] | null;
  trigger_class?: string | null;
  propagation_path?: string[] | null;
}

export interface MentatFragilityCardInput {
  mechanism: string;
  exposure_surface: string;
  convexity?: string | null;
  early_signals?: string[] | null;
  falsifiers?: string[] | null;
  downside?: string | null;
  recovery_capacity?: string | null;
  score?: number | null;
}

export interface MentatScanOutput {
  system: string;
  generatedAt: string;
  signalsSummary: Record<string, unknown>;
  detectors: DetectorBundle;
  systemMap: SystemMap;
  assumptions: MentatAssumptionInput[];
  mechanisms: MentatMechanismInput[];
  fragilityCards: MentatFragilityCardInput[];
  stored: {
    assumptions: string[];
    mechanisms: string[];
    fragilityCards: string[];
  };
}

export interface MentatReport {
  system: string;
  generatedAt: string;
  fragilityScore: number | null;
  detectors?: DetectorBundle;
  systemMap?: SystemMap | null;
  topFragilityCards: Array<{
    id: string;
    mechanism: string;
    exposureSurface: string | null;
    score: number | null;
    downside: string | null;
  }>;
  assumptionsUnderStress: Array<{
    id: string;
    statement: string;
    stressScore: number | null;
    lastTested: string | null;
  }>;
  mechanisms: Array<{
    id: string;
    name: string;
    triggerClass: string | null;
    causalChain: string[];
  }>;
  falsifiers: string[];
  monitoringChecklist: string[];
}
