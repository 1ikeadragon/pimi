// Pimi. PolyForm-Noncommercial-1.0.0.
// Contracts shared by the Review screen's pieces.

/** What a Review desk is reading. `serverId` is the daemon that answers every RPC for it. */
export type ReviewSource =
  | {
      kind: "change_request";
      serverId: string;
      forgeHost: string;
      owner: string;
      name: string;
      number: number;
    }
  | {
      kind: "checkout";
      serverId: string;
      cwd: string;
      compare: { mode: "uncommitted" | "base" | "all"; baseRef?: string };
      /** The chat that offered this review; notes go back to it. */
      origin?: { agentId: string };
    };

export type ChangeRequestSource = Extract<ReviewSource, { kind: "change_request" }>;
export type CheckoutSource = Extract<ReviewSource, { kind: "checkout" }>;

/** Per-file badges. Built once per timeline load (S4's hook) and read by the file tree and diff. */
export interface ReviewPathCounts {
  unresolved: number;
  annotations: number;
}
export type ReviewCountsByPath = ReadonlyMap<string, ReviewPathCounts>;

/** Jump the desk to a file and optionally a line; `line: null` jumps to the file header. */
export type ReviewJumpTo = (path: string, line: number | null) => void;

/** Ids chosen for a batch "Fix N selected". Owned by the shell, written by the Checks tab. */
export interface ReviewSelection {
  threads: ReadonlySet<string>;
  checks: ReadonlySet<string>;
  drafts: ReadonlySet<string>;
}

export const EMPTY_REVIEW_SELECTION: ReviewSelection = {
  threads: new Set(),
  checks: new Set(),
  drafts: new Set(),
};

/** The detail page's tabs. A worktree page has only `files`. */
export type ReviewDetailTab = "conversation" | "commits" | "checks" | "files";

/** The tab a source opens on: a pull request reads first, a worktree is its diff. */
export function defaultReviewTab(source: ReviewSource): ReviewDetailTab {
  return source.kind === "checkout" ? "files" : "conversation";
}

/** Home source: pull requests (the inbox) or local worktrees. */
export type ReviewMode = "pull_requests" | "worktrees";

/**
 * One entry of the screen's own back/forward history. The shell owns the stack; slots use the
 * `ReviewNavigation` it hands them and never touch history themselves.
 */
export interface ReviewViewState {
  mode: ReviewMode;
  source: ReviewSource | null;
  tab: ReviewDetailTab;
  /** File open on the Files tab. */
  path: string | null;
}

export interface ReviewNavigation {
  canGoBack: boolean;
  canGoForward: boolean;
  goBack: () => void;
  goForward: () => void;
  /** Push a new history entry built from the current one. */
  push: (next: Partial<ReviewViewState>) => void;
}

/** Files tab: file tree beside the diff. */
export interface ReviewDeskProps {
  source: ReviewSource;
  /** Set by the detail page when a thread or check asks the desk to move. `nonce` changes on every request so repeating a target still fires. */
  focus: ReviewDeskFocus | null;
}

/** `line` numbers the `side` of the diff it is on; `new` unless the request names the removed side. */
export interface ReviewDeskFocus {
  path: string;
  line: number | null;
  side?: "old" | "new";
  nonce: number;
}

export interface ReviewFixSheetProps {
  source: ChangeRequestSource;
  selection: ReviewSelection;
  visible: boolean;
  onClose: () => void;
}
