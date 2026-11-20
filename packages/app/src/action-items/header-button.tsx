import { ListChecks } from "lucide-react-native";
import { useCallback } from "react";
import { withUnistyles } from "react-native-unistyles";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useTranslation } from "@/i18n/use-translation";
import type { Theme } from "@/styles/theme";
import { openExplorerSidebarView } from "@/workspace-tabs/explorer-sidebar";

const ThemedListChecks = withUnistyles(ListChecks);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** Opens the Explorer on the Action items tab. Hidden while the feature is off for the host. */
export function ActionItemsHeaderButton({
  serverId,
  workspaceKey,
}: {
  serverId: string;
  workspaceKey: string | null;
}) {
  const { t } = useTranslation();
  const { config } = useDaemonConfig(serverId);
  const handlePress = useCallback(() => {
    openExplorerSidebarView({ isCompact: false, workspaceKey, view: "actionItems" });
  }, [workspaceKey]);
  if (!workspaceKey || config?.metadataGeneration.actionItems === false) return null;
  return (
    <ToolbarButton
      label={t("actionItems.label")}
      onPress={handlePress}
      testID="workspace-action-items-button"
    >
      <ThemedListChecks size={16} uniProps={mutedMapping} />
    </ToolbarButton>
  );
}
