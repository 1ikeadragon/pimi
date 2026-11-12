// Pimi. Apache-2.0.
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
      /** A checkout of the same repository on `serverId`, used for CLI auth context only. */
      cwd?: string;
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

export type ReviewInspectorTab = "threads" | "checks" | "about";

/** One revision of the file list, as `forge.change_request.list_files` returned it. */
export interface ReviewFileSnapshot {
  baseSha: string;
  headSha: string;
  files: ChangeRequestFile[];
}

// ---- Slot props (S2 header/inbox, S3 desk, S4 inspector, S5 fix sheet) ----

export interface ReviewInboxProps {
  /** Daemon whose forge CLI auth the inbox reads through. */
  serverId: string;
  onOpen: (source: ReviewSource) => void;
}

export interface ReviewHeaderProps {
  source: ReviewSource;
  onBack: () => void;
}

export interface ReviewDeskProps {
  source: ReviewSource;
  /** Set by the shell when the inspector (or a deep link) asks the desk to move. `nonce` changes on every request so repeating the same target still fires. */
  focus: { path: string; line: number | null; nonce: number } | null;
  selection: ReviewSelection;
  onSelectionChange: (next: ReviewSelection) => void;
}

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
