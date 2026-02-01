# Orchestrator Architecture

Last updated: 2026-02-01

Split model architecture where Claude handles reasoning/orchestration and GPT handles execution/implementation.

## Rationale

| Model | Strengths | Weaknesses |
|-------|-----------|------------|
| Claude | Superior reasoning, nuanced analysis, long context | Stricter rate limits, higher cost |
| GPT | Fast, generous rate limits, good tool execution | Less nuanced reasoning |

**Current approach**: Claude does everything, GPT only on rate limit errors.
**Problem**: Wastes Claude calls on grunt work (tool execution, data gathering).

## Implemented Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        USER REQUEST                              │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                    CLAUDE (Orchestrator)                         │
│  ─────────────────────────────────────────────────────────────  │
│  • Parse user intent                                             │
│  • Analyze context and history                                   │
│  • Decide strategy / plan approach                               │
│  • Determine which tools are needed                              │
│  • Generate tool call specifications                             │
│                                                                  │
│  Output: Execution plan with tool calls                          │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                      GPT (Executor)                              │
│  ─────────────────────────────────────────────────────────────  │
│  • Execute tool calls (market data, intel fetch, etc.)           │
│  • Gather and structure results                                  │
│  • Handle retries and errors                                     │
│  • Aggregate multi-tool outputs                                  │
│                                                                  │
│  Output: Structured tool results                                 │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                    CLAUDE (Synthesizer)                          │
│  ─────────────────────────────────────────────────────────────  │
│  • Analyze tool results                                          │
│  • Apply reasoning and judgment                                  │
│  • Generate predictions / recommendations                        │
│  • Craft final response to user                                  │
│                                                                  │
│  Output: Final response                                          │
└─────────────────────────────────────────────────────────────────┘
```

## Example Flow: Market Analysis

**User**: "What do you think about the Fed rate decision market?"

### Step 1: Claude Orchestrates

```json
{
  "intent": "market_analysis",
  "market_query": "Fed rate decision",
  "execution_plan": [
    {
      "tool": "search_markets",
      "params": { "query": "Fed rate decision" }
    },
    {
      "tool": "get_market_details",
      "params": { "market_id": "$search_result[0].id" }
    },
    {
      "tool": "fetch_intel",
      "params": { "keywords": ["Fed", "interest rate", "FOMC"] }
    },
    {
      "tool": "get_calibration",
      "params": { "domain": "economics" }
    }
  ]
}
```

### Step 2: GPT Executes

GPT runs all tool calls, handling:
- API calls to Polymarket
- Intel fetching from configured sources
- Database queries for calibration data
- Error handling and retries

Returns structured results:
```json
{
  "market": { "id": "...", "title": "Fed holds rates March 2026", "price": 0.72 },
  "orderbook": { "bids": [...], "asks": [...] },
  "intel": [
    { "title": "Fed signals patience on rates", "source": "Reuters", "sentiment": 0.1 },
    { "title": "Inflation cooling faster than expected", "source": "WSJ", "sentiment": 0.3 }
  ],
  "calibration": { "domain": "economics", "accuracy": 0.68, "brier": 0.21 }
}
```

### Step 3: Claude Synthesizes

Claude receives the structured data and:
- Weighs the intel signals
- Forms probability estimate
- Adjusts for calibration history
- Identifies key uncertainties
- Generates nuanced response

**Output**:
> The Fed rate decision market (hold in March) is at 72% YES.
>
> Based on recent intel, I estimate 68% probability of a hold. Key factors:
> - Inflation data trending down (supports hold)
> - Labor market still tight (supports hike)
> - Fed rhetoric emphasizing patience
>
> Your historical accuracy on economics: 68%. Slight edge shorting at current price, but low confidence given mixed signals.

## Implementation

### Config Options (Current)

```yaml
agent:
  model: claude-sonnet-4-5-20251101      # Orchestrator/synthesizer
  executorModel: gpt-5.2                  # Executor
  executorProvider: openai

  # Optional: use same model for both (current behavior)
  useExecutorModel: false                 # Enable split architecture
  useOrchestrator: false                  # Enable agentic loop in src/agent/
  showToolTrace: false                    # Append tool trace to chat responses
  showCriticNotes: false                  # Append critic notes to chat responses
  showPlanTrace: false                    # Append plan trace to chat responses
  mentatAutoScan: false                   # Auto-run mentat scan/report in chat + daily report + autonomous P&L
  mentatSystem: Polymarket                # System label for mentat reports
  identityPromptMode: full                # full | minimal | none (identity prelude)
  internalPromptMode: minimal             # full | minimal | none (internal LLM calls)
  # Mentat monitoring/alerts (gateway)
  # notifications.mentat.enabled: true
  # Clawdbot-style heartbeats (gateway)
  # notifications.heartbeat.enabled: true
  # Proactive search can be scheduled or heartbeat-driven
  # notifications.proactiveSearch.mode: "schedule" | "heartbeat" | "direct"
  # CLI: `thufir intel proactive --send` sends direct summaries

Note: `identityPromptMode: none` minimizes tokens but disables identity injection in user-facing prompts.
```

### New Classes

```typescript
interface ExecutionPlan {
  intent: string;
  toolCalls: ToolCallSpec[];
  context?: Record<string, unknown>;
}

interface ToolCallSpec {
  tool: string;
  params: Record<string, unknown>;
  dependsOn?: string[];  // For sequential execution
}

class OrchestratorClient implements LlmClient {
  private orchestrator: LlmClient;  // Claude
  private executor: LlmClient;      // GPT

  async complete(messages: ChatMessage[]): Promise<LlmResponse> {
    // 1. Claude plans
    const plan = await this.orchestrator.complete([
      ...messages,
      { role: 'system', content: ORCHESTRATOR_PROMPT }
    ]);

    // 2. GPT executes
    const results = await this.executeToolCalls(plan);

    // 3. Claude synthesizes
    return this.orchestrator.complete([
      ...messages,
      { role: 'assistant', content: `Execution results: ${JSON.stringify(results)}` },
      { role: 'system', content: SYNTHESIZER_PROMPT }
    ]);
  }
}
```

### Prompts

**Orchestrator Prompt** (Claude):
```
You are a planning agent. Analyze the user's request and create an execution plan.

Output a JSON execution plan with:
- intent: What the user wants
- toolCalls: Array of tool calls needed (in order)

Available tools: [tool list]

Do NOT execute tools yourself. Only plan which tools are needed and in what order.
```

**Synthesizer Prompt** (Claude):
```
You are a synthesis agent. The executor has gathered the following data:
[results]

Analyze this data and provide a thoughtful response to the user's original request.
Apply your reasoning to draw conclusions, not just summarize the data.
```

## API Call Comparison

### Current (Claude-only)

| Action | Claude Calls | GPT Calls |
|--------|--------------|-----------|
| Market analysis | 3-5 (with tools) | 0 |
| Trade execution | 2-4 | 0 |
| Daily scan | 10-20 | 0 |

### Orchestrator Pattern

| Action | Claude Calls | GPT Calls |
|--------|--------------|-----------|
| Market analysis | 2 (plan + synth) | 1-3 (execution) |
| Trade execution | 2 | 1-2 |
| Daily scan | 2-4 | 8-15 |

**Result**: ~60% reduction in Claude API calls for tool-heavy operations.

## When to Use Each Pattern

### Use Orchestrator Pattern
- Tool-heavy operations (market scans, intel gathering)
- Multi-step workflows
- Data aggregation tasks
- Autonomous operations

### Use Direct Claude
- Simple conversations
- Quick questions
- Tasks requiring single-turn reasoning
- When GPT executor would add latency without benefit

---

## Implementation Status (2026-02-01)

Implemented:

- Split-model plan/execute/synth client (`src/core/llm.ts` OrchestratorClient)
- Fallback to single-model execution when planning/execution fails
- Metrics for plan/executor/synth failure counts
- Agentic orchestrator loop (plan -> tool -> reflect -> critic) behind `agent.useOrchestrator`

Not yet implemented:

- User-visible plan/tool trace by default (optional via config)
- Multi-agent role split (Cartographer/Skeptic/Risk Officer)
- Automatic mentat report generation inside the orchestrator loop

## Migration Path

1. **Phase 1**: Add `useExecutorModel` config option (default: false)
2. **Phase 2**: Implement `OrchestratorClient` alongside existing clients
3. **Phase 3**: Migrate autonomous scan loop to orchestrator pattern
4. **Phase 4**: Enable for interactive queries (opt-in)
5. **Phase 5**: Make orchestrator default for tool-heavy operations

## Fallback Behavior

```
Claude (orchestrate) → fails → GPT orchestrates (degraded)
GPT (execute) → fails → Claude executes (expensive fallback)
Claude (synthesize) → fails → Return raw executor results
```

## Monitoring

Track metrics to validate the architecture:
- Claude API calls per operation (should decrease)
- Response quality (should maintain)
- Latency (may increase slightly due to multi-hop)
- Cost per operation (should decrease)

## References

- [Anthropic: Building effective agents](https://www.anthropic.com/research/building-effective-agents)
- [OpenAI: Function calling](https://platform.openai.com/docs/guides/function-calling)
