// Pimi. Apache-2.0.
import { router, type Href } from "expo-router";
import { buildOpenProjectRoute } from "@/utils/host-routes";
import type { ReviewSource } from "@/review-screen/types";

export const PIMI_REVIEW_ROUTE = "/pimi-review";

const FORGE_HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const REPO_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
const COMPARE_MODES = new Set(["uncommitted", "base", "all"]);

type ReviewRouteParams = Record<string, string | string[] | undefined>;

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Route params for a source; the inverse of {@link parseReviewSource}. */
export function reviewSourceToParams(source: ReviewSource): Record<string, string> {
  if (source.kind === "change_request") {
    return {
      serverId: source.serverId,
      forgeHost: source.forgeHost,
      owner: source.owner,
      name: source.name,
      number: String(source.number),
      ...(source.cwd ? { cwd: source.cwd } : {}),
    };
  }
  return {
    serverId: source.serverId,
    cwd: source.cwd,
    mode: source.compare.mode,
    ...(source.compare.baseRef ? { baseRef: source.compare.baseRef } : {}),
  };
}

/**
 * Route params to a source, or null for the inbox. Params come from a URL, so identity is
 * validated with the same patterns the daemon enforces; anything else opens the inbox.
 */
export function parseReviewSource(params: ReviewRouteParams): ReviewSource | null {
  const serverId = single(params.serverId);
  if (!serverId) return null;
  const forgeHost = single(params.forgeHost);
  const owner = single(params.owner);
  const name = single(params.name);
  const numberText = single(params.number);
  if (forgeHost || owner || name || numberText) {
    const number = numberText && /^[1-9]\d{0,15}$/.test(numberText) ? Number(numberText) : NaN;
    if (
      !forgeHost ||
      !FORGE_HOST.test(forgeHost) ||
      !owner ||
      !REPO_SEGMENT.test(owner) ||
      !name ||
      !REPO_SEGMENT.test(name) ||
      !Number.isSafeInteger(number)
    ) {
      return null;
    }
    return {
      kind: "change_request",
      serverId,
      forgeHost: forgeHost.toLowerCase(),
      owner,
      name,
      number,
      cwd: single(params.cwd),
    };
  }
  const cwd = single(params.cwd);
  const mode = single(params.mode);
  if (!cwd || !mode || !COMPARE_MODES.has(mode)) return null;
  return {
    kind: "checkout",
    serverId,
    cwd,
    compare: { mode: mode as "uncommitted" | "base" | "all", baseRef: single(params.baseRef) },
  };
}

/** Open the inbox (no source) or a review. Pushing a source on top of the inbox lets Back return to it. */
export function openPimiReview(source?: ReviewSource, serverId?: string): void {
  let params: Record<string, string> = {};
  if (source) params = reviewSourceToParams(source);
  else if (serverId) params = { serverId };
  router.navigate({ pathname: PIMI_REVIEW_ROUTE, params } as unknown as Href);
}

export function closePimiReview(): void {
  if (router.canGoBack()) router.back();
  else router.replace(buildOpenProjectRoute());
}
