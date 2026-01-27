export type DmScope = 'main' | 'per-peer' | 'per-channel-peer';

const DEFAULT_AGENT_ID = 'main';
const DEFAULT_MAIN_KEY = 'main';

const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_CHARS_RE = /[^a-z0-9_-]+/g;
const LEADING_DASH_RE = /^-+/;
const TRAILING_DASH_RE = /-+$/;

function normalizeToken(value: string | undefined | null): string {
  return (value ?? '').trim().toLowerCase();
}

export function normalizeMainKey(value: string | undefined | null): string {
  const trimmed = (value ?? '').trim();
  return trimmed ? trimmed.toLowerCase() : DEFAULT_MAIN_KEY;
}

export function normalizeAgentId(value: string | undefined | null): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return DEFAULT_AGENT_ID;
  if (VALID_ID_RE.test(trimmed)) return trimmed.toLowerCase();
  return (
    trimmed
      .toLowerCase()
      .replace(INVALID_CHARS_RE, '-')
      .replace(LEADING_DASH_RE, '')
      .replace(TRAILING_DASH_RE, '')
      .slice(0, 64) || DEFAULT_AGENT_ID
  );
}

export function buildAgentMainSessionKey(params: {
  agentId: string;
  mainKey?: string | undefined;
}): string {
  const agentId = normalizeAgentId(params.agentId);
  const mainKey = normalizeMainKey(params.mainKey);
  return `agent:${agentId}:${mainKey}`;
}

function resolveLinkedPeerId(params: {
  identityLinks?: Record<string, string[]>;
  channel: string;
  peerId: string;
}): string | null {
  const identityLinks = params.identityLinks;
  if (!identityLinks) return null;
  const peerId = params.peerId.trim();
  if (!peerId) return null;
  const candidates = new Set<string>();
  const rawCandidate = normalizeToken(peerId);
  if (rawCandidate) candidates.add(rawCandidate);
  const channel = normalizeToken(params.channel);
  if (channel) {
    const scopedCandidate = normalizeToken(`${channel}:${peerId}`);
    if (scopedCandidate) candidates.add(scopedCandidate);
  }
  if (candidates.size === 0) return null;
  for (const [canonical, ids] of Object.entries(identityLinks)) {
    const canonicalName = canonical.trim();
    if (!canonicalName) continue;
    if (!Array.isArray(ids)) continue;
    for (const id of ids) {
      const normalized = normalizeToken(id);
      if (normalized && candidates.has(normalized)) {
        return canonicalName;
      }
    }
  }
  return null;
}

export function buildAgentPeerSessionKey(params: {
  agentId: string;
  mainKey?: string | undefined;
  channel: string;
  peerKind?: 'dm' | 'group' | 'channel' | null;
  peerId?: string | null;
  identityLinks?: Record<string, string[]>;
  dmScope?: DmScope;
}): string {
  const peerKind = params.peerKind ?? 'dm';
  if (peerKind === 'dm') {
    const dmScope = params.dmScope ?? 'main';
    let peerId = (params.peerId ?? '').trim();
    const linkedPeerId =
      dmScope === 'main'
        ? null
        : resolveLinkedPeerId({
            identityLinks: params.identityLinks,
            channel: params.channel,
            peerId,
          });
    if (linkedPeerId) peerId = linkedPeerId;
    peerId = peerId.toLowerCase();
    if (dmScope === 'per-channel-peer' && peerId) {
      const channel = (params.channel ?? '').trim().toLowerCase() || 'unknown';
      return `agent:${normalizeAgentId(params.agentId)}:${channel}:dm:${peerId}`;
    }
    if (dmScope === 'per-peer' && peerId) {
      return `agent:${normalizeAgentId(params.agentId)}:dm:${peerId}`;
    }
    return buildAgentMainSessionKey({
      agentId: params.agentId,
      mainKey: params.mainKey,
    });
  }
  const channel = (params.channel ?? '').trim().toLowerCase() || 'unknown';
  const peerId = ((params.peerId ?? '').trim() || 'unknown').toLowerCase();
  return `agent:${normalizeAgentId(params.agentId)}:${channel}:${peerKind}:${peerId}`;
}

export function resolveThreadSessionKeys(params: {
  baseSessionKey: string;
  threadId?: string | null;
  parentSessionKey?: string;
  useSuffix?: boolean;
}): { sessionKey: string; parentSessionKey?: string } {
  const threadId = (params.threadId ?? '').trim();
  if (!threadId) {
    return { sessionKey: params.baseSessionKey, parentSessionKey: undefined };
  }
  const normalizedThreadId = threadId.toLowerCase();
  const useSuffix = params.useSuffix ?? true;
  const sessionKey = useSuffix
    ? `${params.baseSessionKey}:thread:${normalizedThreadId}`
    : params.baseSessionKey;
  return { sessionKey, parentSessionKey: params.parentSessionKey };
}
