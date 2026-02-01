/**
 * Agent Reflector
 *
 * Performs reflection after tool execution to update hypotheses and assumptions.
 */

import { randomUUID } from 'node:crypto';

import type { LlmClient, ChatMessage } from '../../core/llm.js';
import type {
  Reflection,
  ReflectionState,
  ToolExecutionContext,
  Hypothesis,
  Assumption,
} from './types.js';

/**
 * System prompt for the reflector.
 */
const REFLECTOR_SYSTEM_PROMPT = `You are a reflection agent for a mentat-style analyst.

After each tool execution, you analyze the results and update the agent's beliefs.

## Your Tasks

1. **Update Hypotheses**: Based on the tool result, strengthen or weaken hypotheses.
2. **Check Assumptions**: Identify if any assumptions were validated or violated.
3. **Extract Information**: Note any new information learned.
4. **Suggest Next Steps**: Recommend what to do next.
5. **Assess Confidence**: How does this result affect overall confidence?

## Response Format

Respond with a JSON object:
{
  "hypothesisUpdates": [
    { "id": "existing-id-or-new", "statement": "...", "confidence": "low|medium|high", "change": "strengthened|weakened|unchanged|new" }
  ],
  "assumptionUpdates": [
    { "id": "existing-id-or-new", "statement": "...", "validated": true, "violated": false }
  ],
  "confidenceChange": 0.1,  // -1 to 1
  "newInformation": ["list of new facts learned"],
  "nextStep": "suggested next action",
  "suggestRevision": false,
  "revisionReason": null
}`;

/**
 * Reflect on a tool execution and update state.
 */
export async function reflect(
  llm: LlmClient,
  state: ReflectionState,
  toolExecution: ToolExecutionContext
): Promise<Reflection> {
  const userPrompt = buildReflectionPrompt(state, toolExecution);

  const messages: ChatMessage[] = [
    { role: 'system', content: REFLECTOR_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];

  const response = await llm.complete(messages, { temperature: 0.2 });
  const reflection = parseReflectionResponse(response.content, state);

  return reflection;
}

/**
 * Build the user prompt for reflection.
 */
function buildReflectionPrompt(
  state: ReflectionState,
  toolExecution: ToolExecutionContext
): string {
  const sections: string[] = [];

  sections.push(`## Tool Execution
Tool: ${toolExecution.toolName}
Success: ${toolExecution.success}
Duration: ${toolExecution.durationMs}ms

Input:
${JSON.stringify(toolExecution.input, null, 2)}

Result:
${JSON.stringify(toolExecution.result, null, 2)}`);

  if (state.hypotheses.length > 0) {
    sections.push(`## Current Hypotheses
${state.hypotheses.map((h) => `- [${h.confidence}] ${h.statement}`).join('\n')}`);
  }

  if (state.assumptions.length > 0) {
    sections.push(`## Current Assumptions
${state.assumptions.map((a) => `- [${a.validated ? 'validated' : 'unvalidated'}] ${a.statement}`).join('\n')}`);
  }

  sections.push(`## Current Confidence: ${(state.confidence * 100).toFixed(0)}%`);

  sections.push('\nAnalyze this tool result and provide your reflection.');

  return sections.join('\n\n');
}

/**
 * Parse the LLM response into a Reflection.
 */
function parseReflectionResponse(content: string, state: ReflectionState): Reflection {
  const now = new Date().toISOString();

  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in response');
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      hypothesisUpdates?: Array<{
        id?: string;
        statement?: string;
        confidence?: string;
        change?: string;
      }>;
      assumptionUpdates?: Array<{
        id?: string;
        statement?: string;
        validated?: boolean;
        violated?: boolean;
      }>;
      confidenceChange?: number;
      newInformation?: string[];
      nextStep?: string;
      suggestRevision?: boolean;
      revisionReason?: string;
    };

    // Process hypothesis updates
    const updatedHypotheses: Hypothesis[] = [...state.hypotheses];
    for (const update of parsed.hypothesisUpdates ?? []) {
      const existingIndex = updatedHypotheses.findIndex((h) => h.id === update.id);
      if (existingIndex >= 0 && update.statement) {
        const existing = updatedHypotheses[existingIndex];
        if (!existing) {
          continue;
        }
        // Update existing
        updatedHypotheses[existingIndex] = {
          ...existing,
          statement: update.statement,
          confidence: (update.confidence as Hypothesis['confidence']) ?? existing.confidence,
          updatedAt: now,
        };
      } else if (update.statement && update.change === 'new') {
        // Add new hypothesis
        updatedHypotheses.push({
          id: update.id ?? randomUUID(),
          statement: update.statement,
          confidence: (update.confidence as Hypothesis['confidence']) ?? 'medium',
          supporting: [],
          contradicting: [],
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    // Process assumption updates
    const updatedAssumptions: Assumption[] = [...state.assumptions];
    for (const update of parsed.assumptionUpdates ?? []) {
      const existingIndex = updatedAssumptions.findIndex((a) => a.id === update.id);
      if (existingIndex >= 0) {
        const existing = updatedAssumptions[existingIndex];
        if (!existing) {
          continue;
        }
        // Update existing
        updatedAssumptions[existingIndex] = {
          ...existing,
          validated: update.validated ?? existing.validated,
        };
      } else if (update.statement) {
        // Add new assumption
        updatedAssumptions.push({
          id: update.id ?? randomUUID(),
          statement: update.statement,
          criticality: 'medium',
          validated: update.validated ?? false,
          createdAt: now,
        });
      }
    }

    return {
      updatedHypotheses,
      updatedAssumptions,
      confidenceChange: parsed.confidenceChange ?? 0,
      nextStep: parsed.nextStep,
      suggestRevision: parsed.suggestRevision ?? false,
      revisionReason: parsed.revisionReason,
      newInformation: parsed.newInformation ?? [],
      timestamp: now,
    };
  } catch {
    // Return minimal reflection on parse failure
    return {
      updatedHypotheses: state.hypotheses,
      updatedAssumptions: state.assumptions,
      confidenceChange: 0,
      suggestRevision: false,
      newInformation: [],
      timestamp: now,
    };
  }
}

/**
 * Create an initial reflection state.
 */
export function createReflectionState(): ReflectionState {
  return {
    hypotheses: [],
    assumptions: [],
    confidence: 0.5,
    toolExecutions: [],
  };
}

/**
 * Apply a reflection to update the state.
 */
export function applyReflection(
  state: ReflectionState,
  reflection: Reflection,
  toolExecution: ToolExecutionContext
): ReflectionState {
  const newConfidence = Math.max(0, Math.min(1, state.confidence + reflection.confidenceChange));

  return {
    hypotheses: reflection.updatedHypotheses,
    assumptions: reflection.updatedAssumptions,
    confidence: newConfidence,
    toolExecutions: [...state.toolExecutions, toolExecution],
  };
}

/**
 * Add an initial hypothesis.
 */
export function addHypothesis(
  state: ReflectionState,
  statement: string,
  confidence: Hypothesis['confidence'] = 'medium'
): ReflectionState {
  const now = new Date().toISOString();
  const hypothesis: Hypothesis = {
    id: randomUUID(),
    statement,
    confidence,
    supporting: [],
    contradicting: [],
    createdAt: now,
    updatedAt: now,
  };

  return {
    ...state,
    hypotheses: [...state.hypotheses, hypothesis],
  };
}

/**
 * Add an initial assumption.
 */
export function addAssumption(
  state: ReflectionState,
  statement: string,
  criticality: Assumption['criticality'] = 'medium',
  falsifier?: string
): ReflectionState {
  const now = new Date().toISOString();
  const assumption: Assumption = {
    id: randomUUID(),
    statement,
    criticality,
    falsifier,
    validated: false,
    createdAt: now,
  };

  return {
    ...state,
    assumptions: [...state.assumptions, assumption],
  };
}
