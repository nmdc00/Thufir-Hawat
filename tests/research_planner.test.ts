import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/intel/store.js', () => ({
  searchIntel: () => [],
  listIntelByIds: () => [],
}));

import { createResearchPlan, runResearchPlan } from '../src/core/research_planner.js';
import { ToolRegistry } from '../src/core/tools.js';

const fakeLlm = (content: string) => ({
  complete: async () => ({ content, model: 'test' }),
});

describe('research planner', () => {
  it('parses a JSON plan from the LLM', async () => {
    const llm = fakeLlm(
      JSON.stringify({
        steps: [
          { action: 'intel.search', query: 'test' },
          { action: 'calibration.get' },
        ],
      })
    );
    const plan = await createResearchPlan({ llm: llm as any, subject: 'Test market' });
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]?.action).toBe('intel.search');
  });

  it('falls back to defaults on invalid output', async () => {
    const llm = fakeLlm('not json');
    const plan = await createResearchPlan({ llm: llm as any, subject: 'Test market', maxSteps: 3 });
    expect(plan.steps.length).toBe(3);
  });

  it('executes via tool registry', async () => {
    const plan = { steps: [{ action: 'intel.search', query: 'abc' }] };
    const tools = new ToolRegistry();
    const result = await runResearchPlan({
      config: {
        intel: { sources: {} },
      } as any,
      marketClient: {} as any,
      subject: { question: 'Test' },
      plan,
      tools,
    });
    expect(result.context).toContain('Intel search');
  });
});
