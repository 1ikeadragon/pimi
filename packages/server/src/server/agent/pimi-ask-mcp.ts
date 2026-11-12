// Pimi. Apache-2.0.
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RequestHandler } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { extractHttpBearerToken } from "../auth.js";
import { createToolMcpServer } from "./mcp-server.js";
import type { PimiToolDefinition } from "./tools/types.js";

export const PIMI_ASK_MCP_ROUTE = "/mcp/ask-pimi";
export const PIMI_ASK_MCP_SERVER = "askpimi";

// Each Ask Pimi turn serves its own tool list under a credential that stops working when the
// turn ends. Nothing else can reach these tools, and the turn cannot reach any other tool.
export class AskPimiToolSessions {
  private readonly open = new Map<string, readonly PimiToolDefinition[]>();

  start(tools: readonly PimiToolDefinition[]): { token: string; end: () => void } {
    const token = randomBytes(32).toString("base64url");
    this.open.set(token, tools);
    return { token, end: () => this.open.delete(token) };
  }

  find(token: string | null): readonly PimiToolDefinition[] | undefined {
    return token ? this.open.get(token) : undefined;
  }
}

export function createAskPimiMcpHandler(
  sessions: AskPimiToolSessions,
  reportError: () => void,
): RequestHandler {
  return async (req, res) => {
    const tools = sessions.find(extractHttpBearerToken(req.header("authorization")));
    if (!tools) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (req.method !== "POST") {
      // Stateless, like the agent tool route: there is no stream to open or session to end.
      res.status(405).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed" },
        id: null,
      });
      return;
    }
    try {
      const server = createToolMcpServer(tools, async (name, args, signal) => {
        const tool = tools.find((entry) => entry.name === name);
        if (!tool) throw new Error("This tool is unavailable for the request.");
        return tool.handler(args, { signal });
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        // The credential is the boundary. The route is local and never browser-reachable.
        enableDnsRebindingProtection: false,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(
        req as unknown as IncomingMessage,
        res as unknown as ServerResponse,
        req.body,
      );
    } catch {
      // Tool arguments can quote the user's request. Keep them out of logs.
      reportError();
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal MCP server error" },
          id: null,
        });
      }
    }
  };
}
