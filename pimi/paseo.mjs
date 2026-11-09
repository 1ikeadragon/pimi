// Pimi addition to the Paseo fork. Apache-2.0.
import { createPaseoClient } from "@pimi/client";
import { buildAgentDeepLink } from "@pimi/protocol/agent-deep-link";
import { workspaceLabelKey } from "@pimi/protocol/workspace-labels";
import {
  PIMI_SPACES_ROUTE,
  PIMI_TASK_WORKER_LABEL,
  PIMI_VOICE_COMMAND_ROUTE,
  PimiWorkLabelCreateInput,
  PimiWorkLabelInput,
} from "@pimi/protocol/pimi-task";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

function localAgentUrl(settings) {
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
  return url;
}

export function createPaseoConnection(settingsSource = {}) {
  const workspaceRoot = settingsSource.taskState
    ? dirname(settingsSource.taskState)
    : join(tmpdir(), `pimi-work-${randomUUID()}`);
  let cachedClient;
  let connection;
  let daemonHost;
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
  function workspacePullRequest(workspace) {
    const git = workspace.gitRuntime;
    const runtime = workspace.githubRuntime;
    const pr = runtime?.pullRequest;
    if (
      !pr ||
      runtime.error ||
      git?.currentBranch !== pr.headRefName ||
      !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/.test(pr.url)
    ) {
      return undefined;
    }
    return {
      url: pr.url,
      title: pr.title,
      state: pr.isMerged ? "merged" : pr.state.toLowerCase() === "open" ? "open" : "closed",
      mergedAt: pr.mergedAt,
      matchesCheckout: Boolean(
        pr.headSha &&
        git.headSha === pr.headSha &&
        git.isDirty === false &&
        !["running", "needs_input", "failed"].includes(workspace.status) &&
        (git.aheadOfOrigin === 0 || git.aheadOfOrigin == null) &&
        (git.behindOfOrigin === 0 || git.behindOfOrigin == null),
      ),
    };
  }

  const workspaceView = (workspace) => ({
    id: workspace.id,
    path: workspace.workspaceDirectory,
    name: workspace.name,
    state: workspace.status,
    labels: workspace.labels ?? [],
    previews: runningPreviews(workspace.scripts),
    root: workspace.projectKind === "git" ? workspace.projectRootPath : undefined,
    pullRequest: workspacePullRequest(workspace),
    gitState: [
      workspace.gitRuntime?.isDirty,
      workspace.gitRuntime?.aheadBehind?.ahead,
      workspace.gitRuntime?.aheadOfOrigin,
      workspace.gitRuntime?.headSha,
    ],
  });
  const agentWork = (agent) => [agent.cwd, agent.workspaceId, agent.status, agent.needsInput];
  const workspaceWork = (workspace) => [
    workspace.path,
    workspace.root,
    workspace.state,
    workspace.pullRequest?.state === "open",
    workspace.gitState,
  ];

  function directoryObservation(value, workFields) {
    return {
      signature: signature(value),
      work: workFields && signature(workFields(value)),
      path: value.path,
      root: value.root,
    };
  }

  async function observeDirectory(client, connectedAt) {
    const agents = new Map();
    const workspaces = new Map();
    const reviewStates = new Map();
    const workspaceLabels = new Map();
    const pullRequestTransitions = new Map();
    const initialWorkspaceChanges = new Set();
    let initialized = false;
    function observeReview(id, workspace, live = false) {
      const previous = reviewStates.get(id);
      if (!workspace) {
        reviewStates.delete(id);
        if (live && previous?.reviewable) changed({ activity: "review" });
        return;
      }
      const git = workspace.gitRuntime;
      if (workspace.projectKind !== "git" || typeof git?.isDirty !== "boolean") return;
      const pr = workspacePullRequest(workspace);
      const prStatus = pr && workspace.githubRuntime.pullRequest;
      const stats = workspace.diffStat;
      const reviewable = Boolean(
        git.isDirty || git.aheadBehind?.ahead || stats?.additions || stats?.deletions || pr,
      );
      const fingerprint = JSON.stringify([
        git.currentBranch,
        git.headSha,
        git.isDirty,
        git.aheadBehind,
        stats,
        prStatus?.url,
        prStatus?.state,
        prStatus?.headSha,
        prStatus?.isDraft,
        prStatus?.checksStatus,
        prStatus?.reviewDecision,
      ]);
      reviewStates.set(id, { fingerprint, reviewable });
      if (live && (reviewable || previous?.reviewable) && previous?.fingerprint !== fingerprint) {
        // A checkout with no baseline may have just finished loading its first Git status.
        if (previous || !workspaces.has(id)) changed({ activity: "review" });
      }
    }
    function observePullRequest(id, workspace, isLive) {
      const pr = workspace?.pullRequest;
      const previous = pullRequestTransitions.get(id);
      const samePullRequest =
        pr &&
        previous?.url === pr.url &&
        previous.path === workspace.path &&
        previous.root === workspace.root;
      let observedMerge = false;
      if (pr?.state === "open") {
        pullRequestTransitions.set(id, { url: pr.url, path: workspace.path, root: workspace.root });
      } else if (
        isLive &&
        pr?.state === "merged" &&
        samePullRequest &&
        Date.parse(pr.mergedAt) >= connectedAt
      ) {
        // The forge and local checkout can settle in separate updates. Consume
        // the open observation only once the merged checkout is verified.
        if (pr.matchesCheckout) {
          observedMerge = true;
          pullRequestTransitions.delete(id);
        }
      } else if (pr || !workspace) {
        pullRequestTransitions.delete(id);
      }
      return workspace ? { workspace, observedMerge } : undefined;
    }
    const observe = (cache, id, value, event, workFields) => {
      const previous = cache.get(id) ?? {};
      const next = value ? directoryObservation(value, workFields) : {};
      if (previous.signature === next.signature) return;
      if (value) cache.set(id, next);
      else cache.delete(id);
      if (initialized && next.work !== previous.work) {
        const moved = next.path !== previous.path || next.root !== previous.root;
        changed({
          ...event,
          workActivity: true,
          path: next.path ?? previous.path,
          roots: moved ? [next.root, previous.root].filter(Boolean) : undefined,
        });
        return;
      }
      changed(event);
    };
    // These are directory state streams, never token/timeline streams.
    client.agents.subscribe((update) =>
      observe(
        agents,
        update.agent?.id ?? update.agentId,
        update.kind === "upsert" ? agentView(update.agent) : null,
        undefined,
        agentWork,
      ),
    );
    client.workspaces.subscribe((update) => {
      if (client !== cachedClient) return;
      const id = update.workspace?.id ?? update.id;
      const workspace = update.kind === "upsert" ? workspaceView(update.workspace) : null;
      if (!initialized) initialWorkspaceChanges.add(id);
      observeReview(id, update.kind === "upsert" ? update.workspace : null, initialized);
      const differs = !workspace || workspaces.get(id)?.signature !== signature(workspace);
      if (differs)
        observe(workspaces, id, workspace, observePullRequest(id, workspace, true), workspaceWork);
      observe(workspaceLabels, id, workspace && [workspace.path, workspace.labels], {
        labels: true,
      });
    });
    const labelEvents = Promise.resolve().then(() => {
      const subscription = client.workspaceLabels.observe();
      subscription.subscribe({
        snapshot: () => changed({ labels: true }),
        update(message) {
          if (message.type === "workspace.label.update") {
            changed({ labels: true, labelUpdate: message.payload });
          }
        },
      });
      return subscription.ready;
    });
    const gitEvents = client.observeEvents(["checkout_status_update"]);
    gitEvents.subscribe({
      snapshot() {},
      update(message) {
        if (message.type === "checkout_status_update") changed({ path: message.payload.cwd });
      },
    });
    const subscriptions = await Promise.allSettled([
      client.agents
        .list({ scope: "active", page: { limit: 200 }, subscribe: {} })
        .then(({ entries }) => {
          for (const { agent } of entries) {
            if (!agents.has(agent.id))
              agents.set(agent.id, directoryObservation(agentView(agent), agentWork));
          }
        }),
      client.workspaces
        .list({ page: { limit: 200 }, subscribe: {} })
        .then(async (first) => {
          let page = first;
          const cursors = new Set();
          while (client === cachedClient) {
            for (const entry of page.entries) {
              if (!initialWorkspaceChanges.has(entry.id)) {
                const workspace = workspaceView(entry);
                observeReview(entry.id, entry);
                observe(
                  workspaces,
                  entry.id,
                  workspace,
                  observePullRequest(entry.id, workspace, false),
                  workspaceWork,
                );
              }
            }
            const cursor = page.pageInfo.nextCursor;
            if (!cursor || cursors.has(cursor)) break;
            cursors.add(cursor);
            page = await client.workspaces.list({ page: { limit: 200, cursor } });
          }
        })
        .finally(() => {
          initialized = true;
          initialWorkspaceChanges.clear();
        }),
      gitEvents.ready,
      labelEvents,
    ]);
    if (client !== cachedClient) return;
    liveError = subscriptions.some((result) => result.status === "rejected")
      ? "Some agent service events are unavailable; checking automatically every few seconds."
      : undefined;
    changed({ labels: true });
  }

  async function connect() {
    if (cachedClient?.getConnectionState().status === "connected") return cachedClient;
    connection ??= (async () => {
      changed({ workspaceReset: true });
      const previous = cachedClient;
      cachedClient = undefined;
      await previous?.close();
      daemonHost = undefined;
      const settings = await settingsSource.connection?.();
      const url = localAgentUrl(settings);
      cachedClient = createPaseoClient({
        url: url.href,
        authHeader: process.env.PIMI_PASEO_AUTH_HEADER,
        localCredential: settings?.credential ? () => settings.credential : undefined,
        connectTimeoutMs: 2500,
        reconnect: { enabled: false },
      });
      await cachedClient.connect();
      const client = cachedClient;
      // GitHub reports merge times at second precision.
      void observeDirectory(client, Math.floor(Date.now() / 1000) * 1000).catch(() => {
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

  function getDaemonHost(client) {
    daemonHost ??= client.hosts.list().then(
      ({ self }) => self.serverId,
      (error) => {
        if (cachedClient === client) daemonHost = undefined;
        throw error;
      },
    );
    return daemonHost;
  }

  async function workspaceDirectory() {
    const client = await connect();
    const [workspaces, serverId] = await Promise.all([
      allPages(client.workspaces.list),
      getDaemonHost(client),
    ]);
    return { serverId, workspaces: workspaces.map(workspaceView) };
  }

  async function directory() {
    try {
      const client = await connect();
      const chatHost = settingsSource.native
        ? getDaemonHost(client).catch((error) => {
            console.warn("Pimi could not resolve agent chat links:", error.message);
          })
        : undefined;
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

  async function labels() {
    const client = await connect();
    const result = await client.workspaceLabels.list();
    return { labels: result.labels };
  }

  async function setWorkLabel(body) {
    const parsed = PimiWorkLabelInput.safeParse(body);
    if (!parsed.success) throw new RequestError(parsed.error.message);
    const { workspaceId, name, assigned } = parsed.data;
    const { labels: catalog } = await labels();
    const label = catalog.find(
      (entry) => workspaceLabelKey(entry.name) === workspaceLabelKey(name),
    );
    if (!label) throw new RequestError("Choose an existing Pimi label.");
    const result = await (await connect()).workspaceLabels.set({ workspaceId, label, assigned });
    changed({ labels: true });
    return result;
  }

  async function createWorkLabel(body) {
    const parsed = PimiWorkLabelCreateInput.safeParse(body);
    if (!parsed.success) throw new RequestError(parsed.error.message);
    const { workspaceId, name, color } = parsed.data;
    const result = await (
      await connect()
    ).workspaceLabels.set({
      workspaceId,
      label: { name, color },
      assigned: true,
    });
    changed({ labels: true });
    return result;
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

  async function startVoiceChat({
    workspaceId,
    agentId,
    chatProvider,
    prompt,
    attachments,
    images,
  }) {
    const client = await connect();
    const serverId = await getDaemonHost(client);
    let workspace = workspaceId ? client.workspaces.ref(workspaceId) : null;
    if (workspace) await workspace.refresh();
    if (!workspace?.directory) {
      const directory = join(workspaceRoot, "pimi-voice-chats");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      workspace = await client.workspaces.create({
        title: "Ask Pimi chats",
        source: { kind: "directory", path: directory },
      });
    }
    const activeAgent = agentId ? (await client.agents.ref(agentId).refresh())?.agent : null;
    const selected =
      activeAgent?.provider && activeAgent.model
        ? activeAgent
        : (chatProvider ?? (await reviewProvider(workspace.directory)));
    const agent = await workspace.agents.create({
      config: {
        provider: selected.model ? `${selected.provider}/${selected.model}` : selected.provider,
        thinkingOptionId:
          selected.effectiveThinkingOptionId ?? selected.thinkingOptionId ?? undefined,
      },
      prompt,
      attachments,
      images,
    });
    return { serverId, workspaceId: workspace.id, agentId: agent.id };
  }

  async function taskModels(cwd) {
    const client = await connect();
    const [{ config }, { entries }] = await Promise.all([
      client.config.get(),
      client.providers.waitForReady({ cwd, timeoutMs: 8000 }),
    ]);
    const configured = config.metadataGeneration?.providers?.[0];
    const ready = entries.filter((entry) => entry.enabled && entry.status === "ready");
    const models = ready.flatMap((entry) =>
      (entry.models ?? []).map((model) => ({
        id: `${entry.provider}/${model.id}`,
        label: `${entry.label ?? entry.provider} · ${model.label ?? model.id}`,
        thinkingOptionId: model.defaultThinkingOptionId ?? undefined,
      })),
    );
    const defaults = Object.fromEntries(
      ready.flatMap(({ provider, models: providerModels }) => {
        const preferred = providerModels?.find((model) => model.isDefault) ?? providerModels?.[0];
        return preferred ? [[provider, `${provider}/${preferred.id}`]] : [];
      }),
    );
    const preferred = configured && `${configured.provider}/${configured.model}`;
    return {
      models,
      defaults,
      preferred: models.find((model) => model.id === preferred)?.id ?? models[0]?.id,
    };
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

  async function taskParent(source) {
    const client = await connect();
    const { self } = await client.hosts.list();
    if (source.serverId !== self.serverId)
      throw new RequestError("Open the originating chat’s host to start its workers.", 409);
    const agent = client.agents.ref(source.agentId);
    const snapshot = await agent.refresh();
    if (!snapshot?.agent || snapshot.agent.archivedAt)
      throw new RequestError("Reopen the originating chat before starting its workers.", 409);
    const { attachment, truncated } = await agent.buildForkContext();
    if (!attachment)
      throw new RequestError("Couldn’t read context from the originating chat. Try again.", 409);
    return {
      parent: source,
      context: attachment,
      contextStatus: truncated ? "excerpt" : "included",
    };
  }

  async function launchExperiment(task, experiment) {
    const client = await connect();
    const slug = `pimi-${experiment.workspaceId.slice(4)}`;
    const { mode, parent, context } = experiment.launch;
    const chat = mode === "chat" || mode === "research";
    const cwd = chat ? join(workspaceRoot, mode, experiment.id) : task.root;
    if (chat) await mkdir(cwd, { recursive: true, mode: 0o700 });
    const workspace = await client.workspaces.create({
      idempotencyKey: slug,
      workspaceId: experiment.workspaceId,
      title: experiment.title,
      source: chat
        ? { kind: "directory", path: cwd }
        : {
            kind: "worktree",
            cwd,
            action: "branch-off",
            baseBranch: task.base,
            branchName: `pimi/${slug.slice(5)}`,
            worktreeSlug: slug,
          },
      agent: {
        agentId: experiment.id,
        cwd,
        title: experiment.title,
        config: experiment.launch.config,
        prompt: experiment.launch.prompt,
        ...(context ? { attachments: [context] } : {}),
        ...(parent
          ? {
              parent,
              notifyOnFinish: true,
              labels: { [PIMI_TASK_WORKER_LABEL]: task.id },
            }
          : {}),
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
    const work =
      task.mode === "chat"
        ? "independent work items that can run in chat with separate artifacts"
        : "distinct, independently testable implementations";
    const { text } = await explain({
      cwd: tmpdir(),
      model,
      instructions: "Propose work items from the brief alone. Do not inspect files or use tools.",
      prompt: `Propose two ${work} for this task. Give each a short title and concrete instructions.\n\n${task.title}\n${task.brief}`,
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

  async function localData(route, feature, input, timeoutMs = 6000) {
    const settings = await settingsSource.connection?.();
    if (!settingsSource.native || !settings?.localDataCredential) {
      throw new RequestError(`Connect Pimi to its local agent host to open ${feature}.`, 503);
    }
    const url = localAgentUrl(settings);
    url.protocol = "http:";
    url.pathname = route;
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: "Bearer " + settings.localDataCredential,
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new RequestError(`Couldn’t reach ${feature} on the local host. Try again.`, 503);
    }
    if (!response.headers.get("content-type")?.startsWith("application/json")) {
      throw new RequestError(`Update the local agent host to open ${feature} in Pimi.`, 503);
    }
    const payload = await response.json();
    if (!response.ok)
      throw new RequestError(payload.error || `${feature} is unavailable.`, response.status);
    return payload;
  }

  return {
    directory,
    workspaceDirectory,
    observeWorkspaces: async () => {
      await connect();
    },
    localServerId: async () => getDaemonHost(await connect()),
    labels,
    setWorkLabel,
    createWorkLabel,
    memory: (input) => localData("/api/pimi/memory", "Memory", input),
    spaces: (input) => localData(PIMI_SPACES_ROUTE, "Spaces", input),
    // Allow for provider discovery and startup as well as the classification turn.
    resolveVoiceCommand: (input) => localData(PIMI_VOICE_COMMAND_ROUTE, "Ask Pimi", input, 150_000),
    startVoiceChat,
    subscribe(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    explain,
    taskModels,
    checkTaskModel,
    suggestExperiments,
    taskParent,
    launchExperiment,
    experimentReport,
    close: async () => {
      changeListeners.clear();
      await cachedClient?.close();
    },
  };
}
