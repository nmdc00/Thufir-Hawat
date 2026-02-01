/**
 * Agent Identity Loader
 *
 * Loads and manages the Thufir Hawat mentat identity from workspace files.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import type {
  AgentIdentity,
  IdentityConfig,
  IdentityLoadResult,
  IdentityPreludeLoadResult,
  BehavioralTrait,
} from './types.js';
import { THUFIR_TRAITS, IDENTITY_MARKER } from './types.js';

/**
 * Cached identity to avoid repeated file reads.
 */
let cachedIdentity: AgentIdentity | null = null;

/**
 * Clear the identity cache (useful for testing or hot reloading).
 */
export function clearIdentityCache(): void {
  cachedIdentity = null;
}

/**
 * Load the Thufir Hawat identity from workspace files.
 *
 * Looks for identity files in this order:
 * 1. Provided workspacePath
 * 2. ~/.thufir/
 * 3. ~/.thufir/ (backward compatibility)
 * 4. ./workspace/ (development)
 */
export function loadThufirIdentity(config?: IdentityConfig): IdentityLoadResult {
  if (cachedIdentity) {
    return {
      identity: cachedIdentity,
      filesLoaded: [],
      warnings: ['Using cached identity'],
    };
  }

  const workspacePaths = [
    config?.workspacePath?.replace('~', homedir()),
    join(homedir(), '.thufir'),
    join(homedir(), '.thufir'),
    join(process.cwd(), 'workspace'),
  ].filter(Boolean) as string[];

  const identityFiles = ['AGENTS.md', 'IDENTITY.md', 'SOUL.md', 'USER.md'];
  const rawContent: AgentIdentity['rawContent'] = {};
  const filesLoaded: string[] = [];
  const warnings: string[] = [];

  // Try each workspace path until we find files
  for (const workspacePath of workspacePaths) {
    if (!existsSync(workspacePath)) {
      continue;
    }

    for (const filename of identityFiles) {
      const filepath = join(workspacePath, filename);
      if (existsSync(filepath)) {
        try {
          const content = readFileSync(filepath, 'utf-8').trim();
          if (content) {
            const key = filename.replace('.md', '').toLowerCase() as keyof typeof rawContent;
            rawContent[key] = content;
            filesLoaded.push(filepath);
          }
        } catch (error) {
          warnings.push(`Failed to read ${filepath}: ${error}`);
        }
      }
    }

    // If we found any files in this workspace, stop looking
    if (filesLoaded.length > 0) {
      break;
    }
  }

  // Build identity from loaded content
  const identity = buildIdentityFromContent(rawContent, warnings);
  cachedIdentity = identity;

  return {
    identity,
    filesLoaded,
    warnings,
  };
}

/**
 * Build an AgentIdentity from raw content.
 */
function buildIdentityFromContent(
  rawContent: AgentIdentity['rawContent'],
  warnings: string[]
): AgentIdentity {
  // If no content loaded, use fallback
  if (!rawContent.agents && !rawContent.identity && !rawContent.soul && !rawContent.user) {
    warnings.push('No identity files found, using fallback identity');
    return createFallbackIdentity();
  }

  // Extract name from identity content
  const name = extractName(rawContent.identity) ?? 'Thufir Hawat';
  const role = extractRole(rawContent.identity) ?? 'Mentat risk and fragility analyst';

  return {
    name,
    role,
    traits: THUFIR_TRAITS,
    marker: IDENTITY_MARKER,
    rawContent,
  };
}

/**
 * Extract agent name from identity content.
 */
function extractName(content?: string): string | null {
  if (!content) return null;

  // Look for **Name:** pattern
  const nameMatch = content.match(/\*\*Name:\*\*\s*([^\n]+)/);
  if (nameMatch?.[1]) {
    return nameMatch[1].trim();
  }

  // Look for # Name header
  const headerMatch = content.match(/^#\s+([^\n]+)/m);
  if (headerMatch?.[1]) {
    return headerMatch[1].trim();
  }

  return null;
}

/**
 * Extract agent role from identity content.
 */
function extractRole(content?: string): string | null {
  if (!content) return null;

  // Look for **Role:** pattern
  const roleMatch = content.match(/\*\*Role:\*\*\s*([^\n]+)/);
  if (roleMatch?.[1]) {
    return roleMatch[1].trim();
  }

  return null;
}

/**
 * Create a fallback identity when no files are found.
 */
function createFallbackIdentity(): AgentIdentity {
  return {
    name: 'Thufir Hawat',
    role: 'Mentat risk and fragility analyst',
    traits: THUFIR_TRAITS,
    marker: IDENTITY_MARKER,
    rawContent: {},
  };
}

/**
 * Build a system prompt from the identity.
 *
 * This generates the identity portion of the system prompt,
 * including behavioral constraints and the identity marker.
 */
export function buildIdentityPrompt(identity: AgentIdentity): string {
  const sections: string[] = [];

  // Identity marker enforcement
  sections.push(`# ${identity.marker} Identity Enforcement

You ARE ${identity.name}. This is non-negotiable.
When asked who you are, respond as ${identity.name} - never as Claude, GPT, or any other AI.
Maintain this identity throughout the entire conversation.`);

  // Include raw content if available
  if (identity.rawContent.agents) {
    sections.push(identity.rawContent.agents);
  }

  if (identity.rawContent.identity) {
    sections.push(identity.rawContent.identity);
  }

  if (identity.rawContent.soul) {
    sections.push(identity.rawContent.soul);
  }

  if (identity.rawContent.user) {
    sections.push(identity.rawContent.user);
  }

  // Behavioral traits
  sections.push(buildTraitsSection(identity.traits));

  // Operating rules
  sections.push(buildOperatingRules());

  return sections.join('\n\n---\n\n');
}

/**
 * Build a minimal identity prompt (low-token).
 */
export function buildMinimalIdentityPrompt(identity: AgentIdentity): string {
  return `# ${identity.marker} Identity Enforcement\nYou ARE ${identity.name}. Role: ${identity.role}.`;
}

/**
 * Load the identity prelude (system prompt) for injection.
 */
export function loadIdentityPrelude(config?: IdentityConfig): IdentityPreludeLoadResult {
  const { identity, filesLoaded, warnings } = loadThufirIdentity(config);
  const mode = config?.promptMode ?? 'full';
  const prelude =
    mode === 'none'
      ? ''
      : mode === 'minimal'
        ? buildMinimalIdentityPrompt(identity)
        : buildIdentityPrompt(identity);
  return { prelude, identity, filesLoaded, warnings };
}

/**
 * Inject identity prelude into a message list if not already present.
 */
export function injectIdentity<T extends { role: string; content?: string | null }>(
  messages: T[],
  prelude: string
): T[] {
  if (!prelude) {
    return messages;
  }

  const alreadyInjected = messages.some((message) => {
    if (message.role !== 'system') return false;
    const content = typeof message.content === 'string' ? message.content : '';
    return content.includes(IDENTITY_MARKER);
  });

  if (alreadyInjected) {
    return messages;
  }

  const systemMessage = { role: 'system', content: prelude } as T;
  return [systemMessage, ...messages];
}

/**
 * Build the behavioral traits section.
 */
function buildTraitsSection(traits: BehavioralTrait[]): string {
  const traitDescriptions: Record<BehavioralTrait, string> = {
    'mechanism-first': 'Focus on causal mechanisms, not narratives. Ask "how does this work?" before "what does this mean?"',
    'tail-risk-awareness': 'Always consider extreme outcomes. What could go catastrophically wrong? What black swans lurk?',
    'assumption-tracking': 'Explicitly identify and track assumptions. State them clearly. Test them actively.',
    'falsifier-reporting': 'Actively seek disconfirming evidence. Report what could prove you wrong.',
    'low-narrative-trust': 'Be skeptical of compelling stories. Prefer data and mechanisms over narratives.',
    'tool-first': 'Never guess about external state. Use tools to get current data before making claims.',
  };

  const lines = ['## Behavioral Traits (Mentat Protocol)'];
  for (const trait of traits) {
    lines.push(`- **${trait}**: ${traitDescriptions[trait]}`);
  }

  return lines.join('\n');
}

/**
 * Build the operating rules section.
 */
function buildOperatingRules(): string {
  return `## Operating Rules

### Tool-First Rule
When a question depends on:
- Current events, news, or prices
- Positions or portfolio state
- External data or facts

You MUST call tools first. Guessing is a violation.

### Memory-First Rule
Before planning, retrieve relevant context:
- Semantic memory
- Recent sessions
- Relevant fragility cards
- Prior assumptions

### Assumption Discipline
- State assumptions explicitly
- Track which assumptions each conclusion depends on
- Update when evidence contradicts
- Report falsifiers prominently

### Calibration
- Express probabilities that reflect actual confidence
- Acknowledge uncertainty appropriately
- Update on new information
- Track prediction accuracy`;
}

/**
 * Get the identity for LLM calls (backward compatible with prior identity loader).
 *
 * This returns the combined identity prompt as a string,
 * matching the interface of the old identity loader function.
 */
export function getIdentityPrompt(config?: IdentityConfig): string {
  const { identity } = loadThufirIdentity(config);
  return buildIdentityPrompt(identity);
}
