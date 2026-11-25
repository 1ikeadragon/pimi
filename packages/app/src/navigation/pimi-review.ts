// Pimi. PolyForm-Noncommercial-1.0.0.
import { router, type Href } from "expo-router";
import { getDesktopHost } from "@/desktop/host";
import { buildOpenProjectRoute } from "@/utils/host-routes";
import type { ReviewDeskFocus, ReviewSource } from "@/review-screen/types";

export const PIMI_REVIEW_ROUTE = "/pimi-review";

const FORGE_HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const REPO_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
// Agent ids are UUIDs; the pattern bounds what a URL can put in the route, nothing more.
const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
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
    };
  }
  return {
    serverId: source.serverId,
    cwd: source.cwd,
    mode: source.compare.mode,
    ...(source.compare.baseRef ? { baseRef: source.compare.baseRef } : {}),
    ...(source.origin ? { originAgentId: source.origin.agentId } : {}),
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
    };
  }
  const cwd = single(params.cwd);
  const mode = single(params.mode);
  const originAgentId = single(params.originAgentId);
  if (!cwd || !mode || !COMPARE_MODES.has(mode)) return null;
  return {
    kind: "checkout",
    serverId,
    cwd,
    compare: { mode: mode as "uncommitted" | "base" | "all", baseRef: single(params.baseRef) },
    // Only a shape check: whether the chat exists is read from the session store when it is used.
    ...(originAgentId && AGENT_ID.test(originAgentId)
      ? { origin: { agentId: originAgentId } }
      : {}),
  };
}

// Each request carries a sequence number, so asking for the same line twice still scrolls twice.
let focusSequence = 0;

/** Route params for a request to scroll a review to a file and line. */
function focusToParams(focus: Omit<ReviewDeskFocus, "nonce">): Record<string, string> {
  focusSequence += 1;
  return {
    focusPath: focus.path,
    focusSeq: String(focusSequence),
    ...(focus.line !== null ? { focusLine: String(focus.line) } : {}),
    ...(focus.side ? { focusSide: focus.side } : {}),
  };
}

/** The focus request a route carries, or null. The inverse of {@link focusToParams}. */
export function parseReviewFocus(params: ReviewRouteParams): ReviewDeskFocus | null {
  const path = single(params.focusPath);
  const seq = single(params.focusSeq);
  if (!path || !seq || !/^[1-9]\d{0,15}$/.test(seq)) return null;
  const lineText = single(params.focusLine);
  const line = lineText && /^[1-9]\d{0,9}$/.test(lineText) ? Number(lineText) : null;
  const side = single(params.focusSide);
  return {
    path,
    line,
    ...(side === "old" || side === "new" ? { side } : {}),
    nonce: Number(seq),
  };
}

/**
 * Open the inbox (no source) or a review. Pushing a source on top of the inbox lets Back return to
 * it. `focus` scrolls a checkout review to a file and line once its diff is in.
 */
export function openPimiReview(
  source?: ReviewSource,
  serverId?: string,
  focus?: Omit<ReviewDeskFocus, "nonce">,
): void {
  getDesktopHost()?.dismissPimiWorkspace?.();
  let params: Record<string, string> = {};
  if (source) params = reviewSourceToParams(source);
  else if (serverId) params = { serverId };
  if (source && focus) params = { ...params, ...focusToParams(focus) };
  router.navigate({ pathname: PIMI_REVIEW_ROUTE, params } as unknown as Href);
}

// Any page of a pull request (`/pull/12`, `/pull/12/files`, `/pull/12/commits/<sha>`) opens it in Review.
const GITHUB_PULL_REQUEST_PATH =
  /^\/([A-Za-z0-9_][\w.-]{0,99})\/([A-Za-z0-9_][\w.-]{0,99})\/pull\/([1-9]\d{0,15})(?:\/.*)?$/;
const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

/** A GitHub pull request URL as a review source on `serverId`, or null for any other URL. */
export function pullRequestUrlToSource(url: string, serverId: string): ReviewSource | null {
  const parsed = URL.parse(url);
  if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) return null;
  if (!GITHUB_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  const match = GITHUB_PULL_REQUEST_PATH.exec(parsed.pathname);
  if (!match) return null;
  return {
    kind: "change_request",
    serverId,
    forgeHost: "github.com",
    owner: match[1],
    name: match[2],
    number: Number(match[3]),
  };
}

/** A checkout's committed and working changes, the comparison the Work board and chat entry points open. */
export function checkoutReviewSource(input: {
  serverId: string;
  cwd: string;
  baseRef?: string;
  /** The chat that offered the review. */
  originAgentId?: string;
}): ReviewSource {
  return {
    kind: "checkout",
    serverId: input.serverId,
    cwd: input.cwd,
    compare: { mode: "all", ...(input.baseRef ? { baseRef: input.baseRef } : {}) },
    ...(input.originAgentId ? { origin: { agentId: input.originAgentId } } : {}),
  };
}

export function closePimiReview(): void {
  if (router.canGoBack()) router.back();
  else router.replace(buildOpenProjectRoute());
}
