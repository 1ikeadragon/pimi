// Pimi addition to the Paseo fork. Apache-2.0.
import { createPaseoClient } from "@getpaseo/client";
import { buildAgentDeepLink } from "@getpaseo/protocol/agent-deep-link";
import { tmpdir } from "node:os";

import { RequestError } from "./git.mjs";

async function allPages(list) {
  const entries = [];
  let cursor;
  const seen = new Set();
  do {
    const result = await list({ page: { limit: 200, cursor } });
    entries.push(...result.entries);
    cursor = result.pageInfo.nextCursor ?? undefined;
    if (cursor && seen.has(cursor)) throw new Error("The daemon repeated a directory cursor.");
    seen.add(cursor);
  } while (cursor);
  return entries;
}

function runningPreviews(scripts) {
  return scripts
    .filter(
      (script) =>
        script.type === "service" &&
        script.lifecycle === "running" &&
        script.health === "healthy" &&
        Number.isInteger(script.port) &&
        script.port <= 65535,
    )
    .map((script) => ({ name: script.scriptName, url: `http://127.0.0.1:${script.port}` }));
}

function readableProviderError(error) {
  if (!error) return undefined;
  try {
    return JSON.parse(error)?.error?.message || error;
  } catch {
    return error;
  }
}

export function createPaseoConnection(settingsSource = {}) {
  let cachedClient;
  let connection;
  let chatHost;
  let lastDirectory;
  let liveError;
  const changeListeners = new Set();

  const changed = (event = {}) => {
    for (const listener of changeListeners) listener(event);
  };
  const signature = (value) =>
    JSON.stringify(value, (key, entry) => (key === "updatedAt" ? undefined : entry));
  const agentView = (agent, serverId) => ({
    id: agent.id,
    chatUrl: serverId ? buildAgentDeepLink({ serverId, agentId: agent.id }) : undefined,
    title: agent.title || agent.provider,
    provider: agent.provider,
    model: agent.model,
    updatedAt: agent.updatedAt,
    thinkingOptionId: agent.effectiveThinkingOptionId ?? agent.thinkingOptionId,
    providerUnavailable: agent.providerUnavailable,
    cwd: agent.cwd,
    workspaceId: agent.workspaceId,
    status: agent.status,
    needsInput: agent.pendingPermissions.length > 0,
    error: agent.lastError,
  });
  const workspaceView = (workspace) => ({
    id: workspace.id,
    path: workspace.workspaceDirectory,
    name: workspace.name,
    state: workspace.status,
    previews: runningPreviews(workspace.scripts),
    root: workspace.projectKind === "git" ? workspace.projectRootPath : undefined,
    openPrUrl:
      workspace.githubRuntime?.pullRequest?.state?.toLowerCase() === "open" &&
      workspace.githubRuntime.pullRequest.url.startsWith("https://github.com/")
        ? workspace.githubRuntime.pullRequest.url
        : undefined,
  });

  async function observeDirectory(client) {
    const agents = new Map();
    const workspaces = new Map();
    const observe = (cache, id, value) => {
      if (!value) {
        cache.delete(id);
        changed();
        return;
      }
      const next = signature(value);
      if (cache.get(id) === next) return;
      cache.set(id, next);
      changed();
    };
    // These are directory state streams, never token/timeline streams.
    client.agents.subscribe((update) =>
      observe(
        agents,
        update.agent?.id ?? update.agentId,
        update.kind === "upsert" ? agentView(update.agent) : null,
      ),
    );
    client.workspaces.subscribe((update) =>
      observe(
        workspaces,
        update.workspace?.id ?? update.id,
        update.kind === "upsert" ? workspaceView(update.workspace) : null,
      ),
    );
    const gitEvents = client.observeEvents(["checkout_status_update"]);
    gitEvents.subscribe({
      snapshot() {},
      update(message) {
        if (message.type === "checkout_status_update") changed({ path: message.payload.cwd });
      },
    });
    const subscriptions = await Promise.allSettled([
      client.agents.list({ scope: "active", page: { limit: 200 }, subscribe: {} }),
      client.workspaces.list({ page: { limit: 200 }, subscribe: {} }),
      gitEvents.ready,
    ]);
    if (client !== cachedClient) return;
    liveError = subscriptions.some((result) => result.status === "rejected")
      ? "Some agent service events are unavailable; checking automatically every few seconds."
      : undefined;
    changed();
  }

  async function connect() {
    if (cachedClient?.getConnectionState().status === "connected") return cachedClient;
    connection ??= (async () => {
      await cachedClient?.close();
      chatHost = undefined;
      const settings = await settingsSource.connection?.();
      const url = new URL(settings?.url || process.env.PIMI_PASEO_URL || "ws://127.0.0.1:6767/ws");
      if (
        url.protocol !== "ws:" ||
        !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.pathname !== "/ws" ||
        url.search ||
        url.hash
      ) {
        throw new RequestError("The local agent service must use a loopback WebSocket URL.");
      }
      cachedClient = createPaseoClient({
        url: url.href,
        authHeader: process.env.PIMI_PASEO_AUTH_HEADER,
        localCredential: settings?.credential ? () => settings.credential : undefined,
        connectTimeoutMs: 2500,
        reconnect: { enabled: false },
      });
      await cachedClient.connect();
      const client = cachedClient;
      void observeDirectory(client).catch(() => {
        if (client !== cachedClient) return;
        liveError =
          "Agent service events are unavailable; checking automatically every few seconds.";
        changed();
      });
      return cachedClient;
    })().finally(() => {
      connection = undefined;
    });
    return connection;
  }

  async function directory() {
    try {
      const client = await connect();
      if (settingsSource.native) {
        chatHost ??= client.hosts.list().then(
          ({ self }) => self.serverId,
          (error) => {
            if (cachedClient === client) chatHost = undefined;
            console.warn("Pimi could not resolve agent chat links:", error.message);
          },
        );
      }
      const [agents, workspaces, serverId] = await Promise.all([
        allPages((options) => client.agents.list({ ...options, scope: "active" })),
        allPages(client.workspaces.list),
        chatHost,
      ]);
      lastDirectory = {
        serverId,
        agents: agents.map(({ agent }) => agentView(agent, serverId)),
        workspaces: workspaces.map(workspaceView),
        liveError,
      };
      return lastDirectory;
    } catch (error) {
      return { ...(lastDirectory ?? { agents: [], workspaces: [] }), error: error.message };
    }
  }

  async function reviewProvider(cwd, currentAgent) {
    const client = await connect();
    const { config } = await client.config.get();
    const configured = config.metadataGeneration?.providers?.[0];
    const selection = configured ?? currentAgent;
    if (selection?.provider && selection.model) return selection;
    const { entries } = await client.providers.waitForReady({ cwd, timeoutMs: 8000 });
    const available = entries.filter(
      (entry) => entry.enabled && entry.status === "ready" && entry.models?.length,
    );
    const provider = selection?.provider
      ? available.find((entry) => entry.provider === selection.provider)
      : available[0];
    const model = provider?.models.find((entry) => entry.isDefault) ?? provider?.models[0];
    if (!provider || !model) {
      throw new RequestError(
        "Choose a provider in Agent Console settings or start an agent in this worktree.",
        503,
      );
    }
    return {
      provider: provider.provider,
      model: model.id,
      thinkingOptionId: model.defaultThinkingOptionId,
    };
  }

  async function taskModels(cwd) {
    const client = await connect();
    const [{ config }, { entries }] = await Promise.all([
      client.config.get(),
      client.providers.waitForReady({ cwd, timeoutMs: 8000 }),
    ]);
    const configured = config.metadataGeneration?.providers?.[0];
    const models = entries
      .filter((entry) => entry.enabled && entry.status === "ready")
      .flatMap((entry) =>
        (entry.models ?? []).map((model) => ({
          id: `${entry.provider}/${model.id}`,
          label: `${entry.label ?? entry.provider} · ${model.label ?? model.id}`,
          thinkingOptionId: model.defaultThinkingOptionId ?? undefined,
        })),
      );
    return { models, preferred: configured && `${configured.provider}/${configured.model}` };
  }

  async function checkTaskModel(config) {
    const client = await connect();
    const probe = await client.agents.create({
      cwd: tmpdir(),
      title: "Pimi model check",
      background: true,
      config,
      prompt: "Reply with READY. Do not inspect files or use tools.",
    });
    try {
      const result = await probe.waitForFinish(30000);
      if (result.status !== "idle" || !result.lastMessage) {
        throw new RequestError(
          readableProviderError(result.error) || "The selected model did not respond.",
          502,
        );
      }
    } finally {
      await probe.archive().catch((error) => {
        console.error("Could not archive the model check:", error.message);
      });
    }
  }

  async function launchExperiment(task, experiment) {
    const client = await connect();
    const slug = `pimi-${experiment.workspaceId.slice(4)}`;
    const workspace = await client.workspaces.create({
      idempotencyKey: slug,
      workspaceId: experiment.workspaceId,
      title: experiment.title,
      source: {
        kind: "worktree",
        cwd: task.root,
        action: "branch-off",
        baseBranch: task.base,
        branchName: `pimi/${slug.slice(5)}`,
        worktreeSlug: slug,
      },
      agent: {
        agentId: experiment.id,
        cwd: task.root,
        title: experiment.title,
        config: experiment.launch.config,
        prompt: experiment.launch.prompt,
      },
    });
    return workspace.directory;
  }

  async function experimentReport(id) {
    const client = await connect();
    const agent = client.agents.ref(id);
    const snapshot = await agent.refresh();
    if (!snapshot?.agent) throw new RequestError("This agent is no longer available.", 404);
    if (agent.status !== "idle" || agent.pendingPermissions?.length) {
      throw new RequestError(
        readableProviderError(agent.lastError) || "The agent has not finished.",
        409,
      );
    }
    const result = await agent.waitForFinish(3000);
    if (result.status !== "idle" || !result.lastMessage?.trim()) {
      throw new RequestError("The agent finished without a text report.", 409);
    }
    return result.lastMessage.trim();
  }

  async function explain({ cwd, currentAgent, prompt, schema, instructions, model }) {
    const client = await connect();
    const selected = model ?? (await reviewProvider(cwd, currentAgent));
    const agent = await client.agents.create({
      cwd,
      background: true,
      title: "Pimi walkthrough",
      config: {
        provider: `${selected.provider}/${selected.model}`,
        thinkingOptionId: selected.thinkingOptionId ?? undefined,
        systemPrompt: instructions,
        ...(selected.provider === "codex"
          ? {
              options: {
                sandbox_mode: "read-only",
                approval_policy: "never",
                web_search: "disabled",
              },
            }
          : {}),
      },
      prompt,
      outputSchema: schema,
    });
    try {
      const result = await agent.waitForFinish(75000);
      if (result.status !== "idle" || !result.lastMessage) {
        throw new RequestError(
          readableProviderError(result.error) ||
            `The walkthrough agent stopped with status ${result.status}.`,
          502,
        );
      }
      return { text: result.lastMessage, provider: `${selected.provider}/${selected.model}` };
    } finally {
      await agent
        .archive()
        .catch((error) => console.error("Could not archive the walkthrough:", error.message));
    }
  }

  async function suggestExperiments(task, model) {
    const { text } = await explain({
      cwd: tmpdir(),
      model,
      instructions: "Propose work items from the brief alone. Do not inspect files or use tools.",
      prompt: `Propose two distinct, independently testable implementations for this task. Give each a short title and a concrete hypothesis.\n\n${task.title}\n${task.brief}`,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["ideas"],
        properties: {
          ideas: {
            type: "array",
            minItems: 2,
            maxItems: 2,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["title", "hypothesis"],
              properties: {
                title: { type: "string", maxLength: 55 },
                hypothesis: { type: "string", maxLength: 1600 },
              },
            },
          },
        },
      },
    });
    return JSON.parse(text).ideas;
  }

  return {
    directory,
    subscribe(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    explain,
    taskModels,
    checkTaskModel,
    suggestExperiments,
    launchExperiment,
    experimentReport,
    close: async () => {
      changeListeners.clear();
      await cachedClient?.close();
    },
  };
}
