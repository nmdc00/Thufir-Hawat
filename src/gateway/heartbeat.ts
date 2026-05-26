export type HeartbeatDegradedMode = 'ok' | 'silent' | 'notify';

export function classifyHeartbeatResponse(
  response: string | null | undefined
): 'empty' | 'ok' | 'action' | 'info' {
  const text = response?.trim() ?? '';
  if (!text) return 'empty';
  const normalized = text.toUpperCase();
  if (normalized.startsWith('HEARTBEAT_OK')) return 'ok';
  if (normalized.startsWith('HEARTBEAT_ACTION:')) return 'action';
  return 'info';
}

export function buildHeartbeatDegradedResponse(
  mode: HeartbeatDegradedMode,
  error?: unknown
): string | null {
  switch (mode) {
    case 'silent':
      return null;
    case 'notify': {
      const reason =
        error instanceof Error && error.message.trim().length > 0
          ? error.message.trim()
          : 'heartbeat degraded';
      return `HEARTBEAT_DEGRADED: ${reason}`;
    }
    case 'ok':
    default:
      return 'HEARTBEAT_OK';
  }
}

export function buildScheduledHeartbeatPrompt(
  heartbeatPrompt: string,
  proactiveSummary: string,
  includeProactiveSummary: boolean
): string {
  if (!includeProactiveSummary) {
    return heartbeatPrompt;
  }
  const summary = proactiveSummary.trim();
  if (!summary) {
    return heartbeatPrompt;
  }
  return `${heartbeatPrompt}\n\n${summary}`;
}

export function shouldDeliverHeartbeatResponse(
  response: string | null | undefined
): boolean {
  return classifyHeartbeatResponse(response) === 'action';
}
