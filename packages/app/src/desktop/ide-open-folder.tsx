import { useCallback, useState } from "react";
import { FolderInput } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { extraMutedIconColorMapping } from "@/components/ui/icon-button-chrome";
import { ToolbarButton, paneContentToolbarIconSize } from "@/components/ui/pane-content-toolbar";
import { i18n } from "@/i18n/i18next";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { isAbsolutePath } from "@/utils/path";
import { openPathInIde, toHostPath } from "./open-in-ide";

const ThemedFolderIcon = withUnistyles(FolderInput);

function selectDirectory(workspace: { workspaceDirectory: string }) {
  return workspace.workspaceDirectory;
}

function validateFolder(value: string): string | null {
  const path = value.trim();
  if (path === "~" || path.startsWith("~/")) return i18n.t("ideMode.folderNotHomeRelative");
  return null;
}

/** IDE Mode's way to open any folder on the host: a path, absolute or relative to this chat's. */
export function IdeOpenFolderButton() {
  const selection = useActiveWorkspaceSelection();
  const serverId = selection?.serverId ?? null;
  const directory = useWorkspaceFields(serverId, selection?.workspaceId ?? null, selectDirectory);
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);
  const submit = useCallback(
    async (value: string) => {
      const path = value.trim();
      const hostPath = isAbsolutePath(path) ? path : toHostPath(path, directory ?? "");
      if (!serverId || !hostPath) throw new Error(i18n.t("ideMode.unreachable", { path }));
      const result = await openPathInIde({
        serverId,
        path: hostPath,
        originWorkspaceId: selection?.workspaceId ?? null,
      });
      if (result === "unsaved") throw new Error(i18n.t("ideMode.unsavedLayout"));
      if (result === "unreachable") throw new Error(i18n.t("ideMode.unreachable", { path }));
    },
    [directory, selection?.workspaceId, serverId],
  );
  if (!serverId || !directory) return null;
  return (
    <>
      <ToolbarButton
        testID="pimi-ide-open-folder"
        label={i18n.t("ideMode.openFolder")}
        onPress={show}
      >
        <ThemedFolderIcon
          size={paneContentToolbarIconSize(false)}
          strokeWidth={1.5}
          uniProps={extraMutedIconColorMapping}
        />
      </ToolbarButton>
      <AdaptiveRenameModal
        visible={open}
        title={i18n.t("ideMode.openFolder")}
        initialValue={`${directory}/`}
        placeholder={directory}
        submitLabel={i18n.t("ideMode.open")}
        validate={validateFolder}
        onClose={close}
        onSubmit={submit}
        testID="pimi-ide-open-folder-modal"
      />
    </>
  );
}
