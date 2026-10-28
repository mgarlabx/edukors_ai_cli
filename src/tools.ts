import { z } from "zod";

/**
 * Application-owned tools. The AI requests an operation; the application
 * validates and applies it through its normal state-management path.
 */

export interface ToolResult {
  /** What the model reads back. */
  content: string;
  isError?: boolean;
}

export interface ToolCallContext {
  documentId: string;
  requestId: string;
  /** The `callId` of this call's toolStarted/toolCompleted events. */
  callId: string;
  /** Aborted when the request is interrupted or the session closes. */
  signal: AbortSignal;
}

/** What crosses to a provider: no code, only a description and a JSON Schema. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type ValidationResult = { ok: true; value: Record<string, unknown> } | { ok: false; message: string };

export interface ToolDefinition extends ToolSpec {
  /** Rejects malformed arguments before `run` sees them. Without it, arguments reach `run` unchecked. */
  validate?: (args: unknown) => ValidationResult;
  run: (args: Record<string, unknown>, context: ToolCallContext) => Promise<ToolResult> | ToolResult;
}

const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** A tool whose arguments are described and validated by a zod object schema. */
export function defineTool<S extends z.ZodObject>(definition: {
  name: string;
  description: string;
  input: S;
  run: (args: z.infer<S>, context: ToolCallContext) => Promise<ToolResult> | ToolResult;
}): ToolDefinition {
  const { name, description, input, run } = definition;
  const inputSchema = z.toJSONSchema(input) as Record<string, unknown>;
  delete inputSchema.$schema;
  return {
    name,
    description,
    inputSchema,
    validate(args) {
      const parsed = input.safeParse(args);
      if (parsed.success) return { ok: true, value: parsed.data as Record<string, unknown> };
      return { ok: false, message: z.prettifyError(parsed.error) };
    },
    run: (args, context) => run(args as z.infer<S>, context),
  };
}

export function assertToolNames(tools: readonly ToolSpec[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (!TOOL_NAME.test(tool.name)) throw new Error(`invalid tool name: ${tool.name}`);
    if (seen.has(tool.name)) throw new Error(`duplicate tool name: ${tool.name}`);
    seen.add(tool.name);
  }
}

export const toolSpec = ({ name, description, inputSchema }: ToolSpec): ToolSpec => ({ name, description, inputSchema });
