// Pimi addition to the Paseo fork. Apache-2.0.
import { createPaseoClient } from "@getpaseo/client";

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

  async function connect() {
    if (cachedClient?.getConnectionState().status === "connected") return cachedClient;
    connection ??= (async () => {
      await cachedClient?.close();
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
      return cachedClient;
    })().finally(() => {
      connection = undefined;
    });
    return connection;
  }

  async function directory() {
    try {
      const client = await connect();
      const [agents, workspaces] = await Promise.all([
        allPages((options) => client.agents.list({ ...options, scope: "active" })),
        allPages(client.workspaces.list),
      ]);
      return {
        agents: agents.map(({ agent }) => ({
          id: agent.id,
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
        })),
        workspaces: workspaces.map((workspace) => ({
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
        })),
      };
    } catch (error) {
      return { agents: [], workspaces: [], error: error.message };
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

  async function explain({ cwd, currentAgent, prompt, schema, instructions }) {
    const client = await connect();
    const selected = await reviewProvider(cwd, currentAgent);
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

  return {
    directory,
    explain,
    close: async () => {
      await cachedClient?.close();
    },
  };
}
