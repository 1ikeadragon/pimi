// Pimi. PolyForm-Noncommercial-1.0.0.
import { createPimiApi } from "@pimi/client";
import { DaemonClient } from "@pimi/client/internal/daemon-client";
import {
  PIMI_ASK_STREAM_TYPE,
  PIMI_SPACES_ROUTE,
  PIMI_VOICE_COMMAND_ROUTE,
  PimiAskEvent,
} from "@pimi/protocol/pimi-task";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

function localAgentUrl(settings) {
  const url = new URL(settings?.url || process.env.PIMI_DAEMON_URL || "ws://127.0.0.1:6767/ws");
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

export function createPimiConnection(settingsSource = {}) {
  const workspaceRoot = settingsSource.dataHome ?? join(tmpdir(), `pimi-${randomUUID()}`);
  let cachedClient;
  let connection;
  let daemonHost;
  const changeListeners = new Set();

  const changed = (event = {}) => {
    for (const listener of changeListeners) listener(event);
  };
  function pullRequestState(pr) {
    if (pr.isMerged) return "merged";
    return pr.state.toLowerCase() === "open" ? "open" : "closed";
  }

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
    return { state: pullRequestState(pr) };
  }

  const workspaceView = (workspace) => ({
    id: workspace.id,
    path: workspace.workspaceDirectory,
    name: workspace.name,
    branch: workspace.gitRuntime?.currentBranch ?? undefined,
  });

  // Emits a "review" activity when a checkout gains, changes or loses reviewable changes.
  async function observeReviewActivity(client) {
    const reviewStates = new Map();
    const known = new Set();
    const initialChanges = new Set();
    let initialized = false;
    function isReviewable(git, stats, pr) {
      return Boolean(
        git.isDirty || git.aheadBehind?.ahead || stats?.additions || stats?.deletions || pr,
      );
    }
    function reviewFingerprint(git, stats, prStatus) {
      return JSON.stringify([
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
    }
    function observeReview(id, workspace, live) {
      const previous = reviewStates.get(id);
      if (!workspace) {
        reviewStates.delete(id);
        known.delete(id);
        if (live && previous?.reviewable) changed({ activity: "review" });
        return;
      }
      const git = workspace.gitRuntime;
      if (workspace.projectKind !== "git" || typeof git?.isDirty !== "boolean") return;
      const pr = workspacePullRequest(workspace);
      const prStatus = pr && workspace.githubRuntime.pullRequest;
      const stats = workspace.diffStat;
      const reviewable = isReviewable(git, stats, pr);
      const fingerprint = reviewFingerprint(git, stats, prStatus);
      reviewStates.set(id, { fingerprint, reviewable });
      if (live && (reviewable || previous?.reviewable) && previous?.fingerprint !== fingerprint) {
        // A checkout with no baseline may have just finished loading its first Git status.
        if (previous || !known.has(id)) changed({ activity: "review" });
      }
      known.add(id);
    }
    client.workspaces.subscribe((update) => {
      if (client !== cachedClient) return;
      const id = update.workspace?.id ?? update.id;
      if (!initialized) initialChanges.add(id);
      observeReview(id, update.kind === "upsert" ? update.workspace : null, initialized);
    });
    // Stops paging as soon as a reconnect replaces this client: the check sits
    // after each awaited page because cachedClient changes while we wait.
    let page = await client.workspaces.list({ page: { limit: 200 }, subscribe: {} });
    const cursors = new Set();
    try {
      for (;;) {
        if (client !== cachedClient) return;
        for (const entry of page.entries) {
          if (!initialChanges.has(entry.id)) observeReview(entry.id, entry, false);
        }
        const cursor = page.pageInfo.nextCursor;
        if (!cursor || cursors.has(cursor)) return;
        cursors.add(cursor);
        page = await client.workspaces.list({ page: { limit: 200, cursor } });
      }
    } finally {
      initialized = true;
      initialChanges.clear();
    }
  }

  async function connect() {
    if (cachedClient?.getConnectionState().status === "connected") return cachedClient;
    connection ??= (async () => {
      const previous = cachedClient;
      cachedClient = undefined;
      await previous?.close();
      daemonHost = undefined;
      const settings = await settingsSource.connection?.();
      const url = localAgentUrl(settings);
      // The SDK facade has no task methods, so keep the daemon client beside it.
      const daemon = new DaemonClient({
        url: url.href,
        clientId: `pimi-desktop-${randomUUID()}`,
        clientType: "cli",
        authHeader: process.env.PIMI_DAEMON_AUTH_HEADER,
        localCredential: settings?.credential ? () => settings.credential : undefined,
        connectTimeoutMs: 2500,
        reconnect: { enabled: false },
      });
      const api = createPimiApi(daemon);
      cachedClient = {
        ...api,
        daemon,
        connect: () => daemon.connect(),
        close: async () => {
          try {
            await api.dispose();
          } finally {
            await daemon.close();
          }
        },
        getConnectionState: () => daemon.getConnectionState(),
      };
      await cachedClient.connect();
      const client = cachedClient;
      void observeReviewActivity(client).catch((error) => {
        console.warn("Pimi could not observe review activity:", error.message);
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
      const voiceDirectory = join(workspaceRoot, "pimi-voice-chats");
      await mkdir(voiceDirectory, { recursive: true, mode: 0o700 });
      workspace = await client.workspaces.create({
        title: "Ask Pimi chats",
        source: { kind: "directory", path: voiceDirectory },
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

  async function localRequest(route, feature, input, timeoutMs) {
    const settings = await settingsSource.connection?.();
    if (!settingsSource.native || !settings?.localDataCredential) {
      throw new RequestError(`Connect Pimi to its local agent host to open ${feature}.`, 503);
    }
    const url = localAgentUrl(settings);
    url.protocol = "http:";
    url.pathname = route;
    try {
      return await fetch(url, {
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
  }

  async function localData(route, feature, input, timeoutMs = 6000) {
    const response = await localRequest(route, feature, input, timeoutMs);
    const payload = await response.json();
    if (!response.ok)
      throw new RequestError(payload.error || `${feature} is unavailable.`, response.status);
    return payload;
  }

  // Ask Pimi reports progress while it works, then sends one result or error line.
  async function askPimi(input, onStatus) {
    const feature = "Ask Pimi";
    const response = await localRequest(PIMI_VOICE_COMMAND_ROUTE, feature, input, 150_000);
    const type = response.headers.get("content-type") ?? "";
    if (!response.ok || !type.startsWith(PIMI_ASK_STREAM_TYPE) || !response.body) {
      const payload = type.startsWith("application/json") ? await response.json() : {};
      throw new RequestError(payload.error || `${feature} is unavailable.`, response.status);
    }
    const lost = new RequestError(`Couldn’t reach ${feature} on the local host. Try again.`, 503);
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      for await (const chunk of response.body) {
        buffered += decoder.decode(chunk, { stream: true });
        if (buffered.length > 64 * 1024) throw lost;
        let end;
        while ((end = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, end);
          buffered = buffered.slice(end + 1);
          if (!line.trim()) continue;
          const event = PimiAskEvent.parse(JSON.parse(line));
          if (event.type === "status") onStatus?.(event.text);
          else if (event.type === "error") throw new RequestError(event.error, 502);
          else return event.result;
        }
      }
    } catch (error) {
      throw error instanceof RequestError ? error : lost;
    }
    throw lost;
  }

  return {
    workspaceDirectory,
    observeWorkspaces: async () => {
      await connect();
    },
    taskList: async () => (await (await connect()).daemon.taskList()).tasks,
    taskImport: async (tasks) => (await connect()).daemon.taskImport({ tasks }),
    localServerId: async () => getDaemonHost(await connect()),
    memory: (input) => localData("/api/pimi/memory", "Memory", input),
    spaces: (input) => localData(PIMI_SPACES_ROUTE, "Spaces", input),
    // Allow for provider discovery and startup as well as the classification turn.
    askPimi,
    startVoiceChat,
    subscribe(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    close: async () => {
      changeListeners.clear();
      await cachedClient?.close();
    },
  };
}
