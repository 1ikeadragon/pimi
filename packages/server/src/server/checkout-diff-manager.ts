import { type WorkspaceRuntimeStore } from "./workspace-runtime-store/index.js";
import type pino from "pino";
import type { SubscribeCheckoutDiffRequest, SessionOutboundMessage } from "./messages.js";
import type {
  WorkspaceGitReadOptions,
  WorkspaceGitRuntimeSnapshot,
  WorkspaceGitService,
} from "./workspace-git-service.js";
import { expandTilde } from "../utils/path.js";
import { toCheckoutError } from "./checkout-git-utils.js";
import type { CheckoutDiffTimings } from "../utils/checkout-git.js";
import type { ParsedDiffFile } from "./utils/diff-highlighter.js";

const CHECKOUT_DIFF_WATCH_DEBOUNCE_MS = 150;

function sortDiffFiles<T extends { path: string }>(files: readonly T[]): T[] {
  return [...files].sort((a, b) => {
    if (a.path === b.path) return 0;
    return a.path < b.path ? -1 : 1;
  });
}

type CheckoutDiffWorkspace = Pick<
  WorkspaceGitService,
  "getCheckoutDiff" | "getSnapshot" | "registerWorkspace" | "requestWorkingTreeWatch"
>;

export type CheckoutDiffCompareInput = SubscribeCheckoutDiffRequest["compare"];

export type CheckoutDiffSnapshotPayload = Omit<
  Extract<SessionOutboundMessage, { type: "checkout_diff_update" }>["payload"],
  "subscriptionId"
>;

export interface CheckoutDiffMetrics {
  checkoutDiffTargetCount: number;
  checkoutDiffSubscriptionCount: number;
  checkoutDiffWatcherCount: number;
  checkoutDiffFallbackRefreshTargetCount: number;
}

interface CheckoutDiffWatchTarget {
  key: string;
  cwd: string;
  diffCwd: string;
  compare: CheckoutDiffCompareInput;
  listeners: Set<CheckoutDiffListener>;
  workingTreeWatchUnsubscribe: (() => void) | null;
  workspaceGitUnsubscribe: (() => void) | null;
  latestWorkspaceStructureFingerprint: string | null;
  latestWorkspaceWorktreeFingerprint: string | null;
  latestWorkspaceForgeFingerprint: string | null;
  debounceTimer: NodeJS.Timeout | null;
  pendingDebounceForce: boolean;
  refreshPromise: Promise<void> | null;
  refreshQueued: boolean;
  refreshQueuedForce: boolean;
  latestPayload: CheckoutDiffSnapshotPayload | null;
  latestFingerprint: string | null;
  openPromise: Promise<void> | null;
  /** Counts the refreshes started, so a colour pass can tell it has been superseded. */
  generation: number;
  /** The first snapshot of a cold target, shared by subscribers that arrive while it is read. */
  initialBuild: Promise<void> | null;
  /** Aborted when the target closes, so syntax highlighting nobody will see stops. */
  coloursAbort: AbortController | null;
}

/** The fingerprint is the serialized snapshot, computed once here for every consumer to compare. */
export type CheckoutDiffListener = (
  snapshot: CheckoutDiffSnapshotPayload,
  fingerprint: string,
) => void;

export interface CheckoutDiffSubscriptionRequest {
  cwd: string;
  compare: CheckoutDiffCompareInput;
  signal?: AbortSignal;
}

export interface CheckoutDiffSubscription {
  initial: CheckoutDiffSnapshotPayload;
  initialFingerprint: string;
  unsubscribe: () => void;
}

export class CheckoutDiffManager {
  private readonly workspaceGitService: CheckoutDiffWorkspace;
  private readonly workspaceRuntimeStore: WorkspaceRuntimeStore;
  private readonly targets = new Map<string, CheckoutDiffWatchTarget>();
  private readonly logger: pino.Logger;

  constructor(options: {
    logger: pino.Logger;
    pimiHome: string;
    workspaceGitService: CheckoutDiffWorkspace;
    workspaceRuntimeStore: WorkspaceRuntimeStore;
  }) {
    this.logger = options.logger.child({ module: "checkout-diff" });
    this.workspaceGitService = options.workspaceGitService;
    this.workspaceRuntimeStore = options.workspaceRuntimeStore;
  }

  async read(
    params: Omit<CheckoutDiffSubscriptionRequest, "signal">,
  ): Promise<CheckoutDiffSnapshotPayload> {
    return this.computeCheckoutDiffSnapshot(params.cwd, this.normalizeCompare(params.compare));
  }

  async subscribe(
    params: CheckoutDiffSubscriptionRequest,
    listener: CheckoutDiffListener,
  ): Promise<CheckoutDiffSubscription> {
    const cwd = params.cwd;
    const compare = this.normalizeCompare(params.compare);
    const target = this.ensureTarget(cwd, compare);
    target.listeners.add(listener);
    target.openPromise ??= this.openTarget(target);

    let isSubscribed = true;
    const unsubscribe = () => {
      if (!isSubscribed) {
        return;
      }
      isSubscribed = false;
      params.signal?.removeEventListener("abort", unsubscribe);
      this.removeListener(target, listener);
    };
    params.signal?.addEventListener("abort", unsubscribe, { once: true });
    if (params.signal?.aborted) {
      unsubscribe();
    }

    try {
      await target.openPromise;
      if (!target.latestPayload || target.latestFingerprint === null) {
        target.initialBuild ??= this.buildInitialSnapshot(target).finally(() => {
          target.initialBuild = null;
        });
        await target.initialBuild;
      }
      if (!target.latestPayload || target.latestFingerprint === null) {
        throw new Error("Checkout diff target has no snapshot after its initial build");
      }
      return {
        initial: target.latestPayload,
        initialFingerprint: target.latestFingerprint,
        unsubscribe,
      };
    } catch (error) {
      unsubscribe();
      throw error;
    }
  }

  scheduleRefreshForCwd(cwd: string): void {
    const resolvedCwd = expandTilde(cwd);
    for (const target of this.targets.values()) {
      if (target.cwd !== resolvedCwd && target.diffCwd !== resolvedCwd) {
        continue;
      }
      this.scheduleTargetRefresh(target);
    }
  }

  getMetrics(): CheckoutDiffMetrics {
    let checkoutDiffSubscriptionCount = 0;

    for (const target of this.targets.values()) {
      checkoutDiffSubscriptionCount += target.listeners.size;
    }

    return {
      checkoutDiffTargetCount: this.targets.size,
      checkoutDiffSubscriptionCount,
      checkoutDiffWatcherCount: 0,
      checkoutDiffFallbackRefreshTargetCount: 0,
    };
  }

  dispose(): void {
    for (const target of this.targets.values()) {
      this.closeTarget(target);
    }
    this.targets.clear();
  }

  private normalizeCompare(compare: CheckoutDiffCompareInput): CheckoutDiffCompareInput {
    const ignoreWhitespace = compare.ignoreWhitespace === true;
    if (compare.mode === "uncommitted") {
      return { mode: "uncommitted", ignoreWhitespace };
    }
    const trimmedBaseRef = compare.baseRef?.trim();
    return trimmedBaseRef
      ? { mode: compare.mode, baseRef: trimmedBaseRef, ignoreWhitespace }
      : { mode: compare.mode, ignoreWhitespace };
  }

  private buildTargetKey(cwd: string, compare: CheckoutDiffCompareInput): string {
    return JSON.stringify([
      cwd,
      compare.mode,
      compare.mode !== "uncommitted" ? (compare.baseRef ?? "") : "",
      compare.ignoreWhitespace === true,
    ]);
  }

  private closeTarget(target: CheckoutDiffWatchTarget): void {
    if (target.debounceTimer) {
      clearTimeout(target.debounceTimer);
      target.debounceTimer = null;
    }
    target.workingTreeWatchUnsubscribe?.();
    target.workingTreeWatchUnsubscribe = null;
    target.workspaceGitUnsubscribe?.();
    target.workspaceGitUnsubscribe = null;
    target.coloursAbort?.abort();
    target.coloursAbort = null;
    target.listeners.clear();
  }

  private rememberWorkspaceSnapshot(
    target: CheckoutDiffWatchTarget,
    snapshot: WorkspaceGitRuntimeSnapshot,
  ): void {
    const structureFingerprint = JSON.stringify({
      isGit: snapshot.git.isGit,
      repoRoot: snapshot.git.repoRoot,
      mainRepoRoot: snapshot.git.mainRepoRoot,
      currentBranch: snapshot.git.currentBranch,
      remoteUrl: snapshot.git.remoteUrl,
      isPimiOwnedWorktree: snapshot.git.isPimiOwnedWorktree,
      baseRef: snapshot.git.baseRef,
      baseRefExact: snapshot.git.baseRefExact,
      aheadBehind: snapshot.git.aheadBehind,
      aheadOfOrigin: snapshot.git.aheadOfOrigin,
      behindOfOrigin: snapshot.git.behindOfOrigin,
      hasRemote: snapshot.git.hasRemote,
    });
    const worktreeFingerprint = JSON.stringify({
      isDirty: snapshot.git.isDirty,
      diffStat: snapshot.git.diffStat,
    });
    const forgeFingerprint = JSON.stringify(snapshot.forge);
    const previousStructureFingerprint = target.latestWorkspaceStructureFingerprint;
    const previousWorktreeFingerprint = target.latestWorkspaceWorktreeFingerprint;
    const previousForgeFingerprint = target.latestWorkspaceForgeFingerprint;
    target.latestWorkspaceStructureFingerprint = structureFingerprint;
    target.latestWorkspaceWorktreeFingerprint = worktreeFingerprint;
    target.latestWorkspaceForgeFingerprint = forgeFingerprint;

    if (previousStructureFingerprint === null) {
      return;
    }
    const structureChanged = structureFingerprint !== previousStructureFingerprint;
    const worktreeChanged = worktreeFingerprint !== previousWorktreeFingerprint;
    const forgeChanged = forgeFingerprint !== previousForgeFingerprint;
    if (structureChanged || (!worktreeChanged && !forgeChanged)) {
      this.scheduleTargetRefresh(target, false);
    }
  }

  private removeListener(target: CheckoutDiffWatchTarget, listener: CheckoutDiffListener): void {
    target.listeners.delete(listener);
    if (target.listeners.size > 0) {
      return;
    }
    this.closeTarget(target);
    if (this.targets.get(target.key) === target) {
      this.targets.delete(target.key);
    }
  }

  private scheduleTargetRefresh(target: CheckoutDiffWatchTarget, force = true): void {
    target.pendingDebounceForce ||= force;
    if (target.debounceTimer) {
      clearTimeout(target.debounceTimer);
    }
    target.debounceTimer = setTimeout(() => {
      target.debounceTimer = null;
      const pendingForce = target.pendingDebounceForce;
      target.pendingDebounceForce = false;
      void this.refreshTarget(target, pendingForce);
    }, CHECKOUT_DIFF_WATCH_DEBOUNCE_MS);
  }

  private async computeCheckoutDiffSnapshot(
    cwd: string,
    compare: CheckoutDiffCompareInput,
    options?: {
      diffCwd?: string;
      force?: boolean;
      reason?: string;
      /** Receives the snapshot without syntax tokens, if the read produces one before it ends. */
      onPlain?: (payload: CheckoutDiffSnapshotPayload) => void;
      signal?: AbortSignal;
    },
  ): Promise<CheckoutDiffSnapshotPayload> {
    const diffCwd = options?.diffCwd ?? cwd;
    const startedAt = performance.now();
    const onPlain = options?.onPlain;
    const freshness: WorkspaceGitReadOptions = options?.force
      ? { force: true, reason: options.reason ?? "checkout-diff-refresh" }
      : {};
    try {
      const diffResult = await this.workspaceGitService.getCheckoutDiff(
        diffCwd,
        {
          mode: compare.mode,
          baseRef: compare.baseRef,
          ignoreWhitespace: compare.ignoreWhitespace,
          includeStructured: true,
        },
        {
          ...freshness,
          ...(onPlain
            ? {
                onPlain: (plainFiles: ParsedDiffFile[]) => {
                  const payload = { cwd, files: sortDiffFiles(plainFiles), error: null };
                  this.logSnapshot({
                    cwd,
                    compare,
                    startedAt,
                    payload,
                    timings: undefined,
                    phase: "plain",
                  });
                  onPlain(payload);
                },
              }
            : {}),
          ...(options?.signal ? { signal: options.signal } : {}),
        },
      );
      if (diffResult.diffTooLarge) {
        return {
          cwd,
          files: [],
          diffTooLarge: true,
          error: toCheckoutError(new Error("Diff too large to display")),
        };
      }
      const payload = { cwd, files: sortDiffFiles(diffResult.structured ?? []), error: null };
      this.logSnapshot({
        cwd,
        compare,
        startedAt,
        payload,
        timings: diffResult.timings,
        phase: "complete",
      });
      return payload;
    } catch (error) {
      return {
        cwd,
        files: [],
        error: toCheckoutError(error),
      };
    }
  }

  /**
   * Where a snapshot's time went. `totalMs` is this call's wall time, near zero when the daemon's
   * diff cache answered, in which case the stage times are those of the read that filled it.
   * Sizing the snapshot serializes it once more, so it happens only when debug logging is on.
   */
  private logSnapshot(input: {
    cwd: string;
    compare: CheckoutDiffCompareInput;
    startedAt: number;
    payload: CheckoutDiffSnapshotPayload;
    timings: CheckoutDiffTimings | undefined;
    phase: "plain" | "complete";
  }): void {
    if (!this.logger.isLevelEnabled("debug")) return;
    this.logger.debug(
      {
        cwd: input.cwd,
        mode: input.compare.mode,
        phase: input.phase,
        files: input.payload.files.length,
        bytes: Buffer.byteLength(JSON.stringify(input.payload)),
        totalMs: Math.round(performance.now() - input.startedAt),
        ...(input.timings
          ? {
              listMs: Math.round(input.timings.listMs),
              patchMs: Math.round(input.timings.patchMs),
              blobMs: Math.round(input.timings.blobMs),
              highlightMs: Math.round(input.timings.highlightMs),
            }
          : {}),
      },
      input.phase === "plain" ? "checkout diff plain snapshot" : "checkout diff snapshot",
    );
  }

  private async refreshTarget(target: CheckoutDiffWatchTarget, force: boolean): Promise<void> {
    if (target.refreshPromise) {
      target.refreshQueued = true;
      target.refreshQueuedForce ||= force;
      return;
    }

    target.refreshPromise = (async () => {
      let currentForce = force;
      do {
        target.refreshQueued = false;
        target.refreshQueuedForce = false;
        target.generation += 1;
        const snapshot = await this.computeCheckoutDiffSnapshot(target.cwd, target.compare, {
          diffCwd: target.diffCwd,
          force: currentForce,
          ...(currentForce ? { reason: "working-tree-watch" } : {}),
        });
        target.latestPayload = snapshot;
        const fingerprint = JSON.stringify(snapshot);
        if (fingerprint !== target.latestFingerprint) {
          target.latestFingerprint = fingerprint;
          for (const listener of target.listeners) {
            listener(snapshot, fingerprint);
          }
        }
        currentForce = target.refreshQueuedForce;
      } while (target.refreshQueued);
    })();

    try {
      await target.refreshPromise;
    } finally {
      target.refreshPromise = null;
    }
  }

  /**
   * Reads a cold target's first snapshot. Syntax highlighting is most of a large diff's read time,
   * so the first snapshot goes out as soon as the patches are parsed, without tokens, and the
   * highlighted one follows as an ordinary update. When the read produces no plain snapshot (the
   * daemon's cache already holds it) the highlighted one is the first and only snapshot.
   */
  private async buildInitialSnapshot(target: CheckoutDiffWatchTarget): Promise<void> {
    const generation = target.generation;
    const colours = new AbortController();
    target.coloursAbort = colours;
    let publishPlain!: (payload: CheckoutDiffSnapshotPayload) => void;
    const plain = new Promise<CheckoutDiffSnapshotPayload>((resolve) => {
      publishPlain = resolve;
    });
    const complete = this.computeCheckoutDiffSnapshot(target.cwd, target.compare, {
      diffCwd: target.diffCwd,
      onPlain: publishPlain,
      signal: colours.signal,
    });
    const first = await Promise.race([
      plain.then((payload) => ({ payload, isPlain: true })),
      complete.then((payload) => ({ payload, isPlain: false })),
    ]);
    if (target.latestPayload === null) {
      target.latestPayload = first.payload;
      target.latestFingerprint = JSON.stringify(first.payload);
    }
    if (!first.isPlain) return;
    void this.publishColours(target, generation, complete);
  }

  /** Sends the highlighted snapshot unless a refresh or the target's close has overtaken it. */
  private async publishColours(
    target: CheckoutDiffWatchTarget,
    generation: number,
    complete: Promise<CheckoutDiffSnapshotPayload>,
  ): Promise<void> {
    try {
      const snapshot = await complete;
      if (target.generation !== generation || target.listeners.size === 0) return;
      const fingerprint = JSON.stringify(snapshot);
      // A diff with nothing to colour completes as the plain snapshot it already sent.
      if (fingerprint === target.latestFingerprint) return;
      target.latestPayload = snapshot;
      target.latestFingerprint = fingerprint;
      for (const listener of target.listeners) {
        listener(snapshot, fingerprint);
      }
    } catch (error) {
      this.logger.error(
        { err: error, cwd: target.cwd, mode: target.compare.mode },
        "checkout diff colour update failed",
      );
    }
  }

  private ensureTarget(cwd: string, compare: CheckoutDiffCompareInput): CheckoutDiffWatchTarget {
    const targetKey = this.buildTargetKey(cwd, compare);
    const existing = this.targets.get(targetKey);
    if (existing) {
      return existing;
    }

    const target: CheckoutDiffWatchTarget = {
      key: targetKey,
      cwd,
      diffCwd: cwd,
      compare,
      listeners: new Set(),
      workingTreeWatchUnsubscribe: null,
      workspaceGitUnsubscribe: null,
      latestWorkspaceStructureFingerprint: null,
      latestWorkspaceWorktreeFingerprint: null,
      latestWorkspaceForgeFingerprint: null,
      debounceTimer: null,
      pendingDebounceForce: false,
      refreshPromise: null,
      refreshQueued: false,
      refreshQueuedForce: false,
      latestPayload: null,
      latestFingerprint: null,
      openPromise: null,
      generation: 0,
      initialBuild: null,
      coloursAbort: null,
    };
    this.targets.set(targetKey, target);
    return target;
  }

  private async openTarget(target: CheckoutDiffWatchTarget): Promise<void> {
    if (target.compare.mode !== "uncommitted") {
      const snapshot =
        this.workspaceRuntimeStore.get(target.cwd) ??
        (await this.workspaceGitService.getSnapshot(target.cwd, { includeForge: false }));
      target.diffCwd = snapshot.git.repoRoot ?? target.cwd;
      if (this.targets.get(target.key) !== target || target.listeners.size === 0) {
        return;
      }
      this.rememberWorkspaceSnapshot(target, snapshot);
      const workspaceSubscription = this.workspaceGitService.registerWorkspace(
        { cwd: target.cwd },
        (nextSnapshot) => this.rememberWorkspaceSnapshot(target, nextSnapshot),
      );
      if (this.targets.get(target.key) !== target || target.listeners.size === 0) {
        workspaceSubscription.unsubscribe();
        return;
      }
      target.workspaceGitUnsubscribe = workspaceSubscription.unsubscribe;
      if (target.compare.mode === "base") return;
    }

    const { repoRoot, unsubscribe } = await this.workspaceGitService.requestWorkingTreeWatch(
      target.cwd,
      () => this.scheduleTargetRefresh(target),
    );
    target.diffCwd = repoRoot ?? target.cwd;
    if (this.targets.get(target.key) !== target || target.listeners.size === 0) {
      unsubscribe();
      return;
    }
    target.workingTreeWatchUnsubscribe = unsubscribe;
  }
}
