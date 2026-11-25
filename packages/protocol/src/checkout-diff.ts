/**
 * How long the daemon serves a completed checkout diff without reading it again. A client that
 * seeds its own copy of a diff from one read (Review's warm-up) keeps it for this long: a
 * subscription that opens later is answered from the same cache, so a seed older than this is
 * the one thing the daemon would no longer have called current.
 */
export const CHECKOUT_DIFF_CACHE_TTL_MS = 15_000;
