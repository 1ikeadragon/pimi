import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestHandler } from "express";
import type { Logger } from "pino";
import {
  PIMI_ASK_STREAM_TYPE,
  PimiVoiceCommandInput,
  PimiVoiceNavigation,
  type PimiAskEvent,
  type PimiAskResult,
  type PimiVoiceCommandResponse,
} from "@pimi/protocol/pimi-task";
import type { PimiSpaces } from "../pimi-spaces.js";
import type { AgentManager } from "./agent-manager.js";
import type { StructuredGenerationProvider } from "./agent-response-loop.js";
import type { AgentSessionConfig, ProviderSnapshotEntry } from "./agent-sdk-types.js";
import type { ProviderSnapshotManager } from "./provider-snapshot-manager.js";
import {
  ASK_PIMI_NOTHING,
  AskPimiMemory,
  askPimiReply,
  buildAskPimiPrompt,
  runAskPimiTurn,
} from "./pimi-ask.js";
import type { AskPimiToolSessions } from "./pimi-ask-mcp.js";
import { createAskPimiToolset, type AskPimiToolset } from "./pimi-ask-tools.js";
import type { PaseoToolCatalog } from "./tools/types.js";
import {
  resolveStructuredGenerationProviders,
  type StructuredGenerationDaemonConfig,
} from "./structured-generation-providers.js";

const PROVIDER_ATTEMPTS = 2;

// Ask Pimi runs unattended, so the harness's own tools are switched off. Its only tools are
// the ones Pimi serves for the turn.
function harnessOptions(provider: string): AgentSessionConfig["providerOptions"] {
  switch (provider) {
    case "codex":
      return { sandbox_mode: "read-only", approval_policy: "never", web_search: "disabled" };
    case "claude":
      // Also ignore MCP servers from the user's own Claude settings.
      return { extraArgs: { tools: "", "strict-mcp-config": null } };
    case "opencode":
      return { permission: "deny" };
    default:
      return undefined;
  }
}

async function resolveVoiceProviders(
  cwd: string,
  config: StructuredGenerationDaemonConfig,
  catalog: ProviderSnapshotEntry[],
  activeConfig?: AgentSessionConfig,
) {
  const manual = Boolean(config.metadataGeneration?.providers?.length);
  const ready = catalog.filter((entry) => entry.enabled && entry.status === "ready");
  const supported = ready.filter((entry) => harnessOptions(entry.provider));
  let entries = catalog;
  if (!manual && supported.length) entries = supported;
  const active = entries.some((entry) => entry.provider === activeConfig?.provider)
    ? activeConfig
    : undefined;
  const candidates = await resolveStructuredGenerationProviders({
    cwd,
    providerSnapshotManager: { listProviders: async () => entries },
    daemonConfig: config,
    currentSelection: active ?? entries.find((entry) => entry.enabled && entry.status === "ready"),
  });
  if (manual) return candidates;
  const alternatives = supported.map(({ provider, models }) => {
    const model = models?.find((entry) => entry.isDefault) ?? models?.[0];
    return { provider, model: model?.id, thinkingOptionId: model?.defaultThinkingOptionId };
  });
  if (active?.model) candidates.unshift({ provider: active.provider, model: active.model });
  // In automatic mode, try a different provider if the first harness cannot authenticate.
  const byProvider = new Map<string, StructuredGenerationProvider>();
  for (const candidate of [...candidates, ...alternatives]) {
    if (byProvider.has(candidate.provider)) continue;
    const models = entries.find((entry) => entry.provider === candidate.provider)?.models;
    const model = models?.find(({ id }) => id === candidate.model);
    const canUseLowEffort = model?.thinkingOptions?.some(({ id }) => id === "low");
    byProvider.set(candidate.provider, {
      ...candidate,
      thinkingOptionId: canUseLowEffort ? "low" : candidate.thinkingOptionId,
    });
  }
  return [...byProvider.values()];
}

function reportFailure(logger: Logger): string {
  // Provider errors can include the transcript. Keep it out of logs and error receipts.
  logger.warn("Ask Pimi could not complete a command");
  return "Your provider couldn’t complete that command. Try again.";
}

// COMPAT(askPimiAgent): added in v0.17.18. Apps older than that expect a routing plan or a
// message with an optional view. Remove after 2027-05-11, with the request's agent field.
function legacyResponse(result: PimiAskResult): PimiVoiceCommandResponse {
  if (result.ignored) return { steps: [] };
  const [first] = result.actions;
  const navigation = PimiVoiceNavigation.safeParse(first);
  if (result.actions.length === 1 && navigation.success && navigation.data.action !== "show") {
    return { steps: [], open: navigation.data };
  }
  const view = result.actions.find((action) => action.action === "show");
  return {
    message: result.message.slice(0, 1000) || "Done",
    ...(view && { navigation: view }),
  };
}

interface AskPimiOutcome {
  result: PimiAskResult;
  toolset: AskPimiToolset;
}

function finishTurn(
  finalText: string,
  toolset: AskPimiToolset,
  provider: StructuredGenerationProvider,
): PimiAskResult | null {
  const reply = askPimiReply(finalText);
  const acted = toolset.actions.length > 0 || toolset.saved.length > 0;
  const nothing = new RegExp(`^\\W*${ASK_PIMI_NOTHING}\\W*$`, "i").test(reply);
  // Small models often answer background speech with silence instead of the marker.
  if (!acted && (nothing || (!reply && toolset.calls === 0))) {
    return { message: "", actions: [], ignored: true };
  }
  if (!acted && !reply) return null;
  return {
    message: nothing ? "" : reply,
    actions: toolset.actions,
    ...(toolset.actions.some(({ action }) => action === "start-chat") && {
      chatProvider: provider,
    }),
  };
}

export function createPimiVoiceCommandHandler(options: {
  manager: AgentManager;
  providerSnapshotManager: Pick<ProviderSnapshotManager, "listProviders">;
  readConfig: () => StructuredGenerationDaemonConfig;
  createToolCatalog: (provider: AgentSessionConfig["provider"]) => PaseoToolCatalog;
  spaces?: Pick<PimiSpaces, "list" | "read" | "addNote">;
  sessions: AskPimiToolSessions;
  /** Where a harness on this machine reaches the Ask Pimi tools, once the host is listening. */
  toolsUrl: () => string | null;
  logger: Logger;
}): RequestHandler {
  let running = false;
  const memory = new AskPimiMemory();

  async function ask(
    input: PimiVoiceCommandInput,
    cwd: string,
    providers: StructuredGenerationProvider[],
    mcpUrl: string,
    onStatus: (status: string) => void,
    signal: AbortSignal,
  ): Promise<AskPimiOutcome> {
    const commands = input.commands ?? [];
    const prompt = buildAskPimiPrompt({
      transcript: input.transcript,
      workspaceId: input.workspaceId,
      commands,
      memory: memory.recall(),
    });
    for (const provider of providers.slice(0, PROVIDER_ATTEMPTS)) {
      const providerOptions = harnessOptions(provider.provider);
      if (!providerOptions) continue;
      const toolset = createAskPimiToolset({
        catalog: options.createToolCatalog(provider.provider),
        spaces: options.spaces,
        transcript: input.transcript,
        commands,
        onStatus,
      });
      const started = Date.now();
      let result: PimiAskResult | null = null;
      try {
        const finalText = await runAskPimiTurn({
          manager: options.manager,
          config: { ...provider, cwd, providerOptions },
          mcpUrl,
          sessions: options.sessions,
          toolset,
          prompt,
          signal,
          onCleanupError: () => options.logger.warn("Ask Pimi session could not close"),
        });
        result = finishTurn(finalText, toolset, provider);
      } catch {
        signal.throwIfAborted();
      }
      // Counts and timing only. The request and the reply stay out of logs.
      options.logger.info(
        {
          provider: provider.provider,
          model: provider.model,
          ms: Date.now() - started,
          calls: toolset.calls,
          actions: toolset.actions.length,
          saved: toolset.saved.length,
          completed: Boolean(result),
        },
        "Ask Pimi turn",
      );
      if (result) return { result, toolset };
      if (toolset.saved.length) {
        // Another provider would repeat the changes already saved, so report them and stop.
        return {
          result: {
            message: `${toolset.saved.join(" · ")} · I couldn’t finish the rest.`,
            actions: toolset.actions,
          },
          toolset,
        };
      }
    }
    throw new Error("No provider completed the Ask Pimi turn.");
  }

  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const input = PimiVoiceCommandInput.safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: "Say a shorter command and try again." });
      return;
    }
    if (running) {
      res.status(409).json({ error: "Pimi is still handling your last command." });
      return;
    }
    running = true;
    const cancel = new AbortController();
    res.once("close", () => cancel.abort());
    const streaming = input.data.agent === true;
    const send = (event: PimiAskEvent) => {
      if (!res.destroyed) res.write(`${JSON.stringify(event)}\n`);
    };
    let cwd: string | undefined;
    try {
      cwd = await mkdtemp(join(tmpdir(), "pimi-voice-"));
      const config = options.readConfig();
      const activeAgent = input.data.agentId
        ? options.manager.getAgent(input.data.agentId)
        : undefined;
      const entries = await options.providerSnapshotManager.listProviders({ wait: true });
      const providers = (
        await resolveVoiceProviders(cwd, config, entries, activeAgent?.config)
      ).filter(({ provider }) => harnessOptions(provider));
      const mcpUrl = options.toolsUrl();
      if (!providers.length || !mcpUrl) {
        res.status(providers.length ? 503 : 422).json({
          error: providers.length
            ? "Ask Pimi needs the local host to finish starting. Try again."
            : "Connect Codex, Claude Code, or OpenCode to use Ask Pimi.",
        });
        return;
      }
      if (streaming) {
        res.status(200).setHeader("Content-Type", PIMI_ASK_STREAM_TYPE);
        res.flushHeaders();
      }
      let lastStatus = "";
      const { result, toolset } = await ask(
        input.data,
        cwd,
        providers,
        mcpUrl,
        (status) => {
          if (!streaming || status === lastStatus) return;
          lastStatus = status;
          send({ type: "status", text: status });
        },
        cancel.signal,
      );
      cancel.signal.throwIfAborted();
      if (!result.ignored) {
        memory.remember({
          transcript: input.data.transcript,
          reply: result.message,
          references: toolset.references,
        });
      }
      if (streaming) {
        send({ type: "result", result });
        res.end();
      } else {
        res.json(legacyResponse(result));
      }
    } catch {
      if (res.destroyed) return;
      const error = reportFailure(options.logger);
      if (res.headersSent) {
        send({ type: "error", error });
        res.end();
      } else {
        res.status(502).json({ error });
      }
    } finally {
      if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
      running = false;
    }
  };
}
