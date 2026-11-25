// Pimi. PolyForm-Noncommercial-1.0.0.
// Which chat the user's review notes go to. The chat that offered the review wins; otherwise the
// chats working in the directory under review, or in a directory around or inside it. Pure: the
// caller reads the session store and hands over plain candidates.
import { normalizeWorkspacePath } from "@/utils/workspace-identity";

export interface NoteChatCandidate {
  agentId: string;
  title: string;
  /** The chat's workspace directory, or its working directory when the workspace is unknown. */
  directory: string;
  /** Milliseconds since the epoch; the most recent chat is listed first. */
  lastActivityAt: number;
}

export type NoteTarget =
  | { kind: "chat"; chat: NoteChatCandidate }
  /** Several chats work here and nothing says which one the notes are for. */
  | { kind: "choose"; chats: NoteChatCandidate[] }
  | { kind: "none" };

// Windows paths (a drive letter or a UNC share) name the same file in any letter case.
function comparable(path: string): string {
  return /^[A-Za-z]:\//.test(path) || path.startsWith("//") ? path.toLowerCase() : path;
}

/** `path` is `folder` or lies under it. The boundary is a `/`, so `/repo-b` is not inside `/repo`. */
export function isPathWithin(path: string, folder: string): boolean {
  const target = comparable(path);
  const root = comparable(folder);
  return target === root || target.startsWith(root === "/" ? root : `${root}/`);
}

/** The directories are the same, or one holds the other. */
export function directoriesRelate(left: string, right: string): boolean {
  const a = normalizeWorkspacePath(left);
  const b = normalizeWorkspacePath(right);
  if (!a || !b) return false;
  return isPathWithin(a, b) || isPathWithin(b, a);
}

/**
 * `originAgentId` is the chat that offered this review, when the route names one and the chat is
 * still there (`origin` is null otherwise: unknown or archived chats are never targets).
 */
export function resolveNoteTarget(input: {
  cwd: string;
  origin: NoteChatCandidate | null;
  chats: readonly NoteChatCandidate[];
}): NoteTarget {
  if (input.origin) return { kind: "chat", chat: input.origin };
  const related = input.chats
    .filter((chat) => directoriesRelate(chat.directory, input.cwd))
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  if (related.length === 1) return { kind: "chat", chat: related[0] };
  if (related.length > 1) return { kind: "choose", chats: related };
  return { kind: "none" };
}
