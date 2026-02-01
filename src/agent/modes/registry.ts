/**
 * Mode Registry
 *
 * Mode detection and configuration lookup.
 */

import type { AgentMode, ModeConfig, ModeDetectionResult } from './types.js';
import { chatMode } from './chat.js';
import { tradeMode } from './trade.js';
import { mentatMode } from './mentat.js';

/**
 * All available mode configurations.
 */
const MODE_CONFIGS: Record<AgentMode, ModeConfig> = {
  chat: chatMode,
  trade: tradeMode,
  mentat: mentatMode,
};

/**
 * Get the configuration for a mode.
 */
export function getModeConfig(mode: AgentMode): ModeConfig {
  return MODE_CONFIGS[mode];
}

/**
 * List all available modes.
 */
export function listModes(): ModeConfig[] {
  return Object.values(MODE_CONFIGS);
}

/**
 * Patterns that indicate trade intent.
 */
const TRADE_PATTERNS = [
  /\b(buy|sell|trade|bet|place)\b.*\b(yes|no)\b/i,
  /\b(yes|no)\b.*\b(buy|sell|trade|bet|place)\b/i,
  /\b(place|execute|make)\s+(a\s+)?(bet|trade|order)\b/i,
  /\b(bet|wager|trade)\s+\$?\d+/i,
  /\$\d+.*\b(on|yes|no)\b/i,
  /\bgo\s+(long|short)\b/i,
  /\btake\s+(a\s+)?position\b/i,
];

/**
 * Patterns that indicate mentat/analysis intent.
 */
const MENTAT_PATTERNS = [
  /\b(analyze|analysis|deep\s*dive|research)\b/i,
  /\b(fragility|risk|tail\s*risk)\b.*\b(analysis|report|assess)\b/i,
  /\bfull\s+(analysis|breakdown|report)\b/i,
  /\b(comprehensive|thorough|detailed)\s+(analysis|look|review)\b/i,
  /\bwhat.*(risks?|dangers?|could\s+go\s+wrong)\b/i,
  /\bmentat\s+mode\b/i,
  /\b(stress\s+test|scenario\s+analysis)\b/i,
  /\bblack\s*swan\b/i,
];

/**
 * Detect the appropriate mode from a user message.
 */
export function detectMode(message: string): ModeDetectionResult {
  const signals: string[] = [];
  let mode: AgentMode = 'chat';
  let confidence = 0.5;

  // Check for trade patterns
  for (const pattern of TRADE_PATTERNS) {
    if (pattern.test(message)) {
      signals.push(`trade pattern: ${pattern.source}`);
      mode = 'trade';
      confidence = 0.8;
      break;
    }
  }

  // Check for mentat patterns (can override trade for analysis)
  for (const pattern of MENTAT_PATTERNS) {
    if (pattern.test(message)) {
      signals.push(`mentat pattern: ${pattern.source}`);
      // Only override if not explicitly trading
      if (mode !== 'trade' || message.toLowerCase().includes('analyze')) {
        mode = 'mentat';
        confidence = 0.8;
      }
      break;
    }
  }

  // Check for explicit mode requests
  if (/\b(chat\s+mode|just\s+chat|casual)\b/i.test(message)) {
    signals.push('explicit chat mode');
    mode = 'chat';
    confidence = 0.95;
  }

  if (/\b(trade\s+mode|trading\s+mode)\b/i.test(message)) {
    signals.push('explicit trade mode');
    mode = 'trade';
    confidence = 0.95;
  }

  if (/\b(mentat\s+mode|analysis\s+mode|deep\s+mode)\b/i.test(message)) {
    signals.push('explicit mentat mode');
    mode = 'mentat';
    confidence = 0.95;
  }

  if (signals.length === 0) {
    signals.push('default: no specific mode detected');
  }

  return {
    mode,
    confidence,
    signals,
  };
}

/**
 * Check if a tool is allowed in a mode.
 */
export function isToolAllowed(mode: AgentMode, toolName: string): boolean {
  const config = getModeConfig(mode);
  return config.allowedTools.includes(toolName);
}

/**
 * Get allowed tools for a mode.
 */
export function getAllowedTools(mode: AgentMode): string[] {
  return getModeConfig(mode).allowedTools;
}

// Re-export types
export type { AgentMode, ModeConfig, ModeDetectionResult };
