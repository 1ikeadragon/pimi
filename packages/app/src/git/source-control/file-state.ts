import type { NestedFileState } from "@pimi/protocol/messages";

export type FileStateTone = "modified" | "added" | "deleted" | "renamed";

export interface FileStatePresentation {
  letter: string;
  /** Which status token colours the letter. */
  tone: FileStateTone;
}

export const FILE_STATE_PRESENTATION: Record<NestedFileState, FileStatePresentation> = {
  modified: { letter: "M", tone: "modified" },
  added: { letter: "A", tone: "added" },
  deleted: { letter: "D", tone: "deleted" },
  renamed: { letter: "R", tone: "renamed" },
  untracked: { letter: "U", tone: "added" },
  conflicted: { letter: "!", tone: "deleted" },
};
