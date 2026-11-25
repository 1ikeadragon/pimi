// Pimi. PolyForm-Noncommercial-1.0.0.
// Review's diff is a subscription: the first snapshot arrives a round trip after the screen mounts.
// Pointing at the Review button starts that read early and seeds the query the screen will use, so
// the diff is already there when it opens. The seed is a plain read of what the subscription
// would deliver first, under the same key; the subscription replaces it with its own snapshot.
import { CHECKOUT_DIFF_CACHE_TTL_MS } from "@pimi/protocol/checkout-diff";
import { queryClient } from "@/data/query-client";
import { orderCheckoutDiffFiles } from "@/git/diff-order";
import { ensureCheckoutStatus } from "@/git/checkout-status-cache";
import { scopedCheckoutDiffQueryKey, type CheckoutDiffQueryPayload } from "@/git/use-diff-query";
import {
  CHANGES_PREFERENCES_QUERY_KEY,
  type ChangesPreferences,
} from "@/hooks/use-changes-preferences/storage";
import { loadChangesPreferencesFromStorage } from "@/hooks/use-changes-preferences";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import type { CheckoutSource } from "./types";

/** Review's diff subscription is kept apart from the chat Changes pane's by this scope. */
export const REVIEW_DIFF_SCOPE = "pimi-review";

/**
 * An unobserved seed is dropped after this long. It is the daemon's own diff cache lifetime: past
 * it the daemon would read the checkout again, so the seed no longer matches what a subscription
 * opened now would receive first.
 */
export const WARM_SEED_TTL_MS = CHECKOUT_DIFF_CACHE_TTL_MS;

/** The key Review's diff of `source` is stored under, given the base ref and whitespace setting in use. */
export function reviewCheckoutDiffQueryKey(
  source: CheckoutSource,
  options: { baseRef: string | undefined; ignoreWhitespace: boolean },
) {
  return scopedCheckoutDiffQueryKey({
    serverId: source.serverId,
    cwd: source.cwd,
    mode: source.compare.mode,
    baseRef: options.baseRef,
    ignoreWhitespace: options.ignoreWhitespace,
    queryScope: REVIEW_DIFF_SCOPE,
  });
}

const inFlight = new Map<string, Promise<void>>();

function flightKey(source: CheckoutSource): string {
  return JSON.stringify([source.serverId, source.cwd, source.compare]);
}

/**
 * Reads the checkout's status and diff ahead of opening Review. Safe to call on every hover and
 * press: one read runs per comparison at a time, and a diff already in the cache is left alone.
 * A failed read is logged and the screen loads the diff the ordinary way.
 */
export function warmCheckoutReview(source: CheckoutSource): Promise<void> {
  const key = flightKey(source);
  const running = inFlight.get(key);
  if (running) return running;
  const run = seedDiff(source)
    .catch((error: unknown) => {
      console.warn("[review] warming the diff failed", { cwd: source.cwd, error });
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

/** Starts the status read an entry point without a base ref needs; Review reads the same cache. */
export function prefetchCheckoutStatus(source: CheckoutSource): void {
  const client = getHostRuntimeStore().getClient(source.serverId);
  if (!client?.isConnected) return;
  ensureCheckoutStatus({
    queryClient,
    client,
    serverId: source.serverId,
    cwd: source.cwd,
  }).catch((error: unknown) => {
    console.warn("[review] reading the checkout status failed", { cwd: source.cwd, error });
  });
}

async function seedDiff(source: CheckoutSource): Promise<void> {
  const client = getHostRuntimeStore().getClient(source.serverId);
  if (!client?.isConnected) return;
  const status = await ensureCheckoutStatus({
    queryClient,
    client,
    serverId: source.serverId,
    cwd: source.cwd,
  });
  if (!status.isGit) return;
  const preferences =
    queryClient.getQueryData<ChangesPreferences>(CHANGES_PREFERENCES_QUERY_KEY) ??
    (await loadChangesPreferencesFromStorage());
  // The same base ref the screen settles on: the status's, else the one the route named.
  const baseRef = status.baseRef ?? source.compare.baseRef ?? undefined;
  const ignoreWhitespace = preferences.hideWhitespace;
  const queryKey = reviewCheckoutDiffQueryKey(source, { baseRef, ignoreWhitespace });
  if (queryClient.getQueryData(queryKey)) return;
  const payload = await client.getCheckoutDiff(source.cwd, {
    mode: source.compare.mode,
    ...(baseRef ? { baseRef } : {}),
    ignoreWhitespace,
  });
  // An error payload is the daemon's answer, not a diff; the subscription will ask again.
  if (payload.error) return;
  // A subscription that opened while this read ran has already put its snapshot there.
  if (queryClient.getQueryData(queryKey)) return;
  const seed: CheckoutDiffQueryPayload = {
    ...payload,
    files: orderCheckoutDiffFiles(payload.files),
  };
  queryClient.setQueryData(queryKey, seed);
  setTimeout(() => {
    const query = queryClient.getQueryCache().find({ queryKey, exact: true });
    if (query && query.getObserversCount() === 0) {
      queryClient.removeQueries({ queryKey, exact: true });
    }
  }, WARM_SEED_TTL_MS);
}
