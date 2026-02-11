import { describe, expect, it } from 'vitest';

import { executeToolCall } from '../../src/core/tool-executor.js';

describe('tool-executor system tools', () => {
  const baseCtx = {
    config: {
      agent: {
        systemTools: {
          enabled: true,
          allowedCommands: ['node', 'pnpm'],
          allowedManagers: ['pnpm'],
          allowGlobalInstall: false,
          timeoutMs: 20000,
          maxOutputChars: 4000,
        },
      },
    } as any,
    marketClient: {} as any,
  };

  it('blocks system_exec when disabled', async () => {
    const result = await executeToolCall(
      'system_exec',
      { command: 'node', args: ['-v'] },
      {
        ...baseCtx,
        config: { agent: { systemTools: { enabled: false } } } as any,
      }
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('disabled');
    }
  });

  it('executes allowlisted command', async () => {
    const result = await executeToolCall(
      'system_exec',
      { command: 'node', args: ['-v'] },
      baseCtx as any
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as { stdout?: string };
      expect(data.stdout).toMatch(/v\d+\./);
    }
  });

  it('rejects command outside allowlist', async () => {
    const result = await executeToolCall(
      'system_exec',
      { command: 'bash', args: ['-lc', 'echo nope'] },
      baseCtx as any
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('not allowed');
    }
  });

  it('rejects disallowed global install', async () => {
    const result = await executeToolCall(
      'system_install',
      { manager: 'pnpm', packages: ['tsx'], global: true },
      baseCtx as any
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Global installs are disabled');
    }
  });

  it('rejects malformed package specs', async () => {
    const result = await executeToolCall(
      'system_install',
      { manager: 'pnpm', packages: ['bad;rm -rf /'] },
      baseCtx as any
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('invalid characters');
    }
  });
});
