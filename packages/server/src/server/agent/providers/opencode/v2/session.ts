import { OpenCodeBackgroundInventory } from "./background-inventory.js";
import { SessionChildren } from "./children.js";
import { SessionTurns } from "./turns.js";
import { V2Timeline } from "./timeline.js";
import { ModelWait } from "./model-wait.js";
import { FAILURE_WARNING_ATTEMPT, reconnectDelayMs } from "../event-consumer.js";
import { waitForLocationReady, awaitPimiPlugin } from "./readiness.js";

import type { OpenCodeEvent, SessionInfo, SessionMessageInfo } from "@opencode/client";

import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type {
  AgentMode,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunOptions,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentUsageSession,
  SteerActiveTurnOptions,
  SteerResult,
} from "../../../agent-sdk-types.js";

import { toDiagnosticErrorMessage } from "../../diagnostic-utils.js";

import { runProviderTurn } from "../../provider-runner.js";

import { composeSystemPromptParts } from "../../../system-prompt.js";
import { raceProviderRefreshAbort } from "../../../provider-refresh-deadline.js";

import { type V2Connection } from "./runtime.js";
import { modelRef, modesFromV2 } from "./mapping.js";

import { V2_CAPABILITIES } from "./capabilities.js";
import { features } from "./configuration.js";
import { commands } from "./commands.js";
import { messages } from "./history.js";
import { SessionPermissions } from "./permissions.js";
import { SessionUsage } from "./usage.js";
import { ToolCallOutputStream } from "../../../tool-call-output-stream.js";
import { ShellOutputTail } from "./shell-tail.js";

// The first connection must reconcile within this bound or `initialize` fails (`startStream`).
// A reconnect applies the same bound to the same work, so a hung request cannot hold the event
// loop forever. Reconciling reads whole histories, so it gets the readiness bound, not the 5s of
// a single plugin poll (readiness.ts).
const STREAM_READY_TIMEOUT_MS = 30_000;

export class OpenCodeConnectionReconcileTimeoutError extends Error {
  constructor(readonly waitedMs: number) {
    super(`OpenCode did not finish reconciling after reconnecting within ${waitedMs}ms`);
    this.name = "OpenCodeConnectionReconcileTimeoutError";
  }
}

export class OpenCodeV2Session implements AgentSession {
  readonly provider = "opencode";
  readonly capabilities = V2_CAPABILITIES;
  private readonly listeners = new Set<(event: AgentStreamEvent) => void>();
  private readonly usageSessionKey = randomUUID();
  private readonly timeline = new V2Timeline((divergence) =>
    this.logger.warn({ ...divergence, sessionId: this.info.id }, "OpenCode rewrote published text"),
  );
  private readonly modelWait = new ModelWait((since) =>
    this.emit({ type: "model_wait_changed", provider: "opencode", since }),
  );
  private readonly abort = new AbortController();
  private readonly permissions: SessionPermissions;
  private readonly turns: SessionTurns;
  private readonly children: SessionChildren;
  private readonly usage: SessionUsage;
  private readonly toolOutput: ToolCallOutputStream;
  private readonly shellTail: ShellOutputTail;
  private stream: Promise<void> | null = null;
  private streamAbort = new AbortController();
  private exited = false;
  private reconnecting: Promise<void> | null = null;
  private launchEnv: Record<string, string> | undefined;
  private sync: Promise<void> = Promise.resolve();
  private dirty = false;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private history: SessionMessageInfo[] = [];
  private readonly background: OpenCodeBackgroundInventory;
  private modes: AgentMode[] = [];
  constructor(
    private connection: V2Connection,
    private info: SessionInfo,
    private readonly config: AgentSessionConfig,
    private readonly logger: Logger,
    private readonly persist: boolean,
    private readonly requiresPimiPlugin: boolean,
    private readonly harnessEnvironment: Record<string, string>,
    private readonly unbind?: () => void,
    bindChild?: (id: string) => void,
    private readonly acquire?: () => Promise<V2Connection>,
    private readonly moved?: (connection: V2Connection) => void,
  ) {
    this.background = new OpenCodeBackgroundInventory({
      id: info.id,
      cwd: config.cwd,
      emit: (event) => this.emit(event),
      report: (error) =>
        this.logger.warn(
          { error: toDiagnosticErrorMessage(error) },
          "OpenCode background inventory failed",
        ),
    });
    this.permissions = new SessionPermissions(
      () => this.client,
      info.id,
      config,
      (event) => this.emit(event),
    );
    this.children = new SessionChildren({
      client: () => this.client,
      id: info.id,
      emit: (event) => this.emit(event),
      reconcilePermissions: (id) => this.permissions.reconcile(id),
      bindChild,
      reportError: (error) =>
        this.logger.warn({ error: toDiagnosticErrorMessage(error) }, "OpenCode child sync failed"),
      reportDivergence: (divergence) =>
        this.logger.warn({ ...divergence, sessionId: this.info.id }, "OpenCode child rewrote text"),
    });
    this.turns = new SessionTurns({
      client: () => this.client,
      id: info.id,
      cwd: config.cwd,
      signal: this.abort.signal,
      emit: (event) => this.emit(event),
      reconcile: async () => {
        await this.reconcile();
        return { info: this.info, history: this.history };
      },
      reportReconciliationError: (error) =>
        this.logger.warn(
          { error: toDiagnosticErrorMessage(error) },
          "OpenCode turn reconciliation failed; retrying",
        ),
      clearPermissions: async () => {
        for (const request of this.permissions.list())
          await this.permissions.respondToPermission(request.id, {
            behavior: "deny",
            message:
              "The user answered with a message instead of approving. Their message follows.",
          });
      },
    });
    this.toolOutput = new ToolCallOutputStream((update) =>
      this.emit({
        type: "tool_call_output",
        provider: "opencode",
        ...update,
        ...(this.turns.id ? { turnId: this.turns.id } : {}),
      }),
    );
    this.shellTail = new ShellOutputTail({
      client: () => this.client,
      cwd: config.cwd,
      signal: this.abort.signal,
      output: this.toolOutput,
      reportError: (error) =>
        this.logger.warn(
          { error: toDiagnosticErrorMessage(error) },
          "OpenCode shell output tail failed",
        ),
    });
    this.usage = new SessionUsage({
      client: () => this.client,
      cwd: config.cwd,
      info: () => this.info,
      emit: (event) => this.emit(event),
      reportError: (error) =>
        this.logger.warn(
          { error: toDiagnosticErrorMessage(error) },
          "OpenCode context usage update failed",
        ),
    });
  }
  usageSession(): AgentUsageSession | null {
    if (this.closed) return null;
    return {
      provider: this.provider,
      model: this.info.model
        ? `${this.info.model.providerID}/${this.info.model.id}`
        : this.config.model,
      env: this.harnessEnvironment,
      sessionKey: this.usageSessionKey,
    };
  }
  get id() {
    return this.info.id;
  }
  get features() {
    return features(this.config);
  }
  private get client() {
    return this.connection.client;
  }
  async initialize(environment?: Record<string, string>) {
    // OpenCode replaces the whole local shell environment, rather than overlaying it.
    this.launchEnv = environment;
    this.watchExit(this.connection);
    await this.configureConnection();
    const location = { directory: this.config.cwd };
    this.modes = modesFromV2((await this.client.agent.list({ location })).data);
    await this.timeline.messages(await messages(this.client, this.id), () => {});
    await this.startStream();
    await this.children.reconcile(this.id);
  }
  private watchExit(connection: V2Connection) {
    void connection.exited.then((error) => {
      if (this.closed || this.connection !== connection) return undefined;
      this.exited = true;
      this.background.disconnect(true);
      this.streamAbort.abort(error);
      this.turns.fail(error);
      return undefined;
    });
  }
  private async configureConnection() {
    const location = { directory: this.config.cwd };
    await this.connection.bindSession(this.id, this.config.cwd);
    await waitForLocationReady({ client: this.client, location, signal: this.abort.signal });
    if (this.requiresPimiPlugin)
      await awaitPimiPlugin({ client: this.client, location, signal: this.abort.signal });
    for (const [server, config] of Object.entries(this.config.mcpServers ?? {})) {
      await this.client.mcp.add({
        server,
        location,
        config:
          config.type === "stdio"
            ? {
                type: "local",
                command: [config.command, ...(config.args ?? [])],
                environment: config.env,
                codemode: false,
              }
            : {
                type: "remote",
                url: config.url,
                headers: config.headers,
                oauth: false,
                codemode: false,
              },
      });
      await this.awaitMcp(server);
    }
    const system = composeSystemPromptParts(
      this.config.systemPrompt,
      this.config.daemonAppendSystemPrompt,
    );
    if (system)
      await this.client.session.instructions.entry.put({
        sessionID: this.id,
        key: "pimi",
        value: system,
      });
  }
  private async startStream() {
    let ready!: () => void;
    let fail!: (error: unknown) => void;
    const first = new Promise<void>((resolve, reject) => {
      ready = resolve;
      fail = reject;
    });
    this.stream = this.consume(ready, fail);
    await raceProviderRefreshAbort(
      AbortSignal.any([this.abort.signal, AbortSignal.timeout(STREAM_READY_TIMEOUT_MS)]),
      first,
    );
  }
  private async reconnectIfExited() {
    if (this.closed) throw new Error("OpenCode session is closed");
    if (!this.exited) return;
    this.reconnecting ??= this.reconnect().finally(() => {
      this.reconnecting = null;
    });
    await this.reconnecting;
  }
  private async reconnect() {
    if (!this.acquire) throw new Error("OpenCode helper server exited");
    await this.stream;
    await this.sync.catch(() => undefined);
    await this.connection
      .unbindSession(this.id, this.config.cwd)
      .catch((error: unknown) =>
        this.logger.warn({ error }, "Could not unbind the OpenCode Pimi bridge"),
      );
    const next = await this.acquire();
    if (this.closed) {
      await next.release();
      throw new Error("OpenCode session is closed");
    }
    const old = this.connection;
    this.connection = next;
    this.streamAbort = new AbortController();
    this.exited = false;
    this.watchExit(next);
    try {
      await this.configureConnection();
      await this.startStream();
    } catch (error) {
      this.connection = old;
      this.exited = true;
      this.streamAbort.abort();
      await next.release();
      throw error;
    }
    this.moved?.(next);
    await old.release();
  }
  subscribe(callback: (event: AgentStreamEvent) => void) {
    this.listeners.add(callback);
    const background = this.background.snapshot();
    if (background) callback(background);
    // Reopening can adopt an execution during initialization, before its caller
    // can subscribe. Deliver that live turn so it remains visible and interruptible.
    if (this.turns.id)
      callback({ type: "turn_started", provider: "opencode", turnId: this.turns.id });
    return () => {
      this.listeners.delete(callback);
    };
  }
  private async awaitMcp(server: string) {
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000)]);
    while (true) {
      const catalog = await this.client.mcp.list(
        { location: { directory: this.config.cwd } },
        { signal },
      );
      const entry = catalog.data.find((item) => item.name === server);
      if (entry?.status.status === "connected") return;
      if (entry && entry.status.status !== "pending") {
        const reason = entry.status.status === "failed" ? entry.status.error : entry.status.status;
        throw new Error(`OpenCode MCP server ${server} failed to connect: ${reason}`);
      }
      await delay(50, undefined, { signal });
    }
  }
  private emit(event: AgentStreamEvent) {
    if (
      event.type === "turn_completed" ||
      event.type === "turn_failed" ||
      event.type === "turn_canceled"
    ) {
      this.modelWait.end();
      this.shellTail.stopAll();
    }
    this.toolOutput.observe(event);
    for (const listener of this.listeners) listener(event);
  }
  private emitTimeline(event: AgentStreamEvent) {
    this.emit({ ...event, ...(this.turns.id ? { turnId: this.turns.id } : {}) });
  }
  async *streamHistory() {
    await this.reconnectIfExited();
    const history = new V2Timeline(
      (divergence) =>
        this.logger.warn(
          { ...divergence, sessionId: this.info.id },
          "OpenCode history rewrote published text",
        ),
      false,
    );
    const events: AgentStreamEvent[] = [];
    await history.messages(await messages(this.client, this.id), (event) => {
      events.push(event);
    });
    yield* events;
  }
  async getRuntimeInfo() {
    await this.reconnectIfExited();
    this.info = await this.client.session.get({ sessionID: this.id });
    return {
      provider: "opencode",
      sessionId: this.id,
      model: this.info.model ? `${this.info.model.providerID}/${this.info.model.id}` : null,
      modeId: this.info.agent ?? null,
      thinkingOptionId: this.info.model?.variant ?? null,
    };
  }
  async getAvailableModes() {
    return this.modes;
  }
  async getCurrentMode() {
    return this.info.agent ?? null;
  }
  async setMode(modeId: string) {
    await this.reconnectIfExited();
    await this.client.session.switchAgent({ sessionID: this.id, agent: modeId });
    this.info.agent = modeId;
    this.config.modeId = modeId;
    this.emit({
      type: "mode_changed",
      provider: "opencode",
      currentModeId: modeId,
      availableModes: this.modes,
    });
  }
  async setModel(model: string | null) {
    await this.reconnectIfExited();
    const location = { directory: this.config.cwd };
    const selected = model ? modelRef(model) : (await this.client.model.default({ location })).data;
    if (!selected) throw new Error("OpenCode has no default model");
    const catalog = await this.client.model.list({ location });
    const target = catalog.data.find(
      (entry) =>
        entry.enabled && entry.providerID === selected.providerID && entry.id === selected.id,
    );
    if (!target)
      throw new Error(`OpenCode model unavailable: ${selected.providerID}/${selected.id}`);
    const retainedVariant = this.config.thinkingOptionId;
    const variant =
      retainedVariant !== "default" && target.variants.some((entry) => entry.id === retainedVariant)
        ? retainedVariant
        : undefined;
    const nextModel = {
      id: selected.id,
      providerID: selected.providerID,
      ...(variant ? { variant } : {}),
    };
    await this.client.session.switchModel({ sessionID: this.id, model: nextModel });
    this.info.model = nextModel;
    this.config.model = model ?? undefined;
    this.config.thinkingOptionId = variant;
    this.emit({
      type: "thinking_option_changed",
      provider: "opencode",
      thinkingOptionId: variant ?? null,
    });
    this.emit({
      type: "model_changed",
      provider: "opencode",
      runtimeInfo: {
        provider: "opencode",
        sessionId: this.id,
        model: `${selected.providerID}/${selected.id}`,
        modeId: this.info.agent ?? null,
        thinkingOptionId: variant ?? null,
      },
    });
  }

  async setThinkingOption(variant: string | null) {
    await this.reconnectIfExited();
    const model = this.info.model;
    if (!model) throw new Error("Select an OpenCode model before changing its variant");
    await this.client.session.switchModel({
      sessionID: this.id,
      model: { id: model.id, providerID: model.providerID, ...(variant ? { variant } : {}) },
    });
    this.config.thinkingOptionId = variant ?? undefined;
    this.info = await this.client.session.get({ sessionID: this.id });
    this.emit({ type: "thinking_option_changed", provider: "opencode", thinkingOptionId: variant });
  }
  async setFeature(id: string, value: unknown) {
    if (id !== "auto_accept" || typeof value !== "boolean")
      throw new Error("Unknown OpenCode feature");
    this.config.featureValues = { ...this.config.featureValues, [id]: value };
    if (value && !this.config.toolPolicy)
      for (const request of this.permissions.list())
        if (request.kind !== "question")
          await this.respondToPermission(request.id, { behavior: "allow" });
  }
  async listCommands() {
    await this.reconnectIfExited();
    return commands(this.client, this.config.cwd);
  }
  describePersistence(): AgentPersistenceHandle {
    return {
      provider: "opencode",
      sessionId: this.id,
      nativeHandle: this.id,
      metadata: { ...this.config },
    };
  }
  run(prompt: AgentPromptInput, options?: AgentRunOptions) {
    return runProviderTurn({
      prompt,
      runOptions: options,
      startTurn: this.startTurn.bind(this),
      subscribe: this.subscribe.bind(this),
      getSessionId: () => this.id,
      reduceFinalText: ({ current, item }) =>
        item.type === "assistant_message" ? current + item.text : current,
    });
  }
  async startTurn(prompt: AgentPromptInput, options?: AgentRunOptions) {
    await this.reconnectIfExited();
    await this.connection.bindSession(this.id, this.config.cwd);
    return this.turns.startTurn(prompt, options);
  }
  steerActiveTurn(prompt: AgentPromptInput, options: SteerActiveTurnOptions): Promise<SteerResult> {
    return this.turns.steerActiveTurn(prompt, options);
  }
  /** A child session is an ordinary OpenCode session; a running one takes the text as a steer. */
  async sendProviderSubagentMessage(subagentId: string, text: string) {
    if (!this.children.has(subagentId)) throw new Error("This subagent can no longer be messaged");
    await this.reconnectIfExited();
    const active = await this.client.session.active();
    await this.client.session.prompt({
      sessionID: subagentId,
      text,
      files: [],
      ...(active[subagentId] ? { delivery: "steer" as const } : {}),
    });
    await this.children.reconcile(this.id);
  }
  stopBackgroundWork(id: string) {
    return this.background.stopItem(id);
  }
  interrupt() {
    return this.turns.interrupt();
  }
  async revertBoth(input: { messageId: string }) {
    await this.interrupt();
    await this.reconnectIfExited();
    await this.client.session.revert.stage({
      sessionID: this.id,
      messageID: input.messageId,
      files: true,
    });
    await this.client.session.revert.commit({ sessionID: this.id });
  }
  getPendingPermissions() {
    return [...this.permissions.list()];
  }
  async respondToPermission(requestId: string, response: AgentPermissionResponse) {
    await this.reconnectIfExited();
    const deniesOwnRequest =
      response.behavior === "deny" && this.permissions.isOwnedBy(requestId, this.id);
    await this.permissions.respondToPermission(requestId, response);
    if (deniesOwnRequest) this.turns.requestDenied();
  }
  private async reconcileSnapshot() {
    const [info, history] = await Promise.all([
      this.client.session.get({ sessionID: this.id }),
      messages(this.client, this.id),
    ]);
    this.info = info;
    this.history = history;
    await this.timeline.messages(history, (event) => this.emitTimeline(event));
    await this.permissions.reconcile(this.id);
  }
  private async reconcile() {
    this.dirty = true;
    this.sync = this.sync.catch(() => undefined).then(() => this.drainReconciliation());
    return this.sync;
  }
  private async drainReconciliation() {
    while (this.dirty && !this.closed) {
      this.dirty = false;
      await this.reconcileSnapshot();
    }
  }
  // The abandoned reconcile keeps running and holds `sync`, so a retry waits behind it and times
  // out in turn; that surfaces as a warning per attempt instead of a silent stall.
  private async reconcileConnectionWithin(timeoutMs: number) {
    try {
      await raceProviderRefreshAbort(AbortSignal.timeout(timeoutMs), this.reconcileConnection());
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError")
        throw new OpenCodeConnectionReconcileTimeoutError(timeoutMs);
      throw error;
    }
  }
  private async reconcileConnection() {
    await this.connection.bindSession(this.id, this.config.cwd);
    // Session environments are process-local. Reapply this agent's snapshot before
    // reconciling a new connection, including event-stream reconnections.
    if (this.launchEnv)
      await this.client.session.environment({ sessionID: this.id, variables: this.launchEnv });
    await this.reconcile();
    await this.children.reconcile(this.id);
    await this.turns.reconcile();
  }
  private scheduleReconcile() {
    if (this.refreshTimer || this.closed) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.reconcile().catch((error: unknown) =>
        this.logger.warn(
          { error: toDiagnosticErrorMessage(error) },
          "OpenCode reconciliation failed",
        ),
      );
    }, 25);
  }
  private observeOwnEvent(event: import("@opencode/client").OpenCodeEvent) {
    if (event.type === "form.created" && event.data.form.sessionID === this.id) {
      this.scheduleReconcile();
      return;
    }
    if (!("sessionID" in event.data) || event.data.sessionID !== this.id) return;
    this.modelWait.observe(event);
    if (event.type === "session.retry.scheduled") {
      // v1 shows the same item for its `session.status` retry. OpenCode retries without a limit,
      // so without it a failing gateway reads as a turn that is merely working.
      this.emitTimeline({
        type: "timeline",
        provider: "opencode",
        item: { type: "error", message: retryMessage(event) },
      });
      return;
    }
    if (event.type === "session.text.started" || event.type === "session.reasoning.started") {
      if (event.type === "session.text.started" && this.turns.hasStructuredOutput) return;
      this.timeline.startPart({
        ...event.data,
        type: event.type === "session.text.started" ? "text" : "reasoning",
      });
      return;
    }
    if (event.type === "session.text.delta" || event.type === "session.reasoning.delta") {
      const isText = event.type === "session.text.delta";
      // A structured-output turn supplies its answer through a tool, so streamed
      // prose is not part of the result and must not reach the timeline.
      if (isText && this.turns.hasStructuredOutput) return;
      for (const streamed of this.timeline.delta({
        assistantMessageID: event.data.assistantMessageID,
        ordinal: event.data.ordinal,
        delta: event.data.delta,
        type: isText ? "text" : "reasoning",
      }))
        this.emitTimeline(streamed);
      return;
    }
    if (event.type === "session.tool.progress")
      this.shellTail.progress(event.data.id, event.data.metadata);
    else if (event.type === "session.tool.success" || event.type === "session.tool.failed")
      this.shellTail.finished(event.data.id);
    this.permissions.observe(event);
    this.usage.observe(event);
    this.turns.observe(event);
    this.scheduleReconcile();
  }
  /** Applies one event; returns true when it was the connection handshake and reconciled. */
  private async handleStreamEvent(
    event: import("@opencode/client").OpenCodeEvent,
    signal: AbortSignal,
    progress: { handlingFailed: boolean },
  ): Promise<boolean> {
    const handshake = event.type === "server.connected";
    try {
      if (handshake) {
        // Output events missed during a gap cannot be attributed, so the wait cannot be trusted.
        this.modelWait.end();
        this.timeline.resetStreams();
        await this.reconcileConnectionWithin(STREAM_READY_TIMEOUT_MS);
        signal.throwIfAborted();
        this.background.start(this.client);
      }
      this.background.observe(event);
      this.children.observe(event);
      this.observeOwnEvent(event);
    } catch (error) {
      progress.handlingFailed = true;
      throw error;
    }
    return handshake;
  }
  // A server Pimi did not start (explicit or discovered) can die with nobody to report it. After as
  // many consecutive failures as the v1 event consumer tolerates before it warns
  // (`FAILURE_WARNING_ATTEMPT`), release it so this and every other session select a server again.
  private declareUnreachable(consecutiveFailures: number): boolean {
    const { unreachable } = this.connection;
    if (!unreachable || consecutiveFailures < FAILURE_WARNING_ATTEMPT) return false;
    const error = new Error(
      `OpenCode server unreachable after ${consecutiveFailures} failed event stream attempts`,
    );
    this.logger.warn({ error: error.message }, "OpenCode server unreachable; releasing it");
    unreachable(error);
    return true;
  }
  private async consume(ready: () => void, fail: (error: unknown) => void) {
    const signal = AbortSignal.any([this.abort.signal, this.streamAbort.signal]);
    let connected = false;
    let reconnectAttempt = 0;
    while (!this.closed && !signal.aborted) {
      // Only a connection that reconciled and then lost its transport counts as progress. One that
      // fails while handling an event would otherwise reset the backoff and retry every 100ms.
      let established = false;
      const progress = { handlingFailed: false };
      try {
        for await (const event of this.client.event.subscribe({ signal })) {
          if (this.closed || signal.aborted) return;
          if (await this.handleStreamEvent(event, signal, progress)) {
            connected = true;
            established = true;
            ready();
          }
        }
        if (!connected) throw new Error("OpenCode event stream ended before connecting");
        this.logger.warn("OpenCode event stream ended; reconciling on reconnect");
      } catch (error) {
        if (this.closed || signal.aborted) return;
        if (!connected) {
          fail(error);
          return;
        }
        this.logger.warn(
          { error: toDiagnosticErrorMessage(error) },
          "OpenCode event stream interrupted; reconciling on reconnect",
        );
      }
      this.background.disconnect();
      reconnectAttempt = established && !progress.handlingFailed ? 0 : reconnectAttempt + 1;
      if (this.declareUnreachable(reconnectAttempt)) return;
      await delay(reconnectDelayMs(reconnectAttempt), undefined, { signal }).catch(() => undefined);
    }
  }
  async canStopRuntime(): Promise<boolean> {
    if (this.closed || this.exited || this.reconnecting || this.turns.id || this.dirty)
      return false;
    const request = { signal: AbortSignal.timeout(10_000) };
    // Active executions are server-wide. Releasing the last lease must not stop an
    // autonomous execution merely because it belongs to another session or location.
    if (Object.keys(await this.client.session.active(request)).length > 0) return false;
    const family = new Map([[this.info.id, this.info]]);
    const directories = new Set<string>();
    for (const info of family.values()) {
      if ((await this.client.session.inbox.list({ sessionID: info.id }, request)).length)
        return false;
      directories.add(info.location.directory);
      let cursor: string | undefined;
      do {
        const page = await this.client.session.list(
          { ...(cursor ? { cursor } : { parentID: info.id }), limit: 100 },
          request,
        );
        for (const child of page.data) family.set(child.id, child);
        cursor = page.cursor.next ?? undefined;
      } while (cursor);
    }
    for (const directory of directories) {
      const shells = await this.client.shell.list({ location: { directory } }, request);
      if (shells.data.some((shell) => shell.status === "running")) return false;
    }
    return !this.turns.id && !this.dirty;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    this.turns.close();
    this.streamAbort.abort();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.background.disconnect();
    await this.stream;
    await this.reconnecting?.catch(() => undefined);
    await this.sync.catch(() => undefined);
    await this.connection
      .unbindSession(this.id, this.config.cwd)
      .catch((error: unknown) =>
        this.logger.warn({ error }, "Could not unbind the OpenCode Pimi bridge"),
      );
    this.unbind?.();
    try {
      if (!this.persist) await this.client.session.remove({ sessionID: this.id });
    } finally {
      await this.connection.release();
    }
    this.listeners.clear();
  }
}

function retryMessage(event: Extract<OpenCodeEvent, { type: "session.retry.scheduled" }>): string {
  const { attempt, at, error } = event.data;
  const detail = error.message.trim();
  const status = error.status === undefined ? "" : ` (HTTP ${error.status})`;
  // Both timestamps are the OpenCode server's clock, so the delay is free of clock skew with Pimi.
  const delaySeconds = Math.max(0, Math.round((at - event.created) / 1000));
  const base = `Provider retry (attempt ${attempt}): ${detail || error.type}${status}`;
  const separator = /[.!?]$/.test(base) ? "" : ".";
  return `${base}${separator} Retrying in ${delaySeconds}s`;
}
