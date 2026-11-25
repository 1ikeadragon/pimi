// Pimi. PolyForm-Noncommercial-1.0.0.
// User-timing marks along the way from pressing Review to a painted, coloured diff, read from the
// browser's performance timeline (`performance.getEntriesByType("mark")`). They record only when
// render profiling is on (`?renderProfile=1`, as in `utils/render-profiler.tsx`); otherwise nothing
// is measured or allocated. Each mark is taken once per open.
import { isRenderProfileEnabled } from "@/utils/render-profiler";

export type ReviewMark =
  | "review:open"
  | "review:status"
  | "review:diff-first"
  | "review:first-paint"
  | "review:diff-colours";

const marked = new Set<ReviewMark>();

export function isReviewTimingEnabled(): boolean {
  return isRenderProfileEnabled() && typeof performance !== "undefined";
}

/** A new open: the marks of the one before are done. */
export function markReviewOpen(): void {
  if (!isReviewTimingEnabled()) return;
  marked.clear();
  markReview("review:open");
}

/** `detail` shows up on the entry; the first call per open wins and later ones are ignored. */
export function markReview(name: ReviewMark, detail?: Record<string, unknown>): void {
  if (!isReviewTimingEnabled() || marked.has(name)) return;
  marked.add(name);
  performance.mark(name, detail ? { detail } : undefined);
}
