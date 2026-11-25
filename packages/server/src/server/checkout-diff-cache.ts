import { LRUCache } from "lru-cache";
import { CHECKOUT_DIFF_CACHE_TTL_MS } from "@pimi/protocol/checkout-diff";
import type {
  CheckoutDiffCompare,
  CheckoutDiffPlainListener,
  CheckoutDiffResult,
} from "../utils/checkout-git.js";

interface ActiveRead {
  promise: Promise<CheckoutDiffResult>;
  invalidated: boolean;
  controller: AbortController;
  settled: boolean;
  /** Callers still waiting for this build; callers that pass no signal never leave. */
  waiters: number;
  /** The untokenized files, once the build has produced them. */
  plain: Parameters<CheckoutDiffPlainListener>[0] | null;
  plainListeners: Set<CheckoutDiffPlainListener>;
}

interface CachedDiff {
  value: CheckoutDiffResult;
  loadedAt: number;
  lastReadStarted: number;
}

interface CheckoutDiffReadInput {
  cwd: string;
  compare: CheckoutDiffCompare;
  force?: boolean;
  reason?: string;
  /**
   * Called with the plain files if this read joins or starts a build that produces them before
   * it finishes. A cache hit never calls it: the finished result is already in hand.
   */
  onPlain?: CheckoutDiffPlainListener;
  /** Abandons the build when every caller waiting on it has aborted. */
  signal?: AbortSignal;
  load: (signal: AbortSignal, onPlain: CheckoutDiffPlainListener) => Promise<CheckoutDiffResult>;
}

/** Completed payloads are bounded; active work survives invalidation and eviction. */
export class CheckoutDiffCache {
  private readonly values = new LRUCache<string, CachedDiff>({
    max: 64,
  });
  private readonly active = new Map<string, ActiveRead>();

  constructor(private readonly now: () => number) {}

  read(input: CheckoutDiffReadInput): Promise<CheckoutDiffResult> {
    const { cwd, compare, force, reason, load } = input;
    if (force && !reason) throw new Error("WorkspaceGitService forced read requires a reason");
    const key = JSON.stringify([
      cwd,
      compare.mode,
      compare.mode !== "uncommitted" ? (compare.baseRef ?? null) : null,
      compare.ignoreWhitespace === true,
      compare.includeStructured === true,
    ]);
    const cached = this.values.get(key);
    const now = this.now();
    if (
      !force &&
      cached &&
      (now - cached.loadedAt <= CHECKOUT_DIFF_CACHE_TTL_MS || now - cached.lastReadStarted < 2_000)
    )
      return Promise.resolve(cached.value);
    const pending = this.active.get(key);
    if (pending) {
      if (force) {
        pending.invalidated = true;
        pending.controller.abort();
        this.values.delete(key);
      }
      if (!pending.invalidated) {
        this.attach(pending, input);
        return pending.promise;
      }
      // A caller arriving after a change needs a fresh read, once the old one
      // finishes. The original caller can still receive its snapshot promptly.
      // The older result cannot enter the cache. Drop force when retrying so
      // callers waiting on that same result share the next fresh build.
      const reload = () => this.read({ ...input, force: false });
      return pending.promise.then(reload, reload);
    }
    if (cached) cached.lastReadStarted = now;

    // Defer load until ownership is installed, including synchronous invalidations.
    const publishPlain: CheckoutDiffPlainListener = (files) => {
      // A superseded build's files are as stale as its result.
      if (read.invalidated) return;
      read.plain = files;
      for (const listener of read.plainListeners) listener(files);
      read.plainListeners.clear();
    };
    const read: ActiveRead = {
      invalidated: false,
      controller: new AbortController(),
      settled: false,
      waiters: 0,
      plain: null,
      plainListeners: new Set(),
      promise: Promise.resolve()
        .then(() => load(read.controller.signal, publishPlain))
        .then((value) => {
          // Never repopulate the cache with a snapshot invalidated during its build.
          if (!read.invalidated)
            this.values.set(key, { value, loadedAt: this.now(), lastReadStarted: now });
          return value;
        })
        .finally(() => {
          read.settled = true;
          this.active.delete(key);
        }),
    };
    this.active.set(key, read);
    this.attach(read, input);
    return read.promise;
  }

  private attach(read: ActiveRead, input: CheckoutDiffReadInput): void {
    const { onPlain, signal } = input;
    read.waiters += 1;
    if (onPlain) {
      if (read.plain) onPlain(read.plain);
      else read.plainListeners.add(onPlain);
    }
    if (!signal) return;
    const leave = () => {
      if (onPlain) read.plainListeners.delete(onPlain);
      read.waiters -= 1;
      if (read.waiters > 0 || read.settled) return;
      read.invalidated = true;
      read.controller.abort();
    };
    if (signal.aborted) {
      leave();
      return;
    }
    signal.addEventListener("abort", leave, { once: true });
    const detach = () => signal.removeEventListener("abort", leave);
    void read.promise.then(detach, detach);
  }

  invalidate(cwd: string, mode: CheckoutDiffCompare["mode"]): void {
    for (const key of new Set([...this.values.keys(), ...this.active.keys()])) {
      const [cachedCwd, cachedMode] = JSON.parse(key) as string[];
      if (cachedCwd !== cwd || (cachedMode !== mode && cachedMode !== "all")) continue;
      this.values.delete(key);
      const pending = this.active.get(key);
      if (pending) {
        pending.invalidated = true;
        pending.controller.abort();
      }
    }
  }
}
