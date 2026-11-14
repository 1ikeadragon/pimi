// Pimi. PolyForm-Noncommercial-1.0.0.
// Contracts shared by the Review screen's slots. Every stream imports from here and none redefines
// these shapes; change one only in the stream that owns `review-screen/types.ts`.
import type { ChangeRequestFile } from "@pimi/protocol/messages";

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
    };

export type ChangeRequestSource = Extract<ReviewSource, { kind: "change_request" }>;

/** Per-file badges. Built once per timeline load (S4's hook) and read by the file tree and diff. */
export interface ReviewPathCounts {
  unresolved: number;
  annotations: number;
}
export type ReviewCountsByPath = ReadonlyMap<string, ReviewPathCounts>;

/** Jump the desk to a file and optionally a line; `line: null` jumps to the file header. */
export type ReviewJumpTo = (path: string, line: number | null) => void;

/** Ids chosen for a batch "Fix N selected". Owned by the shell, written by the inspector and diff. */
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

export type ReviewInspectorTab = "threads" | "checks";

/** The detail pane's two tabs, as in the website's Review mockup: cards first, diff second. */
export type ReviewDetailTab = "overview" | "changes";

/** Rail source: pull requests (inbox) or local worktrees. */
export type ReviewMode = "pull_requests" | "worktrees";

/**
 * One entry of the screen's own back/forward history. The shell owns the stack; slots use the
 * `ReviewNavigation` it hands them and never touch history themselves.
 */
export interface ReviewViewState {
  mode: ReviewMode;
  source: ReviewSource | null;
  tab: ReviewDetailTab;
  /** File open on the Changes tab. */
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

/** One revision of the file list, as `forge.change_request.list_files` returned it. */
export interface ReviewFileSnapshot {
  baseSha: string;
  headSha: string;
  files: ChangeRequestFile[];
}

// ---- Slot props: S2 header + rail + detail header, S3 desk, S4 overview + inspector, S5 fix sheet ----

/** Left rail: title, search, All / To review filter, one row per change request. */
export interface ReviewRailProps {
  /** Daemon whose forge CLI auth the rail reads through. */
  serverId: string;
  mode: ReviewMode;
  selected: ReviewSource | null;
  onOpen: (source: ReviewSource) => void;
}

/** Top bar: Review title, back/forward, Pull requests / Worktrees switch. */
export interface ReviewHeaderProps {
  mode: ReviewMode;
  navigation: ReviewNavigation;
  onModeChange: (mode: ReviewMode) => void;
}

/** Above the tabs: repo and number, title, state/branch/counter chips, Overview / Changes tabs. */
export interface ReviewDetailHeaderProps {
  source: ReviewSource;
  tab: ReviewDetailTab;
  onTabChange: (tab: ReviewDetailTab) => void;
}

/** Overview tab: stacked cards (Description, a separate Checks card, Threads, Commits). */
export interface ReviewOverviewProps {
  source: ReviewSource;
  onJumpTo: ReviewJumpTo;
  selection: ReviewSelection;
  onSelectionChange: (next: ReviewSelection) => void;
}

/** Changes tab: file tree beside the diff. */
export interface ReviewDeskProps {
  source: ReviewSource;
  /** Set by the shell when a card or the inspector asks the desk to move. `nonce` changes on every request so repeating a target still fires. */
  focus: { path: string; line: number | null; nonce: number } | null;
  selection: ReviewSelection;
  onSelectionChange: (next: ReviewSelection) => void;
}

/** Changes tab, right column: Threads / Checks beside the diff. Collapsible. */
export interface ReviewInspectorProps {
  source: ReviewSource;
  tab: ReviewInspectorTab;
  onTabChange: (tab: ReviewInspectorTab) => void;
  onJumpTo: ReviewJumpTo;
  selection: ReviewSelection;
  onSelectionChange: (next: ReviewSelection) => void;
}

export interface ReviewFixSheetProps {
  source: ReviewSource;
  selection: ReviewSelection;
  visible: boolean;
  onClose: () => void;
}
