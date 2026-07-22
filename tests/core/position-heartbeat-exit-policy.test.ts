import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Logger } from '../../src/core/logger.js';
import { LlmExitConsultant } from '../../src/core/llm_exit_consultant.js';
import { PositionHeartbeatService } from '../../src/core/position_heartbeat.js';

vi.mock('../../src/memory/position_heartbeat_journal.js', () => ({
  recordPositionHeartbeatDecision: () => {},
}));

vi.mock('../../src/memory/paper_perps.js', () => ({
  placePaperPerpOrder: vi.fn().mockReturnValue({
    orderId: 'mock-paper-close',
    filled: true,
    fillPrice: 100,
    markPrice: 100,
    slippageBps: 0,
    realizedPnlUsd: 0,
    feeUsd: 0,
    message: 'ok',
  }),
  listPaperPerpPositions: () => [],
}));

const mockGetPolicy = vi.fn();
const mockClearPolicy = vi.fn();
const mockUpsertPolicy = vi.fn();

vi.mock('../../src/memory/position_exit_policy.js', () => ({
  getPositionExitPolicy: (...args: unknown[]) => mockGetPolicy(...args),
  clearPositionExitPolicy: (...args: unknown[]) => mockClearPolicy(...args),
  upsertPositionExitPolicy: (...args: unknown[]) => mockUpsertPolicy(...args),
}));

function makeConfig() {
  return {
    execution: { mode: 'live', provider: 'hyperliquid' },
    heartbeat: {
      enabled: true,
      tickIntervalSeconds: 1,
      rollingBufferSize: 10,
      triggers: {
        pnlShiftPct: 99,
        liquidationProximityPct: 0.001,
        volatilitySpikePct: 99,
        volatilitySpikeWindowTicks: 100,
        timeCeilingMinutes: 9999,
        triggerCooldownSeconds: 0,
      },
      dynamicProfitProtection: { enabled: false },
    },
  } as any;
}

function makePosition(overrides: Record<string, unknown> = {}) {
  return {
    symbol: 'ETH',
    side: 'long',
    size: 1,
    unrealized_pnl: 10,
    return_on_equity: 5,
    liquidation_price: 50,
    ...overrides,
  };
}

function makeBookEntry(overrides: Record<string, unknown> = {}) {
  return {
    symbol: 'ETH',
    side: 'long',
    size: 1,
    entryPrice: 100,
    thesisExpiresAtMs: Date.now() + 60 * 60 * 1000,
    entryReasoningText: 'test thesis',
    exitContract: { thesis: 'test thesis', tradeType: 'tactical', hardRules: [], reviewGuidance: [] },
    exitContractSummary: 'test',
    lastConsultAtMs: null,
    lastConsultDecision: null,
    entryAtMs: Date.now() - 8 * 60 * 60 * 1000,
    ...overrides,
  } as any;
}

function makeService(params: {
  config?: any;
  positions?: unknown[];
  mid?: number;
  exitConsultant?: any;
  getBookEntry?: (symbol: string) => any;
}) {
  const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
  const config = params.config ?? makeConfig();
  const toolExec = async (toolName: string, toolInput: Record<string, unknown>) => {
    calls.push({ tool: toolName, input: toolInput });
    if (toolName === 'get_positions') {
      return { success: true as const, data: { positions: params.positions ?? [makePosition()] } };
    }
    if (toolName === 'perp_place_order') {
      return { success: true as const, data: { ok: true } };
    }
    return { success: false as const, error: `unexpected: ${toolName}` };
  };
  const client = { getAllMids: async () => ({ ETH: params.mid ?? 100 }) } as any;
  const service = new PositionHeartbeatService(config, { config } as any, new Logger('error'), {
    client,
    toolExec: toolExec as any,
    exitConsultant: params.exitConsultant,
    getBookEntry: params.getBookEntry,
  });
  return { service, calls };
}

describe('position heartbeat exit policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('extends TTL instead of closing when expired and no consultant is available', async () => {
    mockGetPolicy.mockReturnValue({
      symbol: 'ETH',
      side: 'long',
      timeStopAtMs: Date.now() - 1000,
      invalidationPrice: 95,
      notes: null,
    });

    const { service, calls } = makeService({});
    service.start();
    await service.tickOnce();
    service.stop();

    expect(calls.some((call) => call.tool === 'perp_place_order')).toBe(false);
    expect(mockUpsertPolicy).toHaveBeenCalledOnce();
    expect(mockClearPolicy).not.toHaveBeenCalled();
    expect(mockUpsertPolicy.mock.calls[0]?.[2]).toBeGreaterThan(Date.now());
  });

  it('allows repeated TTL extensions without a cap-forced close', async () => {
    mockGetPolicy.mockReturnValue({
      symbol: 'ETH',
      side: 'long',
      timeStopAtMs: Date.now() - 1000,
      invalidationPrice: 95,
      notes: null,
    });

    const exitConsultant = {
      canConsult: vi.fn().mockReturnValue(true),
      consult: vi.fn().mockResolvedValue({ action: 'hold', reasoning: 'thesis intact' }),
    };

    const { service, calls } = makeService({
      exitConsultant,
      getBookEntry: () => makeBookEntry({ entryAtMs: Date.now() - 14 * 24 * 60 * 60 * 1000 }),
    });
    service.start();
    await service.tickOnce();
    service.stop();

    expect(calls.some((call) => call.tool === 'perp_place_order')).toBe(false);
    expect(mockUpsertPolicy).toHaveBeenCalledOnce();
    expect(mockClearPolicy).not.toHaveBeenCalled();
  });

  it('does not repeat an unchanged TTL-approach review on consecutive runtime ticks', async () => {
    const expiry = Date.now() + 10 * 60 * 1000;
    mockGetPolicy.mockReturnValue({
      symbol: 'ETH',
      side: 'long',
      timeStopAtMs: expiry,
      invalidationPrice: 95,
      notes: null,
    });
    const bookEntry = makeBookEntry({
      thesisExpiresAtMs: expiry,
      entryAtMs: Date.now() - 10 * 60 * 1000,
    });
    const main = {
      complete: vi.fn().mockResolvedValue({
        content: JSON.stringify({ action: 'hold', reasoning: 'thesis unchanged' }),
        model: 'mock-main',
      }),
    };
    const fallback = {
      complete: vi.fn().mockResolvedValue({
        content: JSON.stringify({ action: 'hold', reasoning: 'fallback' }),
        model: 'mock-fallback',
      }),
    };
    const config = makeConfig();
    config.heartbeat.llmExitConsult = {
      firstConsultMinutes: 20,
      cadenceMinutes: 20,
      minConsultSpacingMinutes: 5,
      maxCallsPerPositionPerHour: 3,
      approachTtlMinutes: 15,
      primaryTimeoutMs: 500,
      fallbackTimeoutMs: 500,
    };
    const exitConsultant = new LlmExitConsultant(main as any, fallback as any, async () => {}, config);
    const { service, calls } = makeService({
      config,
      exitConsultant,
      getBookEntry: () => bookEntry,
    });

    service.start();
    await service.tickOnce();
    await service.tickOnce();
    service.stop();

    expect(main.complete).toHaveBeenCalledOnce();
    expect(fallback.complete).not.toHaveBeenCalled();
    expect(calls.some((call) => call.tool === 'perp_place_order')).toBe(false);
  });

  it('does not repeat an expired-TTL review inside minimum spacing', async () => {
    const expiry = Date.now() - 1000;
    mockGetPolicy.mockReturnValue({
      symbol: 'ETH',
      side: 'long',
      timeStopAtMs: expiry,
      invalidationPrice: 95,
      notes: null,
    });
    const bookEntry = makeBookEntry({
      thesisExpiresAtMs: expiry,
      entryAtMs: Date.now() - 60 * 60 * 1000,
    });
    const main = {
      complete: vi.fn().mockResolvedValue({
        content: JSON.stringify({ action: 'hold', reasoning: 'thesis unchanged' }),
        model: 'mock-main',
      }),
    };
    const fallback = {
      complete: vi.fn(),
    };
    const config = makeConfig();
    config.heartbeat.llmExitConsult = {
      enabled: true,
      firstConsultMinutes: 20,
      cadenceMinutes: 20,
      minConsultSpacingMinutes: 5,
      maxCallsPerPositionPerHour: 3,
      approachTtlMinutes: 15,
      primaryTimeoutMs: 500,
      fallbackTimeoutMs: 500,
    };
    const exitConsultant = new LlmExitConsultant(main as any, fallback as any, async () => {}, config);
    const { service } = makeService({ config, exitConsultant, getBookEntry: () => bookEntry });

    service.start();
    await service.tickOnce();
    await service.tickOnce();
    service.stop();

    expect(main.complete).toHaveBeenCalledOnce();
    expect(fallback.complete).not.toHaveBeenCalled();
  });

  it('updates invalidation and extends TTL on consultant review', async () => {
    mockGetPolicy.mockReturnValue({
      symbol: 'ETH',
      side: 'long',
      timeStopAtMs: Date.now() - 1000,
      invalidationPrice: 95,
      notes: null,
    });

    const exitConsultant = {
      canConsult: vi.fn().mockReturnValue(true),
      consult: vi.fn().mockResolvedValue({
        action: 'update_invalidation',
        reasoning: 'structure tightened',
        newInvalidationPrice: 103,
      }),
    };

    const { service, calls } = makeService({
      exitConsultant,
      getBookEntry: () => makeBookEntry(),
    });
    service.start();
    await service.tickOnce();
    service.stop();

    expect(calls.some((call) => call.tool === 'perp_place_order')).toBe(false);
    expect(mockUpsertPolicy).toHaveBeenCalledOnce();
    expect(mockUpsertPolicy.mock.calls[0]?.[3]).toBe(103);
    expect(String(mockUpsertPolicy.mock.calls[0]?.[4])).toContain('103');
  });

  it('allows consultant-driven partial reduction on TTL review without clearing the policy', async () => {
    mockGetPolicy.mockReturnValue({
      symbol: 'ETH',
      side: 'long',
      timeStopAtMs: Date.now() - 1000,
      invalidationPrice: 95,
      notes: null,
    });

    const exitConsultant = {
      canConsult: vi.fn().mockReturnValue(true),
      consult: vi.fn().mockResolvedValue({
        action: 'reduce',
        reasoning: 'extended and fading',
        reduceToFraction: 0.6,
      }),
    };

    const { service, calls } = makeService({
      exitConsultant,
      getBookEntry: () => makeBookEntry(),
    });
    service.start();
    await service.tickOnce();
    service.stop();

    const orders = calls.filter((call) => call.tool === 'perp_place_order');
    expect(orders).toHaveLength(1);
    expect(orders[0]?.input.size).toBeCloseTo(0.4, 6);
    expect(mockUpsertPolicy).toHaveBeenCalledOnce();
    expect(mockClearPolicy).not.toHaveBeenCalled();
  });

  it('still closes immediately on hard invalidation breach', async () => {
    mockGetPolicy.mockReturnValue({
      symbol: 'ETH',
      side: 'long',
      timeStopAtMs: Date.now() + 60_000,
      invalidationPrice: 95,
      notes: null,
    });

    const { service, calls } = makeService({ mid: 94 });
    service.start();
    await service.tickOnce();
    service.stop();

    const orders = calls.filter((call) => call.tool === 'perp_place_order');
    expect(orders).toHaveLength(1);
    expect(orders[0]?.input.side).toBe('sell');
    expect(mockClearPolicy).toHaveBeenCalledWith('ETH');
  });
});
