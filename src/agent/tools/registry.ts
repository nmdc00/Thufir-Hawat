/**
 * Tool Registry
 *
 * Central registry for all agent tools with caching and execution tracking.
 */

import { createHash } from 'node:crypto';

import type {
  ToolDefinition,
  ToolResult,
  ToolContext,
  ToolExecution,
  ToolCacheEntry,
  ListToolsOptions,
  LlmToolSchema,
  ToolCategory,
} from './types.js';

/**
 * Default cache TTL for read-only tools (30 seconds).
 */
const DEFAULT_CACHE_TTL_MS = 30_000;

/**
 * Agent Tool Registry
 *
 * Manages tool registration, execution, and caching.
 */
export class AgentToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();
  private cache: Map<string, ToolCacheEntry> = new Map();
  private executionHistory: ToolExecution[] = [];

  /**
   * Register a tool with the registry.
   */
  register<TInput>(tool: ToolDefinition<TInput>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool as ToolDefinition);
  }

  /**
   * Register multiple tools at once.
   */
  registerAll(tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /**
   * Get a tool by name.
   */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * Check if a tool exists.
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * List tools with optional filtering.
   */
  list(options?: ListToolsOptions): ToolDefinition[] {
    let tools = Array.from(this.tools.values());

    if (options?.category) {
      tools = tools.filter((t) => t.category === options.category);
    }

    if (options?.readOnly) {
      tools = tools.filter((t) => !t.sideEffects);
    }

    if (options?.noConfirmation) {
      tools = tools.filter((t) => !t.requiresConfirmation);
    }

    return tools;
  }

  /**
   * List tool names.
   */
  listNames(options?: ListToolsOptions): string[] {
    return this.list(options).map((t) => t.name);
  }

  /**
   * Get tools by category.
   */
  byCategory(category: ToolCategory): ToolDefinition[] {
    return this.list({ category });
  }

  /**
   * Execute a tool with caching and tracking.
   */
  async execute(
    name: string,
    input: unknown,
    ctx: ToolContext
  ): Promise<ToolExecution> {
    const tool = this.tools.get(name);
    if (!tool) {
      const execution: ToolExecution = {
        toolName: name,
        input,
        result: { success: false, error: `Unknown tool: ${name}` },
        timestamp: new Date().toISOString(),
        durationMs: 0,
        cached: false,
      };
      this.executionHistory.push(execution);
      return execution;
    }

    // Check cache for read-only tools
    const cacheKey = this.getCacheKey(name, input);
    if (!tool.sideEffects && tool.cacheTtlMs > 0) {
      const cached = this.getFromCache(cacheKey, tool.cacheTtlMs);
      if (cached) {
        const execution: ToolExecution = {
          toolName: name,
          input,
          result: cached,
          timestamp: new Date().toISOString(),
          durationMs: 0,
          cached: true,
        };
        this.executionHistory.push(execution);
        return execution;
      }
    }

    // Validate input
    const parseResult = tool.schema.safeParse(input);
    if (!parseResult.success) {
      const execution: ToolExecution = {
        toolName: name,
        input,
        result: {
          success: false,
          error: `Invalid input: ${parseResult.error.message}`,
        },
        timestamp: new Date().toISOString(),
        durationMs: 0,
        cached: false,
      };
      this.executionHistory.push(execution);
      return execution;
    }

    // Execute tool
    const startTime = Date.now();
    let result: ToolResult;

    try {
      result = await tool.execute(parseResult.data, ctx);
    } catch (error) {
      result = {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }

    const durationMs = Date.now() - startTime;

    // Cache successful results for read-only tools
    if (result.success && !tool.sideEffects && tool.cacheTtlMs > 0) {
      this.setCache(cacheKey, result);
    }

    const execution: ToolExecution = {
      toolName: name,
      input,
      result,
      timestamp: new Date().toISOString(),
      durationMs,
      cached: false,
    };

    this.executionHistory.push(execution);
    return execution;
  }

  /**
   * Get execution history.
   */
  getHistory(limit?: number): ToolExecution[] {
    if (limit) {
      return this.executionHistory.slice(-limit);
    }
    return [...this.executionHistory];
  }

  /**
   * Clear execution history.
   */
  clearHistory(): void {
    this.executionHistory = [];
  }

  /**
   * Get tool schemas for LLM tool calling.
   */
  getLlmSchemas(options?: ListToolsOptions): LlmToolSchema[] {
    return this.list(options).map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: this.zodToJsonSchema(tool.schema),
    }));
  }

  /**
   * Clear the cache.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics.
   */
  getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }

  /**
   * Generate a cache key from tool name and input.
   */
  private getCacheKey(name: string, input: unknown): string {
    const inputHash = createHash('sha256')
      .update(JSON.stringify(input))
      .digest('hex')
      .slice(0, 16);
    return `${name}:${inputHash}`;
  }

  /**
   * Get a result from cache if valid.
   */
  private getFromCache(key: string, ttlMs: number): ToolResult | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    const age = Date.now() - entry.cachedAt;
    if (age > ttlMs) {
      this.cache.delete(key);
      return null;
    }

    return entry.result;
  }

  /**
   * Store a result in cache.
   */
  private setCache(key: string, result: ToolResult): void {
    this.cache.set(key, {
      result,
      cachedAt: Date.now(),
      key,
    });
  }

  /**
   * Convert a Zod schema to JSON Schema (simplified).
   */
  private zodToJsonSchema(schema: unknown): LlmToolSchema['input_schema'] {
    // This is a simplified conversion
    // In production, use zod-to-json-schema
    try {
      const zodSchema = schema as { _def?: { shape?: () => Record<string, unknown> } };
      if (zodSchema._def?.shape) {
        const shape = zodSchema._def.shape();
        const properties: Record<string, unknown> = {};
        const required: string[] = [];

        for (const [key, value] of Object.entries(shape)) {
          const field = value as {
            _def?: {
              typeName?: string;
              description?: string;
              innerType?: { _def?: { typeName?: string } };
            };
            isOptional?: () => boolean;
          };

          // Determine if required
          const isOptional = field._def?.typeName === 'ZodOptional';
          if (!isOptional) {
            required.push(key);
          }

          // Get inner type for optional fields
          const innerDef = isOptional ? field._def?.innerType?._def : field._def;
          const typeName = innerDef?.typeName ?? 'ZodString';

          properties[key] = {
            type: this.zodTypeToJsonType(typeName),
            description: field._def?.description,
          };
        }

        return {
          type: 'object',
          properties,
          required,
        };
      }
    } catch {
      // Fallback to empty schema
    }

    return {
      type: 'object',
      properties: {},
      required: [],
    };
  }

  /**
   * Map Zod type names to JSON Schema types.
   */
  private zodTypeToJsonType(typeName: string): string {
    const mapping: Record<string, string> = {
      ZodString: 'string',
      ZodNumber: 'number',
      ZodBoolean: 'boolean',
      ZodArray: 'array',
      ZodObject: 'object',
    };
    return mapping[typeName] ?? 'string';
  }
}

/**
 * Create a pre-configured registry with default cache settings.
 */
export function createToolRegistry(): AgentToolRegistry {
  return new AgentToolRegistry();
}

/**
 * Default cache TTL for reference.
 */
export { DEFAULT_CACHE_TTL_MS };
