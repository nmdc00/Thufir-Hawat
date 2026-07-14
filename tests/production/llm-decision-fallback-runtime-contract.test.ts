import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LlmEntryGate, type EntryGateCandidate } from '../../src/core/llm_entry_gate.js';
import { wrapWithInfra, type LlmClient } from '../../src/core/llm.js';
import type { PositionBook } from '../../src/core/position_book.js';
import { closeDatabase, openDatabase } from '../../src/memory/db.js';

describe('LLM decision fallback runtime contract', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    const dbPath = process.env.THUFIR_DB_PATH;
    if (dbPath) closeDatabase(dbPath);
    delete process.env.THUFIR_DB_PATH;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('aborts a timed-out primary, uses local fallback, and persists fallback attribution', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thufir-decision-fallback-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'runtime.sqlite');
    process.env.THUFIR_DB_PATH = dbPath;
    let primarySignal: AbortSignal | undefined;

    const config = {
      agent: {
        workspace: dir,
        identityPromptMode: 'none',
        internalPromptMode: 'none',
        llmBudget: { enabled: false },
      },
      autonomy: {
        llmEntryGate: {
          enabled: true,
          deterministicPrechecks: false,
          primaryTimeoutMs: 20,
          fallbackTimeoutMs: 100,
          rejectOnBothFail: true,
        },
      },
    } as any;
    const hungPrimary: LlmClient = {
      meta: { provider: 'openai', model: 'gpt-5.4', kind: 'decision' },
      complete: async (_messages, options) => {
        primarySignal = options?.signal;
        return await new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    };
    const localFallback: LlmClient = {
      meta: { provider: 'local', model: 'qwen2.5:1.5b-instruct', kind: 'decision' },
      complete: async () => ({
        model: 'qwen2.5:1.5b-instruct',
        content: JSON.stringify({
          verdict: 'reject',
          reasoning: 'local fallback preserved capital',
          reasonCode: 'local_risk_reject',
          stopLevelPrice: 48_000,
          equityAtRiskPct: 2,
          targetRR: 2,
        }),
      }),
    };
    const book = {
      hasConflict: () => false,
      hasPosition: () => false,
      getAll: () => [],
    } as unknown as PositionBook;
    const gate = new LlmEntryGate(
      wrapWithInfra(hungPrimary, config),
      localFallback,
      async () => undefined,
      book,
      config
    );
    const candidate: EntryGateCandidate = {
      symbol: 'BTC',
      side: 'buy',
      notionalUsd: 50,
      leverage: 1,
      leverageMax: 5,
      edge: 0.08,
      confidence: 0.7,
      signalClass: 'momentum_breakout',
      regime: 'trending',
      session: 'us',
      entryReasoning: 'runtime fallback contract',
    };

    const decision = await gate.evaluate(candidate, 50_000);

    expect(primarySignal?.aborted).toBe(true);
    expect(decision).toMatchObject({ verdict: 'reject', reasoning: 'local fallback preserved capital' });
    const row = openDatabase(dbPath)
      .prepare(
        `SELECT verdict, reason_code AS reasonCode, used_fallback AS usedFallback, llm_consulted AS llmConsulted
         FROM llm_entry_gate_log ORDER BY id DESC LIMIT 1`
      )
      .get() as Record<string, unknown>;
    expect(row).toEqual({
      verdict: 'reject',
      reasonCode: 'discretionary_reject',
      usedFallback: 1,
      llmConsulted: 1,
    });
  });
});
