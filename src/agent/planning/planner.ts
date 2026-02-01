/**
 * Agent Planner
 *
 * Creates and revises plans for achieving goals.
 */

import { randomUUID } from 'node:crypto';

import type { LlmClient, ChatMessage } from '../../core/llm.js';
import type { AgentIdentity } from '../identity/types.js';
import type {
  AgentPlan,
  PlanStep,
  PlanningContext,
  PlanCreationResult,
  PlanRevisionRequest,
  PlanRevisionResult,
} from './types.js';

/**
 * System prompt for the planner.
 */
const PLANNER_SYSTEM_PROMPT = `You are a planning agent for a mentat-style prediction market analyst.

Your job is to create execution plans that achieve the user's goal.

## Planning Rules

1. **Tool-First**: If the goal requires external information (prices, news, data), you MUST include tool calls.
2. **Decompose**: Break complex goals into clear, sequential steps.
3. **Be Specific**: Each step should have a clear action and expected outcome.
4. **Consider Dependencies**: Note when steps depend on each other.
5. **Track Assumptions**: Identify assumptions that could invalidate the plan.

## Response Format

Respond with a JSON object:
{
  "steps": [
    {
      "id": "1",
      "description": "What this step does",
      "requiresTool": true,
      "toolName": "tool_name_here",
      "toolInput": { "param": "value" },
      "dependsOn": []
    }
  ],
  "confidence": 0.8,
  "blockers": [],
  "reasoning": "Why this plan makes sense",
  "warnings": ["Any concerns or caveats"]
}

Available tools: {TOOLS}`;

/**
 * Create a plan for achieving a goal.
 */
export async function createPlan(
  llm: LlmClient,
  context: PlanningContext,
  identity?: AgentIdentity
): Promise<PlanCreationResult> {
  const systemPrompt = PLANNER_SYSTEM_PROMPT.replace(
    '{TOOLS}',
    context.availableTools.join(', ')
  );

  const userPrompt = buildPlanningPrompt(context);

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
  ];

  // Add identity context if available
  if (identity) {
    messages.push({
      role: 'system',
      content: `You are planning for ${identity.name}, a ${identity.role}. Apply these traits: ${identity.traits.join(', ')}.`,
    });
  }

  messages.push({ role: 'user', content: userPrompt });

  const response = await llm.complete(messages, { temperature: 0.3 });
  const parsed = parseplanResponse(response.content, context.goal);

  return parsed;
}

/**
 * Build the user prompt for planning.
 */
function buildPlanningPrompt(context: PlanningContext): string {
  const sections: string[] = [];

  sections.push(`## Goal\n${context.goal}`);

  if (context.memoryContext) {
    sections.push(`## Context\n${context.memoryContext}`);
  }

  if (context.assumptions && context.assumptions.length > 0) {
    sections.push(`## Current Assumptions\n${context.assumptions.map((a) => `- ${a}`).join('\n')}`);
  }

  if (context.hypotheses && context.hypotheses.length > 0) {
    sections.push(`## Current Hypotheses\n${context.hypotheses.map((h) => `- ${h}`).join('\n')}`);
  }

  sections.push('\nCreate a plan to achieve this goal.');

  return sections.join('\n\n');
}

/**
 * Parse the LLM response into a plan.
 */
function parseplanResponse(content: string, goal: string): PlanCreationResult {
  const now = new Date().toISOString();

  try {
    // Extract JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in response');
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      steps?: Array<{
        id?: string;
        description?: string;
        requiresTool?: boolean;
        toolName?: string;
        toolInput?: Record<string, unknown>;
        dependsOn?: string[];
      }>;
      confidence?: number;
      blockers?: string[];
      reasoning?: string;
      warnings?: string[];
    };

    const steps: PlanStep[] = (parsed.steps ?? []).map((step, index) => ({
      id: step.id ?? String(index + 1),
      description: step.description ?? 'Unknown step',
      requiresTool: step.requiresTool ?? false,
      toolName: step.toolName,
      toolInput: step.toolInput,
      status: 'pending',
      dependsOn: step.dependsOn,
    }));

    const plan: AgentPlan = {
      id: randomUUID(),
      goal,
      steps,
      complete: false,
      blockers: parsed.blockers ?? [],
      confidence: parsed.confidence ?? 0.5,
      createdAt: now,
      updatedAt: now,
      revisionCount: 0,
    };

    return {
      plan,
      reasoning: parsed.reasoning ?? 'No reasoning provided',
      warnings: parsed.warnings ?? [],
    };
  } catch (error) {
    // Return a minimal plan on parse failure
    const plan: AgentPlan = {
      id: randomUUID(),
      goal,
      steps: [
        {
          id: '1',
          description: 'Respond to the user based on available context',
          requiresTool: false,
          status: 'pending',
        },
      ],
      complete: false,
      blockers: ['Failed to parse plan from LLM response'],
      confidence: 0.3,
      createdAt: now,
      updatedAt: now,
      revisionCount: 0,
    };

    return {
      plan,
      reasoning: 'Plan parsing failed, using fallback',
      warnings: [`Parse error: ${error instanceof Error ? error.message : 'Unknown'}`],
    };
  }
}

/**
 * Revise an existing plan based on new information.
 */
export async function revisePlan(
  llm: LlmClient,
  request: PlanRevisionRequest
): Promise<PlanRevisionResult> {
  const systemPrompt = `You are revising an existing plan based on new information.

The plan needs revision because: ${request.reason}

Current plan:
${JSON.stringify(request.plan.steps, null, 2)}

${request.context ? `Additional context: ${request.context}` : ''}
${request.toolResult ? `Tool result that triggered revision: ${JSON.stringify(request.toolResult)}` : ''}

Respond with a JSON object:
{
  "steps": [/* updated steps */],
  "confidence": 0.7,
  "changes": ["list of changes made"]
}`;

  const response = await llm.complete(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Please revise the plan.' },
    ],
    { temperature: 0.3 }
  );

  const now = new Date().toISOString();

  try {
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in response');
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      steps?: Array<{
        id?: string;
        description?: string;
        requiresTool?: boolean;
        toolName?: string;
        toolInput?: Record<string, unknown>;
        dependsOn?: string[];
        status?: string;
      }>;
      confidence?: number;
      changes?: string[];
    };

    const steps: PlanStep[] = (parsed.steps ?? request.plan.steps).map((step, index) => ({
      id: step.id ?? String(index + 1),
      description: step.description ?? 'Unknown step',
      requiresTool: step.requiresTool ?? false,
      toolName: step.toolName,
      toolInput: step.toolInput,
      status: (step.status as PlanStep['status']) ?? 'pending',
      dependsOn: step.dependsOn,
    }));

    const revisedPlan: AgentPlan = {
      ...request.plan,
      steps,
      confidence: parsed.confidence ?? request.plan.confidence * 0.9,
      updatedAt: now,
      revisionCount: request.plan.revisionCount + 1,
    };

    return {
      plan: revisedPlan,
      changes: parsed.changes ?? ['Plan revised'],
      confidence: revisedPlan.confidence,
    };
  } catch {
    // Return original plan with reduced confidence on failure
    return {
      plan: {
        ...request.plan,
        confidence: request.plan.confidence * 0.8,
        updatedAt: now,
        revisionCount: request.plan.revisionCount + 1,
      },
      changes: ['Revision failed, continuing with original plan'],
      confidence: request.plan.confidence * 0.8,
    };
  }
}

/**
 * Get the next pending step from a plan.
 */
export function getNextStep(plan: AgentPlan): PlanStep | null {
  for (const step of plan.steps) {
    if (step.status === 'pending') {
      // Check dependencies
      if (step.dependsOn && step.dependsOn.length > 0) {
        const allDepsComplete = step.dependsOn.every((depId) => {
          const depStep = plan.steps.find((s) => s.id === depId);
          return depStep?.status === 'complete';
        });
        if (!allDepsComplete) {
          continue;
        }
      }
      return step;
    }
  }
  return null;
}

/**
 * Mark a step as complete.
 */
export function completeStep(plan: AgentPlan, stepId: string, result?: unknown): AgentPlan {
  const steps = plan.steps.map((step) => {
    if (step.id === stepId) {
      return { ...step, status: 'complete' as const, result };
    }
    return step;
  });

  const allComplete = steps.every((s) => s.status === 'complete' || s.status === 'skipped');

  return {
    ...plan,
    steps,
    complete: allComplete,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Mark a step as failed.
 */
export function failStep(plan: AgentPlan, stepId: string, error: string): AgentPlan {
  const steps = plan.steps.map((step) => {
    if (step.id === stepId) {
      return { ...step, status: 'failed' as const, error };
    }
    return step;
  });

  return {
    ...plan,
    steps,
    blockers: [...plan.blockers, `Step ${stepId} failed: ${error}`],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Check if a plan is actionable (has pending steps and no blockers).
 */
export function isPlanActionable(plan: AgentPlan): boolean {
  if (plan.complete) return false;
  if (plan.blockers.length > 0) return false;
  return getNextStep(plan) !== null;
}
