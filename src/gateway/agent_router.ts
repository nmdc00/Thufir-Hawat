import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ThufirConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';
import { ThufirAgent } from '../core/agent.js';

export type IncomingMessage = {
  channel: 'telegram' | 'whatsapp' | 'cli';
  senderId: string;
  peerKind?: 'dm' | 'group' | 'channel';
  threadId?: string;
};

type AgentOverride = NonNullable<ThufirConfig['agents']>['overrides'][string];

function normalizeToken(value: string | undefined | null): string {
  return (value ?? '').trim().toLowerCase();
}

function getBaseSessionsPath(config: ThufirConfig): string {
  return config.memory?.sessionsPath ?? join(homedir(), '.thufir', 'sessions');
}

function mergeConfig(
  base: ThufirConfig,
  override: AgentOverride | undefined,
  params: { agentId: string; isolateSessions: boolean }
): ThufirConfig {
  const sessionsPath = params.isolateSessions
    ? join(getBaseSessionsPath(base), 'agents', params.agentId)
    : base.memory?.sessionsPath;

  if (!override && !params.isolateSessions) return base;
  const agentOverride = override?.agent;
  const mergedAgent = {
    ...base.agent,
    ...(agentOverride ?? {}),
    trivial: {
      ...base.agent.trivial,
      ...(agentOverride?.trivial ?? {}),
    },
    llmBudget: {
      ...base.agent.llmBudget,
      ...(agentOverride?.llmBudget ?? {}),
    },
  };
  return {
    ...base,
    agent: {
      ...mergedAgent,
    },
    memory: {
      ...base.memory,
      ...(override?.memory ?? {}),
      ...(sessionsPath ? { sessionsPath } : {}),
    },
    autonomy: {
      ...base.autonomy,
      ...(override?.autonomy ?? {}),
    },
  };
}

function routeMatches(
  route: NonNullable<ThufirConfig['agents']>['routes'][number],
  message: IncomingMessage
): boolean {
  if (route.channel && route.channel !== message.channel) {
    return false;
  }
  const peerKinds = route.peerKinds ?? [];
  if (peerKinds.length > 0) {
    const kind = message.peerKind ?? 'dm';
    if (!peerKinds.includes(kind)) {
      return false;
    }
  }
  const threadIds = route.threadIds ?? [];
  if (threadIds.length > 0) {
    const thread = normalizeToken(message.threadId);
    if (!thread || !threadIds.map((id) => normalizeToken(id)).includes(thread)) {
      return false;
    }
  }
  const peerIds = route.peerIds ?? [];
  if (peerIds.length > 0) {
    const peer = normalizeToken(message.senderId);
    const channel = normalizeToken(message.channel);
    const candidates = new Set<string>();
    if (peer) {
      candidates.add(peer);
      if (channel) {
        candidates.add(`${channel}:${peer}`);
      }
    }
    if (candidates.size === 0) {
      return false;
    }
    const match = peerIds.some((id) => candidates.has(normalizeToken(id)));
    if (!match) {
      return false;
    }
  }
  return true;
}

export function createAgentRegistry(config: ThufirConfig, logger: Logger) {
  const agentsConfig = config.agents;
  const routeList = agentsConfig?.routes ?? [];
  const defaultAgentId = agentsConfig?.defaultAgentId ?? 'main';
  const overrides = agentsConfig?.overrides ?? {};

  const agentIds = new Set<string>();
  agentIds.add(defaultAgentId);
  for (const id of agentsConfig?.agentIds ?? []) {
    agentIds.add(id);
  }
  for (const route of routeList) {
    agentIds.add(route.agentId);
  }
  if (agentIds.size === 0) {
    agentIds.add('main');
  }

  const agents = new Map<string, ThufirAgent>();
  const isolateSessions = agentIds.size > 1;
  for (const agentId of agentIds) {
    const merged = mergeConfig(config, overrides[agentId], { agentId, isolateSessions });
    const instance = new ThufirAgent(merged, logger);
    agents.set(agentId, instance);
  }

  const resolveAgentId = (message: IncomingMessage): string => {
    for (const route of routeList) {
      if (routeMatches(route, message)) {
        return route.agentId;
      }
    }
    return defaultAgentId;
  };

  const resolveAgent = (message: IncomingMessage): { agentId: string; agent: ThufirAgent } => {
    const agentId = resolveAgentId(message);
    const fallback = agents.get(defaultAgentId) ?? agents.values().next().value;
    if (!fallback) {
      throw new Error('No agents configured');
    }
    const agent = agents.get(agentId) ?? fallback;
    return { agentId, agent };
  };

  return {
    agents,
    defaultAgentId,
    resolveAgentId,
    resolveAgent,
  };
}
