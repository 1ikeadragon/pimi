import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import { buildWorkspaceKeyboardHandlerId } from "@/keyboard/handler-id";
import { isWeb } from "@/constants/platform";
import { openExplorerSidebarView } from "@/workspace-tabs/explorer-sidebar";
import { getWorkspaceSearchStore } from "./store";

const MAX_SEED_LENGTH = 200;

/** The editor's selection when it is a single line, as VS Code seeds the Search field. */
function readSelectedLine(): string | undefined {
  if (!isWeb || typeof document === "undefined") return undefined;
  const selected = document.getSelection()?.toString() ?? "";
  if (selected.length === 0 || selected.length > MAX_SEED_LENGTH || /[\r\n]/.test(selected)) {
    return undefined;
  }
  return selected;
}

/**
 * Cmd/Ctrl+Shift+F reveals the Search view and focuses its query; Cmd/Ctrl+Shift+H does the same
 * with the replace field open. Registered once by the workspace screen.
 */
export function useWorkspaceSearchShortcuts(input: {
  serverId: string;
  workspaceId: string;
  workspaceKey: string | null;
  isCompact: boolean;
  enabled: boolean;
}) {
  useKeyboardActionHandler({
    handlerId: buildWorkspaceKeyboardHandlerId({
      name: "workspace-search",
      serverId: input.serverId,
      workspaceId: input.workspaceId,
    }),
    actions: ["search.workspace", "search.replace"] as const,
    enabled: input.enabled,
    priority: 100,
    handle: (action) => {
      if (!input.workspaceKey) return false;
      const store = getWorkspaceSearchStore(input.workspaceKey).getState();
      // Read before the view takes focus: the editor's selection is gone once it does.
      const seed = readSelectedLine();
      if (action.id === "search.replace") store.setReplaceOpen(true);
      openExplorerSidebarView({
        isCompact: input.isCompact,
        workspaceKey: input.workspaceKey,
        view: "search",
      });
      store.requestFocus(seed);
      return true;
    },
  });
}
