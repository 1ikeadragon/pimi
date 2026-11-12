import type { z } from "zod";
import type { ProviderPimiToolsPolicy } from "@pimi/protocol/provider-config";

export class PimiToolInputError extends Error {
  readonly status = 400;

  constructor(
    message: string,
    readonly issues?: z.ZodError["issues"],
  ) {
    super(message);
    this.name = "PimiToolInputError";
  }
}

export interface PimiToolExecutionContext {
  signal?: AbortSignal;
  sendUpdate?: (update: PimiToolResult) => void;
}

export interface PimiToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface PimiToolConfig {
  title?: string;
  description?: string;
  inputSchema?: z.ZodRawShape | z.ZodType;
  outputSchema?: z.ZodRawShape;
}

export interface PimiToolDefinition extends PimiToolConfig {
  name: string;
  description: string;
  handler: (input: unknown, context: PimiToolExecutionContext) => Promise<PimiToolResult>;
}

export interface PimiToolCatalog {
  tools: ReadonlyMap<string, PimiToolDefinition>;
  getTool(name: string): PimiToolDefinition | undefined;
  executeTool(
    name: string,
    input: unknown,
    context?: PimiToolExecutionContext,
  ): Promise<PimiToolResult>;
}

export interface PimiToolRuntimeContext {
  callerAgentId?: string;
  pimiToolPolicy?: ProviderPimiToolsPolicy;
  enableVoiceTools?: boolean;
  voiceOnly?: boolean;
}

export type PimiToolCatalogFactory = (
  context: PimiToolRuntimeContext,
) => PimiToolCatalog | Promise<PimiToolCatalog>;
