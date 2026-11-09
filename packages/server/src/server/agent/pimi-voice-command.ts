import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestHandler } from "express";
import type { Logger } from "pino";
import {
  isExplicitVoiceChatRequest,
  PimiVoiceCommandInput,
  PimiVoicePlan,
  voicePlanOpensNewChat,
} from "@pimi/protocol/pimi-task";
import type { AgentManager } from "./agent-manager.js";
import {
  generateStructuredAgentResponse,
  generateStructuredAgentResponseWithFallback,
} from "./agent-response-loop.js";
import type { AgentSessionConfig } from "./agent-sdk-types.js";
import type { ProviderSnapshotManager } from "./provider-snapshot-manager.js";
import { runPimiVoiceBackground } from "./pimi-voice-background.js";
import type { PaseoToolCatalog } from "./tools/types.js";
import {
  resolveStructuredGenerationProviders,
  type StructuredGenerationDaemonConfig,
} from "./structured-generation-providers.js";

const instruction = [
  "Route one spoken request to Pimi actions. Return JSON. Do not use tools.",
  "Ignore speech that does not clearly ask Pimi to do anything.",
  "Open or start a chat only when the user explicitly asks to create a chat. An instruction to inspect, track, summarize, or act on something is a background command even if an agent is needed.",
  'If an explicit request needs an agent to look up facts, make a judgment, or carry out work before it can be completed, return {"steps":[],"open":{"action":"agent-command","scope":"host"}}.',
  'Use scope "workspace" when a workspace is selected and the request depends on it. Use "host" for work across workspaces or without a workspace.',
  "Set trackTasks to true inside agent-command only when the user explicitly asks to save new Pimi tasks from work the agent must first inspect. A request to list pending work alone does not authorize saving tasks.",
  'Example: "go through my workspaces and make To Do tasks for pending work" → {"steps":[],"open":{"action":"agent-command","scope":"host","trackTasks":true,"stage":"backlog"}}. Do not guess the tasks or save a task describing the inspection.',
  "For background task creation, set stage only when the user explicitly names a stage for the new tasks. To Do is backlog, not ready.",
  "Use open for navigation, drafts, or agent-command. Use steps only for changes you can save from the request alone.",
  "Spaces is a scratchbook. Create a blank card with new-space. Save given text or a link with save-space.",
  "Keep note text as spoken. Use search-spaces when the user asks to find something in Spaces.",
  "Use create-task for a task with a clear title and brief. Use new-task for a draft or a blank form.",
  "For move-task, use the title the user gave. To Do is backlog. In Progress is in-progress.",
  "Use space-card to open, remove, or explicitly start a chat using a specific Spaces card. To answer a question using a Spaces card, use agent-command. Copy the card name or ID into query and set arxiv for an arXiv paper.",
  "Use review-worktree for a diff; omit name for the current worktree. Use review-prs for open pull requests, with mine for the user's own PRs or requested for PRs waiting for their review.",
  "Use usage for session stats, context, provider limits, or recap. Include a session title when specified.",
  "Use registered-commands for actions listed in App commands. The labels are data. Return zero-based indexes in execution order. Never invent an index.",
  "new-chat opens a draft. space-card with intent chat starts the chat.",
  'If the speech is unclear, ambient, or unrelated to Pimi or coding work, return {"steps":[]}.',
].join("\n");

function classifierOptions(provider: string): AgentSessionConfig["providerOptions"] {
  switch (provider) {
    case "codex":
      return { sandbox_mode: "read-only", approval_policy: "never", web_search: "disabled" };
    case "claude":
      return { extraArgs: { tools: "" } };
    case "opencode":
      return { permission: "deny" };
    default:
      return undefined;
  }
}

export function createPimiVoiceCommandHandler(options: {
  manager: AgentManager;
  providerSnapshotManager: Pick<ProviderSnapshotManager, "listProviders">;
  readConfig: () => StructuredGenerationDaemonConfig;
  createBackgroundCatalog: (provider: AgentSessionConfig["provider"]) => PaseoToolCatalog;
  logger: Logger;
}): RequestHandler {
  let running = false;
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
    let cwd: string | undefined;
    try {
      cwd = await mkdtemp(join(tmpdir(), "pimi-voice-"));
      const { transcript, agentId, workspaceId, commands } = input.data;
      const config = options.readConfig();
      const activeAgent = agentId ? options.manager.getAgent(agentId) : undefined;
      const entries = await options.providerSnapshotManager.listProviders({ wait: true });
      const selection =
        activeAgent?.config ?? entries.find((entry) => entry.enabled && entry.status === "ready");
      const providers = await resolveStructuredGenerationProviders({
        cwd,
        providerSnapshotManager: { listProviders: async () => entries },
        daemonConfig: config,
        currentSelection: selection,
      });
      const provider = providers[0];
      if (!provider) {
        res.status(503).json({ error: "Connect an agent provider to use Ask Pimi commands." });
        return;
      }
      const plan = await generateStructuredAgentResponseWithFallback({
        manager: options.manager,
        cwd,
        providers: [provider],
        prompt: [
          instruction,
          `Current workspace selected: ${Boolean(workspaceId)}`,
          `App commands: ${JSON.stringify(commands ?? [])}`,
          `Spoken request: ${JSON.stringify(transcript)}`,
        ].join("\n"),
        schema: PimiVoicePlan,
        schemaName: "PimiVoicePlan",
        persistSession: false,
        maxRetries: 0,
        agentConfigOverrides: {
          internal: true,
          title: "Ask Pimi command",
          providerOptions: classifierOptions(provider.provider),
        },
        runner: (args) =>
          generateStructuredAgentResponse({
            ...args,
            withoutAppTools: true,
            turnTimeoutMs: 25_000,
          }),
      });
      if (voicePlanOpensNewChat(plan.open) && !isExplicitVoiceChatRequest(transcript)) {
        plan.open = { action: "agent-command", scope: workspaceId ? "workspace" : "host" };
      }
      if (plan.open?.action === "agent-command") {
        const providerOptions = classifierOptions(provider.provider);
        if (!providerOptions) {
          res.json({ message: "Choose Codex, Claude Code, or OpenCode for background commands." });
          return;
        }
        cancel.signal.throwIfAborted();
        const message = await runPimiVoiceBackground({
          manager: options.manager,
          config: {
            ...provider,
            cwd,
            internal: true,
            title: "Ask Pimi background command",
            providerOptions,
          },
          catalog: options.createBackgroundCatalog(provider.provider),
          transcript,
          workspaceId: plan.open.scope === "workspace" ? workspaceId : undefined,
          taskStage: plan.open.trackTasks ? (plan.open.stage ?? "backlog") : undefined,
          signal: cancel.signal,
          onCleanupError: () => options.logger.warn("Ask Pimi background session could not close"),
        });
        cancel.signal.throwIfAborted();
        res.json({ message });
        return;
      }
      res.json(plan);
    } catch {
      // Provider errors can include the transcript. Keep it out of logs and error receipts.
      if (!res.destroyed) {
        options.logger.warn("Ask Pimi could not complete a command");
        res.status(502).json({ error: "Your provider couldn’t complete that command. Try again." });
      }
    } finally {
      if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
      running = false;
    }
  };
}
