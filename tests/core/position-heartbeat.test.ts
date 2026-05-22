import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Logger } from '../../src/core/logger.js';
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

const mockGetPolicy = vi.fn().mockReturnValue(null);
const mockClearPolicy = vi.fn();
const mockUpsertPolicy = vi.fn();

vi.mock('../../src/memory/position_exit_policy.js', () => ({
  getPositionExitPolicy: (...args: unknown[]) => mockGetPolicy(...args),
  clearPositionExitPolicy: (...args: unknown[]) => mockClearPolicy(...args),
  upsertPositionExitPolicy: (...args: unknown[]) => mockUpsertPolicy(...args),
}));

function makeConfig(triggerOverrides: Record<string, unknown> = {}, dppOverrides: Record<string, unknown> = {}) {
  return {
    execution: { mode: 'live', provider: 'hyperliquid' },
    heartbeat: {
      enabled: true,
      tickIntervalSeconds: 1,
      rollingBufferSize: 10,
      triggers: {
        pnlShiftPct: 1,
        liquidationProximityPct: 5,
        volatilitySpikePct: 1,
        volatilitySpikeWindowTicks: 2,
        timeCeilingMinutes: 9999,
        triggerCooldownSeconds: 0,
        ...triggerOverrides,
      },
      dynamicProfitProtection: {
        enabled: true,
        minRMultiple: 4,
        minRoePct: 12,
        partialReduceRMultiple: 5.5,
        tightenAndReduceRMultiple: 7,
        terminalCloseRMultiple: 9,
        adverseMovePct: 1.5,
        terminalAdverseMovePct: 2.5,
        ...dppOverrides,
      },
    },
  } as any;
}

function makePosition(overrides: Record<string, unknown> = {}) {
  return {
    symbol: 'ETH',
    side: 'long',
    size: 1,
    unrealized_pnl: 10,
    return_on_equity: 20,
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
    entryAtMs: Date.now() - 60 * 60 * 1000,
    ...overrides,
  } as any;
}

function makeSequencedService(params: {
  config?: any;
  mids: number[];
  positions?: Array<Record<string, unknown>>;
  getBookEntry?: (symbol: string) => any;
}) {
  const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
  let tick = 0;
  const positions = params.positions ?? [makePosition(), makePosition()];
  const config = params.config ?? makeConfig();
  const toolExec = async (toolName: string, toolInput: Record<string, unknown>) => {
    calls.push({ tool: toolName, input: toolInput });
    if (toolName === 'get_positions') {
      return {
        success: true as const,
        data: { positions: [positions[Math.min(tick, positions.length - 1)] ?? positions[0]] },
      };
    }
    if (toolName === 'perp_place_order') {
      return { success: true as const, data: { ok: true } };
    }
    return { success: false as const, error: `unexpected: ${toolName}` };
  };
  const client = {
    getAllMids: async () => ({ ETH: params.mids[Math.min(tick++, params.mids.length - 1)] }),
  } as any;
  const service = new PositionHeartbeatService(config, { config } as any, new Logger('error'), {
    client,
    toolExec: toolExec as any,
    getBookEntry: params.getBookEntry,
  });
  return { service, calls };
}

describe('position heartbeat authorities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('chains ttl review, profit protection, and later invalidation close in one lifecycle', async () => {
    let policyState: any = {
      symbol: 'ETH',
      side: 'long',
      timeStopAtMs: Date.now() - 1000,
      invalidationPrice: 95,
      notes: null,
    };
    mockGetPolicy.mockImplementation(() => policyState);
    mockUpsertPolicy.mockImplementation((symbol, side, timeStopAtMs, invalidationPrice, notes) => {
      policyState = { symbol, side, timeStopAtMs, invalidationPrice, notes };
    });
    mockClearPolicy.mockImplementation(() => {
      policyState = null;
    });

    const exitConsultant = {
      shouldConsult: vi.fn().mockReturnValue(false),
      consult: vi.fn().mockResolvedValue({ action: 'hold', reasoning: 'thesis intact' }),
    };

    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    let tick = 0;
    const mids = [100, 132, 129, 117];
    const positions = [
      makePosition({ size: 1, return_on_equity: 5 }),
      makePosition({ size: 1, return_on_equity: 26 }),
      makePosition({ size: 1, return_on_equity: 22 }),
      makePosition({ size: 0.65, return_on_equity: 10 }),
    ];
    const config = makeConfig();
    const toolExec = async (toolName: string, toolInput: Record<string, unknown>) => {
      calls.push({ tool: toolName, input: toolInput });
      if (toolName === 'get_positions') {
        return {
          success: true as const,
          data: { positions: [positions[Math.min(tick, positions.length - 1)]!] },
        };
      }
      if (toolName === 'perp_place_order') {
        return { success: true as const, data: { ok: true } };
      }
      return { success: false as const, error: `unexpected: ${toolName}` };
    };
    const client = {
      getAllMids: async () => ({ ETH: mids[Math.min(tick++, mids.length - 1)] }),
    } as any;
    const service = new PositionHeartbeatService(config, { config } as any, new Logger('error'), {
      client,
      toolExec: toolExec as any,
      getBookEntry: () => makeBookEntry({ entryPrice: 100 }),
      exitConsultant: exitConsultant as any,
    });

    service.start();
    await service.tickOnce();
    expect(exitConsultant.consult).toHaveBeenCalledOnce();
    expect(calls.filter((call) => call.tool === 'perp_place_order')).toHaveLength(0);
    expect(policyState.timeStopAtMs).toBeGreaterThan(Date.now());
    expect(policyState.invalidationPrice).toBe(95);

    await service.tickOnce();
    expect(calls.filter((call) => call.tool === 'perp_place_order')).toHaveLength(0);

    await service.tickOnce();
    const reduceOrders = calls.filter((call) => call.tool === 'perp_place_order');
    expect(reduceOrders).toHaveLength(1);
    expect(Number(reduceOrders[0]?.input.size)).toBeCloseTo(0.35, 6);
    expect(policyState.invalidationPrice).toBeGreaterThan(95);

    await service.tickOnce();
    service.stop();

    const allOrders = calls.filter((call) => call.tool === 'perp_place_order');
    expect(allOrders).toHaveLength(2);
    expect(allOrders[1]?.input.size).toBe(0.65);
    expect(mockClearPolicy).toHaveBeenCalledWith('ETH');
    expect(policyState).toBeNull();
  });

  it('does not let generic time_ceiling close by itself anymore', async () => {
    mockGetPolicy.mockReturnValue(null);
    const { service, calls } = makeSequencedService({
      config: makeConfig({ timeCeilingMinutes: 0.0001 }, { enabled: false }),
      mids: [100, 100],
    });

    service.start();
    await service.tickOnce();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await service.tickOnce();
    service.stop();

    expect(calls.some((call) => call.tool === 'perp_place_order')).toBe(false);
  });

  it('does not let non-emergency liquidation_proximity close by itself anymore', async () => {
    mockGetPolicy.mockReturnValue(null);
    const { service, calls } = makeSequencedService({
      config: makeConfig({ liquidationProximityPct: 10 }, { enabled: false }),
      mids: [100],
      positions: [makePosition({ liquidation_price: 94 })],
    });

    service.start();
    await service.tickOnce();
    service.stop();

    expect(calls.some((call) => call.tool === 'perp_place_order')).toBe(false);
  });

  it('still performs emergency close when liquidation distance collapses below 2%', async () => {
    mockGetPolicy.mockReturnValue(null);
    const { service, calls } = makeSequencedService({
      mids: [100],
      positions: [makePosition({ liquidation_price: 99 })],
    });

    service.start();
    await service.tickOnce();
    service.stop();

    const orders = calls.filter((call) => call.tool === 'perp_place_order');
    expect(orders).toHaveLength(1);
    expect(orders[0]?.input.side).toBe('sell');
  });

  it('tightens invalidation on large extension plus deterioration', async () => {
    mockGetPolicy.mockReturnValue({
      symbol: 'ETH',
      side: 'long',
      timeStopAtMs: Date.now() + 60_000,
      invalidationPrice: 95,
      notes: null,
    });

    const { service, calls } = makeSequencedService({
      mids: [122, 120],
      getBookEntry: () => makeBookEntry({ entryPrice: 100 }),
    });

    service.start();
    await service.tickOnce();
    await service.tickOnce();
    service.stop();

    expect(calls.some((call) => call.tool === 'perp_place_order')).toBe(false);
    expect(mockUpsertPolicy).toHaveBeenCalled();
    expect(mockUpsertPolicy.mock.calls.at(-1)?.[3]).toBeGreaterThan(95);
  });

  it('partially reduces on stronger extension deterioration', async () => {
    mockGetPolicy.mockReturnValue({
      symbol: 'ETH',
      side: 'long',
      timeStopAtMs: Date.now() + 60_000,
      invalidationPrice: 95,
      notes: null,
    });

    const { service, calls } = makeSequencedService({
      mids: [132, 129],
      getBookEntry: () => makeBookEntry({ entryPrice: 100 }),
    });

    service.start();
    await service.tickOnce();
    await service.tickOnce();
    service.stop();

    const orders = calls.filter((call) => call.tool === 'perp_place_order');
    expect(orders).toHaveLength(1);
    expect(Number(orders[0]?.input.size)).toBeGreaterThan(0);
    expect(Number(orders[0]?.input.size)).toBeLessThan(1);
  });

  it('can fully close only on terminal extension failure', async () => {
    mockGetPolicy.mockReturnValue({
      symbol: 'ETH',
      side: 'long',
      timeStopAtMs: Date.now() + 60_000,
      invalidationPrice: 95,
      notes: null,
    });

    const { service, calls } = makeSequencedService({
      mids: [150, 145],
      positions: [
        makePosition({ return_on_equity: 32, liquidation_price: 141.5 }),
        makePosition({ return_on_equity: 20, liquidation_price: 141.5 }),
      ],
      getBookEntry: () => makeBookEntry({ entryPrice: 100 }),
    });

    service.start();
    await service.tickOnce();
    await service.tickOnce();
    service.stop();

    const orders = calls.filter((call) => call.tool === 'perp_place_order');
    expect(orders).toHaveLength(1);
    expect(orders[0]?.input.size).toBe(1);
    expect(mockClearPolicy).toHaveBeenCalledWith('ETH');
  });
});
