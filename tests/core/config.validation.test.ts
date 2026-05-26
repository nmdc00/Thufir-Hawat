import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/core/config.js';

vi.mock('../../src/core/llm.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/llm.js')>();
  return {
    ...actual,
    createLlmClient: vi.fn(() => ({ complete: vi.fn() })),
    createTrivialTaskClient: vi.fn(() => null),
  };
});

import { Thufir } from '../../src/index.js';

function writeTempConfig(body: string): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'thufir-config-validation-'));
  const path = join(dir, 'config.yaml');
  writeFileSync(path, body, 'utf-8');
  return { path, dir };
}

const originalGatewayPort = process.env.THUFIR_GATEWAY_PORT;

afterEach(() => {
  if (originalGatewayPort === undefined) {
    delete process.env.THUFIR_GATEWAY_PORT;
  } else {
    process.env.THUFIR_GATEWAY_PORT = originalGatewayPort;
  }
});

describe('config schema validation', () => {
  it('applies defaults for a minimal valid config', () => {
    delete process.env.THUFIR_GATEWAY_PORT;
    const { path } = writeTempConfig(`
agent:
  model: claude-3-5-sonnet-20241022
memory: {}
`);

    const config = loadConfig(path);

    expect(config.gateway.port).toBe(18789);
    expect(config.gateway.bind).toBe('loopback');
    expect(config.execution.mode).toBe('paper');
    expect(config.execution.provider).toBe('hyperliquid');
    expect(config.paper.enabled).toBe(true);
    expect(config.paper.initialCashUsdc).toBe(200);
    expect(config.paper.defaultMode).toBe('paper');
    expect(config.paper.requireExplicitLive).toBe(true);
    expect(config.paper.liveSymbolsAllowlist).toEqual(['BTC', 'ETH']);
    expect(config.paper.promotionGates.minTrades).toBe(25);
    expect(config.paper.promotionGates.maxDrawdownR).toBe(6);
    expect(config.wallet.limits.daily).toBe(100);
    expect(config.agent.persistPlans).toBe(true);
    expect(config.agent.trivial.timeoutMs).toBe(12000);
    expect(config.agent.trivial.localSoftTimeoutMs).toBe(6000);
    expect(config.agent.trivial.fallbackTimeoutMs).toBe(12000);
    expect(config.agent.trivial.keepWarmEnabled).toBe(true);
    expect(config.agent.trivial.keepWarmIntervalSeconds).toBe(180);
    expect(config.agent.trivial.keepAlive).toBe('30m');
    // v1.91 defaults
    expect(config.agent.internalPromptMode).toBe('minimal');
    expect(config.agent.promptBudget.enrichment).toBe(10000);
    expect(config.agent.promptBudget.autonomous).toBe(60000);
    expect(config.agent.promptBudget.trivial).toBe(10000);
    expect(config.agent.promptBudget.chat).toBe(120000);
    expect(config.autonomy.llmEntryGate.enabled).toBe(true);
    expect(config.autonomy.llmEntryGate.timeoutMs).toBe(5000);
    expect(config.autonomy.llmEntryGate.rejectOnBothFail).toBe(true);
    expect(config.heartbeat.llmExitConsult.enabled).toBe(true);
    expect(config.heartbeat.llmExitConsult.firstConsultMinutes).toBe(20);
    expect(config.heartbeat.llmExitConsult.cadenceMinutes).toBe(20);
    expect(config.heartbeat.llmExitConsult.roeThresholds).toEqual([3, 7, 15]);
    expect(config.heartbeat.llmExitConsult.approachTtlMinutes).toBe(15);
    expect(config.heartbeat.llmExitConsult.timeoutMs).toBe(8000);
    expect(config.notifications.heartbeat.timeoutMs).toBe(10000);
    expect(config.notifications.heartbeat.degradedMode).toBe('ok');
    expect(config.notifications.heartbeat.storeHistory).toBe(false);
    expect(config.notifications.heartbeat.includeProactiveSummary).toBe(true);
  });

  it('rejects invalid enum values', () => {
    const { path } = writeTempConfig(`
agent:
  model: claude-3-5-sonnet-20241022
execution:
  mode: not-a-mode
`);

    expect(() => loadConfig(path)).toThrow();
  });

  it('applies THUFIR_GATEWAY_PORT when numeric', () => {
    process.env.THUFIR_GATEWAY_PORT = '19001';
    const { path } = writeTempConfig(`
agent:
  model: claude-3-5-sonnet-20241022
memory: {}
`);

    const config = loadConfig(path);
    expect(config.gateway.port).toBe(19001);
  });
});

describe('startup config validation', () => {
  it('fails startup for invalid config', async () => {
    const { path } = writeTempConfig(`
agent:
  model: claude-3-5-sonnet-20241022
memory: {}
execution:
  mode: invalid
`);
    const thufir = new Thufir({ configPath: path });

    await expect(thufir.start()).rejects.toThrow();
  });

  it('starts successfully for valid config', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'thufir-config-startup-'));
    const configPath = join(tempDir, 'config.yaml');
    const dbPath = join(tempDir, 'thufir.sqlite');
    writeFileSync(configPath, `
agent:
  model: claude-3-5-sonnet-20241022
memory:
  dbPath: ${dbPath}
execution:
  mode: paper
`, 'utf-8');
    const thufir = new Thufir({ configPath });

    await expect(thufir.start()).resolves.toBeUndefined();
    await expect(thufir.stop()).resolves.toBeUndefined();
  });
});
