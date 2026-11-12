import type { AgentSessionConfig, McpServerConfig } from "./agent-sdk-types.js";

export const PIMI_MCP_SERVER_NAME = "pimi";
const PIMI_MCP_PATHNAME = "/mcp/agents";

export function stripInternalPimiMcpServer(config: AgentSessionConfig): AgentSessionConfig {
  const mcpServers = config.mcpServers;
  if (!mcpServers) {
    return config;
  }

  const nextMcpServers = { ...mcpServers };
  for (const name of [PIMI_MCP_SERVER_NAME]) {
    const server = nextMcpServers[name];
    if (server && isInternalPimiMcpServer(server)) delete nextMcpServers[name];
  }
  if (Object.keys(mcpServers).length === Object.keys(nextMcpServers).length) return config;

  const next = { ...config };
  if (Object.keys(nextMcpServers).length > 0) {
    next.mcpServers = nextMcpServers;
  } else {
    delete next.mcpServers;
  }
  return next;
}

export function withRuntimePimiMcpServer(params: {
  config: AgentSessionConfig;
  agentId: string;
  mcpBaseUrl: string | null;
  /**
   * Capability token authenticating the injected connection to the daemon's
   * Agent MCP endpoint. The daemon password is gated off this route, so without
   * this header the agent's MCP requests are rejected when a password is set.
   */
  mcpAuthToken: string | null;
}): AgentSessionConfig {
  const storedConfig = stripInternalPimiMcpServer(params.config);
  if (!params.mcpBaseUrl || storedConfig.mcpServers?.[PIMI_MCP_SERVER_NAME]) {
    return storedConfig;
  }

  return {
    ...storedConfig,
    mcpServers: {
      [PIMI_MCP_SERVER_NAME]: {
        type: "http",
        url: `${params.mcpBaseUrl}?callerAgentId=${params.agentId}`,
        ...(params.mcpAuthToken
          ? { headers: { Authorization: `Bearer ${params.mcpAuthToken}` } }
          : {}),
      },
      ...storedConfig.mcpServers,
    },
  };
}

function isInternalPimiMcpServer(config: McpServerConfig): boolean {
  if (config.type !== "http" && config.type !== "sse") {
    return false;
  }

  try {
    return new URL(config.url).pathname === PIMI_MCP_PATHNAME;
  } catch {
    return false;
  }
}
