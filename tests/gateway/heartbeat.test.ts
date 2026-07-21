import { describe, expect, it } from 'vitest';

import {
  buildScheduledHeartbeatPrompt,
  buildHeartbeatDegradedResponse,
  classifyHeartbeatResponse,
  shouldRunScheduledHeartbeatLlm,
  shouldDeliverHeartbeatResponse,
} from '../../src/gateway/heartbeat.js';

describe('gateway heartbeat helpers', () => {
  it('classifies heartbeat responses by contract', () => {
    expect(classifyHeartbeatResponse('')).toBe('empty');
    expect(classifyHeartbeatResponse('HEARTBEAT_OK')).toBe('ok');
    expect(classifyHeartbeatResponse('heartbeat_ok')).toBe('ok');
    expect(classifyHeartbeatResponse('HEARTBEAT_ACTION: reduce risk')).toBe('action');
    expect(classifyHeartbeatResponse('Sorry, I encountered an error.')).toBe('info');
  });

  it('builds deterministic degraded heartbeat fallbacks', () => {
    const error = new Error('LLM request (openai/gpt-5.4) timed out after 120000ms');
    expect(buildHeartbeatDegradedResponse('ok', error)).toBe('HEARTBEAT_OK');
    expect(buildHeartbeatDegradedResponse('silent', error)).toBeNull();
    expect(buildHeartbeatDegradedResponse('notify', error)).toContain('HEARTBEAT_DEGRADED:');
    expect(buildHeartbeatDegradedResponse('notify', error)).toContain('timed out after 120000ms');
  });

  it('builds the scheduled heartbeat prompt with optional proactive summary', () => {
    const base = 'Read HEARTBEAT.md';
    const summary = 'Proactive search stored 2 item(s).';
    expect(buildScheduledHeartbeatPrompt(base, summary, true)).toBe(
      'Read HEARTBEAT.md\n\nProactive search stored 2 item(s).'
    );
    expect(buildScheduledHeartbeatPrompt(base, summary, false)).toBe(base);
    expect(buildScheduledHeartbeatPrompt(base, '', true)).toBe(base);
  });

  it('uses no model for routine liveness and reserves the local model for new summaries', () => {
    expect(shouldRunScheduledHeartbeatLlm('', 0)).toBe(false);
    expect(shouldRunScheduledHeartbeatLlm('Proactive search stored 0 items.', 0)).toBe(false);
    expect(shouldRunScheduledHeartbeatLlm('Proactive search stored 2 items.', 2)).toBe(true);
  });

  it('allows channel delivery only for heartbeat actions', () => {
    expect(shouldDeliverHeartbeatResponse('HEARTBEAT_ACTION: reduce risk')).toBe(true);
    expect(shouldDeliverHeartbeatResponse('HEARTBEAT_OK')).toBe(false);
    expect(shouldDeliverHeartbeatResponse('HEARTBEAT_DEGRADED: timeout')).toBe(false);
    expect(shouldDeliverHeartbeatResponse('Sorry, I encountered an error.')).toBe(false);
  });
});
