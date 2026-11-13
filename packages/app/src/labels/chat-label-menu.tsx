import { useMemo, type ReactElement } from "react";
import { Tag } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { DropdownMenuSubTrigger } from "@/components/ui/dropdown-menu";
import type { MenuPageDefinition } from "@/components/ui/menu";
import { useTranslation } from "@/i18n/use-translation";
import type { Theme } from "@/styles/theme";
import { LABEL_PAGE_ID, useLabelMenuPages } from "./picker";
import { useWorkspacePrimaryChatTarget } from "./workspace-chat";

const ThemedTag = withUnistyles(Tag);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const TAG_ICON = <ThemedTag size={16} uniProps={mutedMapping} />;

/**
 * The `Labels` row and its pages for a workspace's primary chat, for dropdown menus that have no
 * label row of their own (the chat header). The trigger is null when the workspace has no chat
 * to label.
 */
export function useChatLabelMenu(
  serverId: string,
  workspaceId: string,
): { pages: readonly MenuPageDefinition[]; trigger: ReactElement | null } {
  const { t } = useTranslation();
  const target = useWorkspacePrimaryChatTarget(serverId, workspaceId);
  const pages = useLabelMenuPages(serverId, target);
  const trigger = useMemo(
    () =>
      target ? (
        <DropdownMenuSubTrigger
          id={LABEL_PAGE_ID}
          leading={TAG_ICON}
          testID="workspace-header-labels"
        >
          {t("workspaceLabels.title")}
        </DropdownMenuSubTrigger>
      ) : null,
    [t, target],
  );
  return { pages, trigger };
}
