import { generateMessageId } from "@/types/stream";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import type { TerminalProfile } from "@pimi/protocol/messages";

export type NewTabSelection =
  | { kind: "target"; target: WorkspaceTab["target"] }
  | { kind: "agent" }
  | { kind: "terminal"; profile?: TerminalProfile }
  | { kind: "browser" };

export function createNewWorkspaceTab(): WorkspaceTab {
  return {
    tabId: `tab_${generateMessageId()}`,
    target: { kind: "new_tab" },
    createdAt: Date.now(),
  };
}

/**
 * `state` of a launcher that exists because a pane has to hold a tab (its last tab closed, a
 * layout was restored, the last pane was removed), not because the user opened "New tab". Such a
 * launcher does not grab keyboard focus: a stray Enter after a close would start an agent.
 */
const FALLBACK_LAUNCHER_STATE = { fallback: true };

export function createFallbackNewWorkspaceTab(): WorkspaceTab {
  return { ...createNewWorkspaceTab(), state: FALLBACK_LAUNCHER_STATE };
}

export function isFallbackLauncherState(state: WorkspaceTab["state"]): boolean {
  return (
    typeof state === "object" && state !== null && !Array.isArray(state) && state.fallback === true
  );
}
