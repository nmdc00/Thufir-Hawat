import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import yaml from 'yaml';

import type { ThufirConfig } from '../core/config.js';
import type { CatalystEntry, UpcomingCatalyst } from './types.js';

type CatalystRegistry = {
  catalysts?: CatalystEntry[];
} | CatalystEntry[];

type CachedRegistry = {
  mtimeMs: number;
  catalysts: CatalystEntry[];
};

let cached: { path: string; value: CachedRegistry } | null = null;

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

function resolvePath(config: ThufirConfig): string {
  const configured = (config as any)?.reflexivity?.catalystsFile as string | undefined;
  const path = configured || 'config/catalysts.yaml';
  return isAbsolute(path) ? path : join(process.cwd(), path);
}

function normalizeSymbols(symbols: unknown): string[] {
  if (!Array.isArray(symbols)) return [];
  return symbols
    .map((s) => (typeof s === 'string' ? s.trim().toUpperCase() : ''))
    .filter(Boolean);
}

function coerceCatalystEntry(value: unknown): CatalystEntry | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const id = typeof obj.id === 'string' ? obj.id : '';
  const type = typeof obj.type === 'string' ? obj.type : 'other';
  const symbols = normalizeSymbols(obj.symbols);
  if (!id || symbols.length === 0) return null;
  return {
    id,
    type: type as CatalystEntry['type'],
    symbols,
    scheduledUtc: typeof obj.scheduledUtc === 'string' ? obj.scheduledUtc : undefined,
    description: typeof obj.description === 'string' ? obj.description : undefined,
    tags: Array.isArray(obj.tags) ? (obj.tags.filter((t) => typeof t === 'string') as string[]) : undefined,
    monitorQueries: Array.isArray(obj.monitorQueries)
      ? (obj.monitorQueries.filter((t) => typeof t === 'string') as string[])
      : undefined,
    sources: Array.isArray(obj.sources)
      ? (obj.sources.filter((t) => typeof t === 'string') as string[])
      : undefined,
  };
}

function parseRegistry(text: string, ext: string): CatalystRegistry {
  if (ext.endsWith('.json')) {
    return JSON.parse(text) as CatalystRegistry;
  }
  return (yaml.parse(text) ?? {}) as CatalystRegistry;
}

export function loadCatalystRegistry(config: ThufirConfig): CatalystEntry[] {
  const path = resolvePath(config);
  let st: { mtimeMs: number };
  try {
    st = statSync(path);
  } catch {
    return [];
  }

  if (cached && cached.path === path && cached.value.mtimeMs === st.mtimeMs) {
    return cached.value.catalysts;
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }

  const ext = path.toLowerCase();
  let parsed: CatalystRegistry;
  try {
    parsed = parseRegistry(raw, ext);
  } catch {
    return [];
  }

  const entries = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { catalysts?: unknown }).catalysts)
      ? ((parsed as { catalysts?: unknown }).catalysts as unknown[])
      : [];

  const catalysts = entries
    .map(coerceCatalystEntry)
    .filter((c): c is CatalystEntry => !!c);

  cached = { path, value: { mtimeMs: st.mtimeMs, catalysts } };
  return catalysts;
}

function matchesSymbol(entry: CatalystEntry, baseSymbol: string): boolean {
  const sym = baseSymbol.toUpperCase();
  return entry.symbols.includes('*') || entry.symbols.includes(sym);
}

function parseScheduledMs(entry: CatalystEntry): number | null {
  if (!entry.scheduledUtc) return null;
  const ms = Date.parse(entry.scheduledUtc);
  return Number.isFinite(ms) ? ms : null;
}

export function listUpcomingCatalysts(params: {
  config: ThufirConfig;
  baseSymbol: string;
  nowMs: number;
  horizonSeconds: number;
}): UpcomingCatalyst[] {
  const horizonMs = Math.max(0, params.horizonSeconds) * 1000;
  const catalysts = loadCatalystRegistry(params.config);

  const out: UpcomingCatalyst[] = [];
  for (const entry of catalysts) {
    if (!matchesSymbol(entry, params.baseSymbol)) continue;
    const scheduledMs = parseScheduledMs(entry);
    if (scheduledMs == null) {
      out.push({
        ...entry,
        scheduledMs: null,
        secondsToEvent: null,
      });
      continue;
    }
    const delta = scheduledMs - params.nowMs;
    if (delta < 0) continue;
    if (horizonMs > 0 && delta > horizonMs) continue;
    out.push({
      ...entry,
      scheduledMs,
      secondsToEvent: Math.round(delta / 1000),
    });
  }

  out.sort((a, b) => (a.scheduledMs ?? Number.MAX_SAFE_INTEGER) - (b.scheduledMs ?? Number.MAX_SAFE_INTEGER));
  return out;
}

export function computeCatalystProximityScore(params: {
  upcoming: UpcomingCatalyst[];
  horizonSeconds: number;
}): { score: number; nextSecondsToEvent: number | null } {
  const horizon = Math.max(1, params.horizonSeconds);
  const scheduled = params.upcoming.find((c) => typeof c.secondsToEvent === 'number');
  if (!scheduled || scheduled.secondsToEvent == null) {
    return { score: 0, nextSecondsToEvent: null };
  }
  const t = Math.max(0, scheduled.secondsToEvent);
  const score = clamp(1 - t / horizon);
  return { score, nextSecondsToEvent: t };
}

