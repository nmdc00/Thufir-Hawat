/**
 * Agent Orchestrator
 *
 * Main loop that coordinates planning, tool execution, reflection, and synthesis.
 * Implements the mentat-style reasoning flow:
 *   goal -> memory -> plan -> (tool -> reflect)* -> synthesize -> critic -> result
 */

import type { ChatMessage } from '../../core/llm.js';
import type { PlanStep } from '../planning/types.js';
import type { CriticContext, TradeFragilityContext } from '../critic/types.js';
import type { ToolExecution } from '../tools/types.js';
import type {
  AgentState,
  OrchestratorContext,
  OrchestratorResult,
  OrchestratorOptions,
  SynthesisRequest,
} from './types.js';

import { detectMode, getModeConfig, getAllowedTools } from '../modes/registry.js';
import { createPlan, revisePlan, getNextStep, completeStep, failStep } from '../planning/planner.js';
import { reflect, createReflectionState, applyReflection } from '../reflection/reflector.js';
import { runCritic, shouldRunCritic } from '../critic/critic.js';
import { buildIdentityPrompt, buildMinimalIdentityPrompt } from '../identity/identity.js';
import type { QuickFragilityScan } from '../../mentat/scan.js';
import { recordDecisionAudit } from '../../memory/decision_audit.js';
import {
  createAgentState,
  updatePlan,
  addToolExecution,
  applyReflectionToState,
  setMemoryContext,
  incrementIteration,
  completeState,
  addWarning,
  addError,
  setPlan,
  shouldContinue,
  toToolExecutionContext,
} from './state.js';

function isDebugEnabled(): boolean {
  return (process.env.THUFIR_LOG_LEVEL ?? '').toLowerCase() === 'debug';
}

function debugLog(message: string, meta?: Record<string, unknown>): void {
  if (!isDebugEnabled()) {
    return;
  }
  if (meta) {
    console.debug(`[orchestrator] ${message}`, meta);
    return;
  }
  console.debug(`[orchestrator] ${message}`);
}

function enforceIdentityMarker(identity: { marker: string }, prompt: string): void {
  if (!isDebugEnabled()) {
    return;
  }
  if (!identity.marker || !prompt.includes(identity.marker)) {
    throw new Error('Identity marker missing in prompt');
  }
}

function resolveIdentityPrompt(
  identity: { name: string; role: string; marker: string },
  ctx: OrchestratorContext
): string {
  const toolCtx = ctx.toolContext as { config?: { agent?: { identityPromptMode?: string } } };
  const mode = toolCtx?.config?.agent?.identityPromptMode ?? 'full';
  if (mode === 'none') return '';
  if (mode === 'minimal') return buildMinimalIdentityPrompt(identity as any);
  return buildIdentityPrompt(identity as any);
}

/**
 * Retrieve relevant context from QMD knowledge base.
 * Uses hybrid search (BM25 + vector + LLM reranking) for best results.
 */
async function retrieveQmdContext(
  goal: string,
  ctx: OrchestratorContext
): Promise<string | null> {
  // Check if QMD is enabled via toolContext config
  const toolCtx = ctx.toolContext as { config?: { qmd?: { enabled?: boolean } } };
  if (!toolCtx?.config?.qmd?.enabled) {
    return null;
  }

  try {
    // Call qmd_query tool via registry
    const execution = await ctx.toolRegistry.execute(
      'qmd_query',
      {
        query: goal,
        mode: 'query', // Hybrid mode for best results
        limit: 5,
      },
      ctx.toolContext
    );

    if (!execution.result.success) {
      debugLog('QMD query failed', { error: (execution.result as { error?: string }).error });
      return null;
    }

    // Format QMD results for context
    const data = execution.result.data as {
      results?: unknown;
      raw?: string;
    };

    if (!data.results && !data.raw) {
      return null;
    }

    // Handle different result formats
    if (data.raw) {
      return data.raw;
    }

    const results = data.results as Array<{
      title?: string;
      content?: string;
      snippet?: string;
      path?: string;
      score?: number;
    }>;

    if (!Array.isArray(results) || results.length === 0) {
      return null;
    }

    // Format results as context
    const formatted = results
      .map((r, i) => {
        const title = r.title ?? r.path ?? `Result ${i + 1}`;
        const content = r.content ?? r.snippet ?? '';
        const score = r.score != null ? ` (relevance: ${r.score.toFixed(2)})` : '';
        return `### ${title}${score}\n${content.slice(0, 500)}${content.length > 500 ? '...' : ''}`;
      })
      .join('\n\n');

    debugLog('QMD context retrieved', { resultCount: results.length });
    return formatted;
  } catch (error) {
    debugLog('QMD retrieval error', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
    return null;
  }
}

/**
 * System prompt for synthesis.
 */
const SYNTHESIS_SYSTEM_PROMPT = `You are synthesizing a response for a mentat-style prediction market analyst.

Based on the tool results and analysis provided, generate a clear, actionable response.

## Rules

1. **Cite Evidence**: Reference specific tool results, not assumptions.
2. **State Confidence**: Be clear about certainty levels.
3. **Note Assumptions**: Explicitly state key assumptions.
4. **Identify Risks**: For trading recommendations, highlight tail risks.
5. **Be Concise**: Respect the user's time.

Respond directly to the user's goal. Do not explain your reasoning process unless asked.`;

/**
 * Run the orchestrator for a goal.
 */
export async function runOrchestrator(
  goal: string,
  ctx: OrchestratorContext,
  options?: OrchestratorOptions
): Promise<OrchestratorResult> {
  const startTime = Date.now();
  const startedAt = new Date().toISOString();

  if (isDebugEnabled()) {
    const cfg = (ctx.toolContext as { config?: { agent?: Record<string, unknown> } })?.config;
    const agent = cfg?.agent ?? {};
    debugLog('provider path', {
      provider: agent.provider,
      model: agent.model,
      executorProvider: agent.executorProvider,
      executorModel: agent.executorModel,
      openaiModel: agent.openaiModel,
      useExecutorModel: agent.useExecutorModel,
    });
  }

  const identityPromptForCheck = buildIdentityPrompt(ctx.identity);
  enforceIdentityMarker(ctx.identity, identityPromptForCheck);
  debugLog('identity marker present', { marker: ctx.identity.marker });

  // Phase 1: Mode Detection
  const modeResult = options?.forceMode
    ? { mode: options.forceMode, confidence: 1, signals: ['forced'] }
    : detectMode(goal);

  // Extract config from toolContext for mode configuration overrides
  const thufirConfig = ctx.toolContext?.config as import('../../core/config.js').ThufirConfig | undefined;
  const modeConfig = getModeConfig(modeResult.mode, thufirConfig);
  const maxIterations = options?.maxIterations ?? modeConfig.maxIterations;
  const canResumePlan = Boolean(
    options?.resumePlan && options?.initialPlan && options.initialPlan.goal === goal
  );
  const skipPlanning = options?.skipPlanning || canResumePlan;

  // Initialize state
  let state = createAgentState(goal, modeResult.mode, modeConfig, options);

  ctx.onUpdate?.(state);

  if (options?.resumePlan && options?.initialPlan) {
    if (!canResumePlan) {
      state = addWarning(state, 'Prior plan goal does not match current goal; starting fresh');
    } else {
      state = updatePlan(state, options.initialPlan, 'Resumed prior plan');
      ctx.onUpdate?.(state);
    }
  }

  // Phase 2: Memory Context (Memory-First Rule)
  const memoryParts: string[] = [];

  // 2a: Traditional memory system
  if (ctx.memorySystem) {
    try {
      const memoryContext = await ctx.memorySystem.getRelevantContext(goal);
      if (memoryContext) {
        memoryParts.push('## Session Memory\n' + memoryContext);
      }
    } catch (error) {
      state = addWarning(
        state,
        `Memory retrieval failed: ${error instanceof Error ? error.message : 'Unknown'}`
      );
    }
  }

  // 2b: QMD knowledge base (if enabled)
  const qmdContext = await retrieveQmdContext(goal, ctx);
  if (qmdContext) {
    memoryParts.push('## Knowledge Base\n' + qmdContext);
  }

  // Combine memory sources
  if (memoryParts.length > 0) {
    state = setMemoryContext(state, memoryParts.join('\n\n'));
    ctx.onUpdate?.(state);
  }

  // Phase 3: Planning (unless skipped)
  if (!skipPlanning) {
    try {
      const allowedTools = getAllowedTools(modeResult.mode);
      const planResult = await createPlan(
        ctx.llm,
        {
          goal,
          availableTools: allowedTools,
          memoryContext: state.memoryContext ?? undefined,
          assumptions: state.assumptions.map((a) => a.statement),
          hypotheses: state.hypotheses.map((h) => h.statement),
        },
        ctx.identity
      );

      state = updatePlan(state, planResult.plan, planResult.reasoning);

      if (planResult.warnings.length > 0) {
        for (const warning of planResult.warnings) {
          state = addWarning(state, warning);
        }
      }

      ctx.onUpdate?.(state);
    } catch (error) {
      state = addError(
        state,
        `Planning failed: ${error instanceof Error ? error.message : 'Unknown'}`
      );
    }
  }

  // Phase 4: Execution Loop
  let reflectionState = createReflectionState();
  reflectionState = {
    ...reflectionState,
    hypotheses: state.hypotheses,
    assumptions: state.assumptions,
    confidence: state.confidence,
  };

  // Track fragility scan results for trades
  let tradeFragilityScan: QuickFragilityScan | null = null;

  while (shouldContinue(state).continue && state.iteration < maxIterations) {
    state = incrementIteration(state);
    ctx.onUpdate?.(state);

    // Get next step from plan
    const nextStep = state.plan ? getNextStep(state.plan) : null;

    if (!nextStep) {
      // No more steps - plan is complete or no plan
      if (state.plan && !state.plan.complete) {
        // Mark plan as complete
        state = setPlan(state, { ...state.plan, complete: true });
      }
      break;
    }

    // Execute tool if step requires it
    if (nextStep.requiresTool && nextStep.toolName) {
      // Run fragility scan before trade tools
      const isTradeToolStep =
        nextStep.toolName === 'place_bet' || nextStep.toolName === 'trade.place';
      if (isTradeToolStep && !tradeFragilityScan) {
        tradeFragilityScan = await runPreTradeFragilityScan(nextStep, ctx);
        if (tradeFragilityScan) {
          debugLog('pre-trade fragility scan', {
            marketId: tradeFragilityScan.marketId,
            fragilityScore: tradeFragilityScan.fragilityScore,
            riskSignals: tradeFragilityScan.riskSignals.length,
          });
        }
      }

      const execution = await executeToolStep(nextStep, state, ctx);
      state = addToolExecution(state, execution);

      // Update plan with step result
      if (execution.result.success) {
        state = setPlan(state, completeStep(state.plan!, nextStep.id, execution.result));
      } else {
        const failedResult = execution.result as { success: false; error: string };
        state = setPlan(state, failStep(state.plan!, nextStep.id, failedResult.error));
      }

      // Reflect on tool result
      const toolContext = toToolExecutionContext(execution);
      reflectionState = {
        ...reflectionState,
        hypotheses: state.hypotheses,
        assumptions: state.assumptions,
        confidence: state.confidence,
        toolExecutions: [...reflectionState.toolExecutions, toolContext],
      };

      try {
        const reflection = await reflect(ctx.llm, reflectionState, toolContext);
        state = applyReflectionToState(state, reflection);
        reflectionState = applyReflection(reflectionState, reflection, toolContext);

        // Check if reflection suggests plan revision
        if (reflection.suggestRevision && state.plan && state.plan.revisionCount < 3) {
          const revisionResult = await revisePlan(ctx.llm, {
            plan: state.plan,
            reason: 'tool_result_unexpected',
            context: reflection.revisionReason,
            toolResult: execution.result,
            triggerStepId: nextStep.id,
          });

          state = setPlan(state, revisionResult.plan);
          for (const change of revisionResult.changes) {
            state = addWarning(state, `Plan revised: ${change}`);
          }
        }
      } catch (error) {
        state = addWarning(
          state,
          `Reflection failed: ${error instanceof Error ? error.message : 'Unknown'}`
        );
      }

      ctx.onUpdate?.(state);
    } else {
      // Non-tool step - mark as complete
      state = setPlan(state, completeStep(state.plan!, nextStep.id));
      ctx.onUpdate?.(state);
    }

    // Check if plan is now complete
    if (state.plan?.complete) {
      break;
    }
  }

  // Phase 5: Synthesis
  const response = await synthesizeResponse(
    {
      goal,
      toolResults: state.toolExecutions,
      hypotheses: state.hypotheses,
      assumptions: state.assumptions,
      memoryContext: state.memoryContext,
      identity: ctx.identity,
      mode: state.mode,
    },
    ctx,
    options?.synthesisSystemPrompt
  );

  // Phase 6: Critic (if required)
  let criticResult = null;
  const tradeToolNames = new Set(['place_bet', 'trade.place']);
  const shouldCritic =
    !options?.skipCritic &&
    (modeConfig.requireCritic ||
      shouldRunCritic({
        mode: state.mode,
        involvesTrade: state.toolExecutions.some((t) => tradeToolNames.has(t.toolName)),
        toolCalls: state.toolExecutions.map((t) => ({ name: t.toolName })),
      }));

  if (shouldCritic) {
    try {
      // Build fragility context for critic if we have a scan
      const fragilityContext: TradeFragilityContext | undefined = tradeFragilityScan
        ? {
            fragilityScore: tradeFragilityScan.fragilityScore,
            riskSignals: tradeFragilityScan.riskSignals,
            fragilityCards: tradeFragilityScan.fragilityCards,
            stressedAssumptions: tradeFragilityScan.stressedAssumptions,
            falsifiers: tradeFragilityScan.falsifiers,
            detectors: tradeFragilityScan.detectors,
          }
        : undefined;

      const criticContext: CriticContext = {
        goal,
        response,
        toolCalls: state.toolExecutions.map((t) => ({
          name: t.toolName,
          input: t.input,
          result: t.result,
          success: t.result.success,
        })),
        assumptions: state.assumptions.map((a) => a.statement),
        hypotheses: state.hypotheses.map((h) => h.statement),
        mode: state.mode,
        involvesTrade: state.toolExecutions.some((t) => tradeToolNames.has(t.toolName)),
        fragility: fragilityContext,
      };

      criticResult = await runCritic(ctx.llm, criticContext);

      // If critic provided a revised response, use it
      const finalResponse = criticResult.revisedResponse ?? response;
      state = completeState(state, finalResponse, criticResult);
    } catch (error) {
      state = addWarning(
        state,
        `Critic failed: ${error instanceof Error ? error.message : 'Unknown'}`
      );
      state = completeState(state, response);
    }
  } else {
    state = completeState(state, response);
  }

  ctx.onUpdate?.(state);

  debugLog('iterations used', { iterations: state.iteration });
  debugLog('tools called', {
    tools: state.toolExecutions.map((t) => t.toolName),
  });

  // Build result
  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - startTime;

  // Build fragility summary if we ran a scan
  const fragilitySummary = tradeFragilityScan
    ? {
        fragilityScore: tradeFragilityScan.fragilityScore,
        riskSignalCount: tradeFragilityScan.riskSignals.length,
        fragilityCardCount: tradeFragilityScan.fragilityCards.length,
        topRiskSignals: tradeFragilityScan.riskSignals.slice(0, 3),
        highFragility: tradeFragilityScan.fragilityScore >= 0.6,
      }
    : undefined;

  if (state.mode === 'trade' || state.toolExecutions.some((t) => tradeToolNames.has(t.toolName))) {
    try {
      const tradeAudit = extractTradeAudit(state);
      recordDecisionAudit({
        source: 'orchestrator',
        sessionId: state.sessionId,
        mode: state.mode,
        goal,
        marketId: tradeAudit.marketId,
        predictionId: tradeAudit.predictionId,
        tradeAction: tradeAudit.tradeAction,
        tradeOutcome: tradeAudit.tradeOutcome,
        tradeAmount: tradeAudit.tradeAmount,
        confidence: state.confidence,
        edge: null,
        criticApproved: criticResult?.approved ?? null,
        criticIssues: criticResult?.issues?.map((issue) => ({
          type: issue.type,
          severity: issue.severity,
          description: issue.description,
        })),
        fragilityScore: tradeFragilityScan?.fragilityScore ?? null,
        toolCalls: state.toolExecutions.length,
        iterations: state.iteration,
        toolTrace: state.toolExecutions.map((t) => ({
          toolName: t.toolName,
          input: t.input,
          success: t.result.success,
        })),
        planTrace: state.plan,
      });
    } catch (error) {
      debugLog('decision audit failed', {
        error: error instanceof Error ? error.message : 'Unknown',
      });
    }
  }

  return {
    state,
    response: state.response!,
    success: !state.errors.some((e) => e.includes('fatal')),
    summary: {
      mode: state.mode,
      iterations: state.iteration,
      toolCalls: state.toolExecutions.length,
      planRevisions: state.plan?.revisionCount ?? 0,
      criticApproved: criticResult?.approved ?? null,
      confidence: state.confidence,
      fragility: fragilitySummary,
    },
    metadata: {
      startedAt,
      completedAt,
      durationMs,
    },
  };
}

function extractTradeAudit(state: AgentState): {
  marketId?: string;
  predictionId?: string;
  tradeAction?: string;
  tradeOutcome?: string;
  tradeAmount?: number;
} {
  const trade = state.toolExecutions.find(
    (t) => t.toolName === 'place_bet' || t.toolName === 'trade.place'
  );
  if (!trade) {
    return {};
  }

  const input = trade.input as Record<string, unknown> | undefined;
  const marketId =
    (input?.marketId as string | undefined) ??
    (input?.market_id as string | undefined) ??
    (input?.conditionId as string | undefined);
  const tradeOutcome = (input?.outcome as string | undefined)?.toUpperCase();
  const tradeAmount = input?.amount !== undefined ? Number(input?.amount) : undefined;

  let predictionId: string | undefined;
  if (trade.result.success) {
    const data = (trade.result as { success: true; data: Record<string, unknown> }).data;
    predictionId = data?.prediction_id ? String(data.prediction_id) : undefined;
  }

  return {
    marketId,
    predictionId,
    tradeAction: 'buy',
    tradeOutcome,
    tradeAmount,
  };
}

/**
 * Run pre-trade fragility scan if market client is available.
 */
async function runPreTradeFragilityScan(
  step: PlanStep,
  ctx: OrchestratorContext
): Promise<QuickFragilityScan | null> {
  // Extract market ID from tool input
  const input = step.toolInput as Record<string, unknown> | undefined;
  const marketId = input?.marketId ?? input?.market_id ?? input?.conditionId;

  if (!marketId || typeof marketId !== 'string') {
    debugLog('fragility scan skipped: no market ID in tool input');
    return null;
  }

  // Check if market client is available in tool context
  const toolCtx = ctx.toolContext as {
    marketClient?: { getMarket: (id: string) => Promise<unknown> };
    config?: { agent?: { enablePreTradeFragility?: boolean } };
  };

  // Check if pre-trade fragility is enabled (default: true for trade mode)
  const enablePreTradeFragility = toolCtx?.config?.agent?.enablePreTradeFragility !== false;
  if (!enablePreTradeFragility) {
    debugLog('fragility scan skipped: disabled in config');
    return null;
  }

  if (!toolCtx?.marketClient) {
    debugLog('fragility scan skipped: no market client available');
    return null;
  }

  try {
    // Dynamic import to avoid circular dependency
    const { runQuickFragilityScan } = await import('../../mentat/scan.js');

    const scan = await runQuickFragilityScan({
      marketId,
      marketClient: toolCtx.marketClient as Parameters<typeof runQuickFragilityScan>[0]['marketClient'],
      llm: ctx.llm,
      intelLimit: 10,
    });

    return scan;
  } catch (error) {
    debugLog('fragility scan failed', {
      error: error instanceof Error ? error.message : 'Unknown',
    });
    return null;
  }
}

/**
 * Execute a tool step with confirmation if needed.
 */
async function executeToolStep(
  step: PlanStep,
  _state: AgentState,
  ctx: OrchestratorContext
): Promise<ToolExecution> {
  const toolName = step.toolName!;
  const input = step.toolInput ?? {};

  // Check if tool requires confirmation
  const toolDef = ctx.toolRegistry.get?.(toolName);
  if (toolDef?.requiresConfirmation && ctx.onConfirmation) {
    const confirmed = await ctx.onConfirmation(
      `Execute ${toolName}?`,
      toolName,
      input
    );

    if (!confirmed) {
      return {
        toolName,
        input,
        result: { success: false, error: 'User declined' },
        timestamp: new Date().toISOString(),
        durationMs: 0,
        cached: false,
      };
    }
  }

  // Execute the tool
  const execution = await ctx.toolRegistry.execute(toolName, input, ctx.toolContext);
  debugLog('tool execution', {
    tool: toolName,
    success: execution.result.success,
    durationMs: execution.durationMs,
    cached: execution.cached,
  });
  return execution;
}

/**
 * Synthesize the final response from tool results and state.
 */
async function synthesizeResponse(
  request: SynthesisRequest,
  ctx: OrchestratorContext,
  systemPromptOverride?: string
): Promise<string> {
  const sections: string[] = [];

  // Build context section
  sections.push(`## Goal\n${request.goal}`);

  if (request.memoryContext) {
    sections.push(`## Relevant Context\n${request.memoryContext}`);
  }

  if (request.toolResults.length > 0) {
    const toolSection = request.toolResults
      .map((t) => {
        const status = t.result.success ? 'SUCCESS' : 'FAILED';
        let data: string;
        if (t.result.success) {
          data = JSON.stringify(t.result.data, null, 2);
        } else {
          const failedResult = t.result as { success: false; error: string };
          data = failedResult.error;
        }
        return `### ${t.toolName} [${status}]\n${data}`;
      })
      .join('\n\n');
    sections.push(`## Tool Results\n${toolSection}`);
  }

  if (request.hypotheses.length > 0) {
    const hypoSection = request.hypotheses
      .map((h) => `- [${h.confidence}] ${h.statement}`)
      .join('\n');
    sections.push(`## Current Hypotheses\n${hypoSection}`);
  }

  if (request.assumptions.length > 0) {
    const assumeSection = request.assumptions
      .map((a) => `- [${a.validated ? 'validated' : 'unvalidated'}] ${a.statement}`)
      .join('\n');
    sections.push(`## Assumptions\n${assumeSection}`);
  }

  sections.push('\nSynthesize a response to the user based on the above.');

  const identityPrompt = resolveIdentityPrompt(request.identity, ctx);

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPromptOverride ?? SYNTHESIS_SYSTEM_PROMPT },
    ...(identityPrompt ? [{ role: 'system', content: identityPrompt } as ChatMessage] : []),
    { role: 'user', content: sections.join('\n\n') },
  ];

  // Adjust temperature based on mode
  const temperature = request.mode === 'trade' ? 0.3 : 0.5;

  const response = await ctx.llm.complete(messages, { temperature });
  return response.content;
}

/**
 * Create an orchestrator instance with bound context.
 */
export function createOrchestrator(ctx: OrchestratorContext) {
  return {
    run: (goal: string, options?: OrchestratorOptions) =>
      runOrchestrator(goal, ctx, options),
    ctx,
  };
}

// Re-export types
export type {
  AgentState,
  OrchestratorContext,
  OrchestratorResult,
  OrchestratorOptions,
} from './types.js';
