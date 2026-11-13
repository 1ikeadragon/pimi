import { Text, View } from "react-native";
import { Search } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "@/i18n/use-translation";
import { invariant } from "@/utils/invariant";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel, type PanelPresentation } from "@/panels/panel-registry";
import { WorkspaceSearchView } from "@/workspace-search/view";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

const ThemedSearch = withUnistyles(Search);
const searchPanelPresentation = {
  label: (t) => t("workspaceSearch.label"),
  subtitle: (t) => t("workspaceSearch.subtitle"),
  tooltip: (t) => t("workspaceSearch.label"),
  icon: ThemedSearch,
} satisfies PanelPresentation;

function SearchPanel() {
  const { t } = useTranslation();
  const { serverId, workspaceId, target } = usePaneContext();
  invariant(target.kind === "search", "SearchPanel requires search target");
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  if (!workspaceKey) {
    return (
      <View style={styles.centerState}>
        <Text>{t("panels.file.directoryMissing")}</Text>
      </View>
    );
  }
  return (
    <WorkspaceSearchView
      serverId={serverId}
      workspaceId={workspaceId}
      workspaceKey={workspaceKey}
    />
  );
}

export const searchPanelRegistration = definePanel("search", {
  component: SearchPanel,
  presentation: searchPanelPresentation,
});

const styles = StyleSheet.create((theme) => ({
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
}));
