import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";

import { addModelVisibleStructuredContent } from "./tools/paseo-tool-serialization.js";
import { createLazyLoaderTools, splitToolsForLazyLoading } from "./tools/lazy-tool-groups.js";
import { createPaseoToolCatalog, type PaseoToolHostDependencies } from "./tools/paseo-tools.js";
import type { PaseoToolDefinition, PaseoToolResult } from "./tools/types.js";

export type AgentMcpServerOptions = PaseoToolHostDependencies;

type McpToolContext = RequestHandlerExtra<ServerRequest, ServerNotification>;

function toMcpToolResult(result: PaseoToolResult): CallToolResult {
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
  tools: Iterable<PaseoToolDefinition>,
  execute: (name: string, args: unknown, signal?: AbortSignal) => Promise<PaseoToolResult>,
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
  const catalog = await createPaseoToolCatalog(options);
  const execute = (name: string, args: unknown, signal?: AbortSignal) =>
    catalog.executeTool(name, args, { signal });
  if (!loading.lazyTools) return createToolMcpServer(catalog.tools.values(), execute);
  const { listed, groups } = splitToolsForLazyLoading(catalog.tools.values());
  const loaderTools = new Map(
    createLazyLoaderTools(groups, execute).map((tool) => [tool.name, tool]),
  );
  return createToolMcpServer([...listed, ...loaderTools.values()], (name, args, signal) => {
    const loaderTool = loaderTools.get(name);
    return loaderTool ? loaderTool.handler(args, { signal }) : execute(name, args, signal);
  });
}
