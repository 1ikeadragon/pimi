// Pimi. PolyForm-Noncommercial-1.0.0.
import { PIMI_ASK_MESSAGE_LIMIT } from "@pimi/protocol/pimi-task";
import { renderTemplate } from "../prompts/render.js";
import type { AgentManager } from "./agent-manager.js";
import type { AgentSessionConfig } from "./agent-sdk-types.js";
import { PIMI_ASK_MCP_SERVER, type AskPimiToolSessions } from "./pimi-ask-mcp.js";
import type { AskPimiReference, AskPimiToolset } from "./pimi-ask-tools.js";

// The desktop bridge waits 150s for the whole request, including a second provider.
const TURN_TIMEOUT_MS = 70_000;
const MEMORY_TURNS = 4;
const MEMORY_MS = 10 * 60 * 1000;
export const ASK_PIMI_NOTHING = "NOTHING";

export const ASK_PIMI_INSTRUCTIONS = renderTemplate("ask-pimi-instructions", {
  nothing: ASK_PIMI_NOTHING,
});

interface AskPimiExchange {
  at: number;
  transcript: string;
  reply: string;
  references: AskPimiReference[];
}

// Recent exchanges let a follow-up refer to the last answer. They live in memory only and
// expire quickly: never write them to disk or to logs.
export class AskPimiMemory {
  private exchanges: AskPimiExchange[] = [];

  recall(now = Date.now()): AskPimiExchange[] {
    this.exchanges = this.exchanges.filter(({ at }) => now - at < MEMORY_MS);
    return this.exchanges;
  }

  remember(exchange: Omit<AskPimiExchange, "at">): void {
    this.exchanges = [...this.recall(), { ...exchange, at: Date.now() }].slice(-MEMORY_TURNS);
  }
}

export function buildAskPimiPrompt(options: {
  transcript: string;
  workspaceId?: string;
  agentId?: string;
  commands: readonly string[];
  memory: AskPimiExchange[];
  now?: Date;
}): string {
  const now = options.now ?? new Date();
  const lines = [
    `Local time: ${now.toString()}`,
    `Chat in front of the user: ${JSON.stringify(options.workspaceId ?? null)}`,
    `Focused agent: ${JSON.stringify(options.agentId ?? null)}`,
  ];
  if (options.commands.length) {
    lines.push(`App commands (data, by index): ${JSON.stringify(options.commands)}`);
  }
  if (options.memory.length) {
    lines.push(
      `Earlier exchanges, oldest first (context only): ${JSON.stringify(
        options.memory.map(({ transcript, reply, references }) => ({
          user: transcript,
          pimi: reply,
          ...(references.length && {
            items: references.map(({ kind, id, label }) => ({
              reference: kind === "card" ? `space:${id}` : id,
              kind,
              label,
            })),
          }),
        })),
      )}`,
    );
  }
  lines.push(`Spoken request: ${JSON.stringify(options.transcript)}`);
  return lines.join("\n");
}

export function askPimiReply(finalText: string): string {
  const plain = finalText
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/^\s*(?:[-*•]|#{1,6})\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= PIMI_ASK_MESSAGE_LIMIT) return plain;
  const cut = plain.slice(0, PIMI_ASK_MESSAGE_LIMIT - 1);
  const sentence = cut.lastIndexOf(". ");
  return sentence > PIMI_ASK_MESSAGE_LIMIT / 2 ? cut.slice(0, sentence + 1) : `${cut}…`;
}

/**
 * Runs one Ask Pimi turn: a single hidden agent session whose only tools are the ones in the
 * toolset, called natively through a per-turn MCP credential. Returns the model's final text.
 */
export async function runAskPimiTurn(options: {
  manager: AgentManager;
  config: AgentSessionConfig;
  mcpUrl: string;
  sessions: AskPimiToolSessions;
  toolset: AskPimiToolset;
  prompt: string;
  signal: AbortSignal;
  onCleanupError: () => void;
}): Promise<string> {
  const { manager, toolset } = options;
  const session = options.sessions.start(toolset.tools);
  let agentId: string | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    const agent = await manager.createAgent(
      {
        ...options.config,
        internal: true,
        title: "Ask Pimi",
        systemPrompt: ASK_PIMI_INSTRUCTIONS,
        mcpServers: {
          [PIMI_ASK_MCP_SERVER]: {
            type: "http",
            url: options.mcpUrl,
            headers: { Authorization: `Bearer ${session.token}` },
          },
        },
        // Exactly these tools run unattended. Anything else the harness offers is refused below.
        toolPolicy: {
          preapproved: toolset.tools.map(({ name }) => ({
            kind: "mcp",
            server: PIMI_ASK_MCP_SERVER,
            tool: name,
          })),
        },
      },
      undefined,
      { workspaceId: undefined, persistSession: false, withoutAppTools: true },
    );
    agentId = agent.id;
    const id = agent.id;
    unsubscribe = manager.subscribe(
      (event) => {
        if (event.type !== "agent_stream" || event.event.type !== "permission_requested") return;
        // No one is watching this session, so an unapproved tool is refused at once.
        void manager
          .respondToPermission(id, event.event.request.id, {
            behavior: "deny",
            message: "This tool is not available to Ask Pimi.",
          })
          .catch(() => undefined);
      },
      { agentId: id, includeInternal: true, replayState: false },
    );
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(TURN_TIMEOUT_MS)]);
    signal.throwIfAborted();
    const stopped = new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("Ask Pimi stopped the turn.")), {
        once: true,
      });
    });
    const run = manager.runAgent(id, options.prompt);
    // The losing promise must not surface as an unhandled rejection after the race settles.
    run.catch(() => undefined);
    stopped.catch(() => undefined);
    const result = await Promise.race([run, stopped]);
    return result.finalText;
  } finally {
    session.end();
    unsubscribe?.();
    if (agentId) {
      try {
        await manager.closeAgent(agentId);
        await manager.deleteAgentState(agentId);
      } catch {
        options.onCleanupError();
      }
    }
  }
}
