// Pimi Android Work view backed by connected-host workspace state. Apache-2.0.
import { BriefcaseBusiness, RefreshCw, X } from "lucide-react-native";
import { useCallback } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { MenuHeader } from "@/components/headers/menu-header";
import { DensityIcon } from "@/components/ui/density-icon";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { useSidebarWorkspacesList } from "@/hooks/use-sidebar-workspaces-list";
import { closePimiWork } from "@/navigation/pimi-work";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { useHostRuntimeConnectionStatus } from "@/runtime/host-runtime";
import type { SidebarWorkspacePlacement } from "@/hooks/sidebar-workspaces-view-model";

const BACKGROUND = { "pimi-background": "" };
const close = (
  <ToolbarButton label="Close Work" onPress={closePimiWork}>
    <DensityIcon icon={X} size="sm" color="foregroundMuted" />
  </ToolbarButton>
);

function selectWorkspaceSummary(workspace: WorkspaceDescriptor) {
  return {
    status: workspace.status,
    currentBranch: workspace.gitRuntime?.currentBranch ?? null,
    diffStat: workspace.diffStat,
  };
}

function describeConnection(status: ReturnType<typeof useHostRuntimeConnectionStatus>): string {
  if (status === "online") return "Connected";
  if (status === "connecting") return "Connecting";
  return "Offline";
}

export function PimiWorkScreen() {
  const { workspacePlacements, isInitialLoad, refreshAll } = useSidebarWorkspacesList({
    hostFilters: [],
  });

  return (
    <View style={styles.screen} dataSet={BACKGROUND} testID="pimi-work">
      <MenuHeader
        title="Work"
        rightContent={
          <>
            <ToolbarButton label="Refresh workspaces" onPress={refreshAll}>
              <DensityIcon icon={RefreshCw} size="sm" color="foregroundMuted" />
            </ToolbarButton>
            {close}
          </>
        }
      />
      <ScrollView contentContainerStyle={styles.list}>
        {workspacePlacements.map((placement) => (
          <WorkspaceCard key={placement.workspaceKey} placement={placement} />
        ))}
        {workspacePlacements.length === 0 ? (
          <Text style={styles.empty}>
            {isInitialLoad ? "Loading workspaces…" : "No workspaces on connected hosts."}
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

function WorkspaceCard({ placement }: { placement: SidebarWorkspacePlacement }) {
  const summary = useWorkspaceFields(
    placement.serverId,
    placement.workspaceId,
    selectWorkspaceSummary,
  );
  const connection = useHostRuntimeConnectionStatus(placement.serverId);
  const branch = summary?.currentBranch?.trim();
  const status = summary?.status.replaceAll("_", " ") ?? "Status unavailable";
  const diff = summary?.diffStat;
  const connectionText = describeConnection(connection);
  const openWorkspace = useCallback(
    () => navigateToWorkspace({ serverId: placement.serverId, workspaceId: placement.workspaceId }),
    [placement.serverId, placement.workspaceId],
  );
  const reviewChanges = useCallback(
    () =>
      navigateToWorkspace({
        serverId: placement.serverId,
        workspaceId: placement.workspaceId,
        target: { kind: "changes_tree" },
      }),
    [placement.serverId, placement.workspaceId],
  );

  return (
    <View style={styles.card} testID={`pimi-workspace-${placement.workspaceId}`}>
      <View style={styles.cardHeading}>
        <DensityIcon icon={BriefcaseBusiness} size="sm" color="foregroundMuted" />
        <View style={styles.titles}>
          <Text style={styles.project} numberOfLines={1}>
            {placement.projectName}
          </Text>
          <Text style={styles.name} numberOfLines={1}>
            {placement.name}
          </Text>
        </View>
      </View>
      <Text style={styles.metadata}>
        {branch || placement.workspaceKind}
        {branch ? ` · ${placement.workspaceKind}` : ""}
        {` · ${connectionText}`}
      </Text>
      <Text style={styles.metadata}>
        {status}
        {diff ? ` · +${diff.additions} / −${diff.deletions}` : ""}
      </Text>
      <View style={styles.actions}>
        <Button size="sm" variant="secondary" onPress={openWorkspace}>
          Open workspace
        </Button>
        <Button size="sm" variant="outline" onPress={reviewChanges}>
          Review changes
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, minWidth: 0, backgroundColor: theme.colors.surface0 },
  list: {
    width: "100%",
    maxWidth: 980,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
    gap: theme.spacing[3],
  },
  card: {
    padding: theme.spacing[4],
    gap: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  cardHeading: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  titles: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  project: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  name: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  metadata: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingTop: theme.spacing[1],
  },
  empty: {
    paddingVertical: theme.spacing[8],
    textAlign: "center",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
