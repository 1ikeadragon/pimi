import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  type ServerNotification,
  type ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";

import { addModelVisibleStructuredContent } from "./tools/pimi-tool-serialization.js";
import { createLazyLoaderTools, splitToolsForLazyLoading } from "./tools/lazy-tool-groups.js";
import { createPimiToolCatalog, type PimiToolHostDependencies } from "./tools/pimi-tools.js";
import type { PimiToolDefinition, PimiToolResult } from "./tools/types.js";

export type AgentMcpServerOptions = PimiToolHostDependencies;

type McpToolContext = RequestHandlerExtra<ServerRequest, ServerNotification>;

function toMcpToolResult(result: PimiToolResult): CallToolResult {
  const modelVisibleResult = addModelVisibleStructuredContent(result);
  return {
    content: modelVisibleResult.content as CallToolResult["content"],
    ...(modelVisibleResult.structuredContent !== undefined
      ? {
          structuredContent:
            modelVisibleResult.structuredContent as CallToolResult["structuredContent"],
        }
      : {}),
    ...(modelVisibleResult.isError !== undefined ? { isError: modelVisibleResult.isError } : {}),
  };
}

export function createToolMcpServer(
  tools: Iterable<PimiToolDefinition>,
  execute: (name: string, args: unknown, signal?: AbortSignal) => Promise<PimiToolResult>,
): McpServer {
  const server = new McpServer({
    name: "pimi",
    version: "2.0.0",
  });

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args: unknown, context?: McpToolContext) =>
        toMcpToolResult(await execute(tool.name, args, context?.signal)),
    );
  }

  return server;
}

export interface AgentMcpServerLoading {
  /** List only the core tools plus a loader, for providers that send every tool schema each turn. */
  lazyTools: boolean;
}

export async function createAgentMcpServer(
  options: AgentMcpServerOptions,
  loading: AgentMcpServerLoading = { lazyTools: false },
): Promise<McpServer> {
  const catalog = await createPimiToolCatalog(options);
  const execute = (name: string, args: unknown, signal?: AbortSignal) =>
    catalog.executeTool(name, args, { signal });
  if (!loading.lazyTools) return createToolMcpServer(catalog.tools.values(), execute);
  const { listed, groups } = splitToolsForLazyLoading(catalog.tools.values());
  const loaderTools = new Map(
    createLazyLoaderTools(groups, new Set(listed.map((tool) => tool.name)), execute).map((tool) => [
      tool.name,
      tool,
    ]),
  );
  const route = (name: string, args: unknown, signal?: AbortSignal) => {
    const loaderTool = loaderTools.get(name);
    return loaderTool ? loaderTool.handler(args, { signal }) : execute(name, args, signal);
  };
  const server = createToolMcpServer([...listed, ...loaderTools.values()], route);
  // The tool list is short on purpose, but an agent that already knows a tool's name (resumed
  // history, a stale schema) can still call it directly instead of hitting "Tool X not found".
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      return toMcpToolResult(
        await route(request.params.name, request.params.arguments ?? {}, extra.signal),
      );
    } catch (error) {
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  });
  return server;
}
