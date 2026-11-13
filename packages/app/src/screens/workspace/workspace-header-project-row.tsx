import { GitBranch } from "lucide-react-native";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { HostBadge } from "@/hosts/host-badge";
import { useHostBadges } from "@/hosts/use-host-badges";

/**
 * Which project the workspace belongs to, and which machine it runs on.
 *
 * Compact gets both, on their own line under the workspace name: this header is the only thing on
 * screen that says where the workspace lives, because the sidebar that normally carries the host
 * badge is closed. It still follows the host's own badge setting, so a purely local setup stays
 * quiet. A project name that only repeats the workspace name is dropped on wide, where the two sit
 * side by side, and kept on compact, where the line exists for the host anyway.
 */
const ThemedGitBranch = withUnistyles(GitBranch);
const branchIconMapping = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});

export function WorkspaceHeaderProjectRow({
  subtitle,
  isSubtitleDistinct,
  branch,
  serverId,
}: {
  subtitle: string;
  isSubtitleDistinct: boolean;
  /** The checked-out branch, shown as a chip next to the project. */
  branch: string | null;
  serverId: string;
}) {
  const isCompact = useIsCompactFormFactor();
  const hostBadge = useHostBadges({ enabled: isCompact }).get(serverId) ?? null;
  const showProject = isSubtitleDistinct || isCompact;
  if (!showProject && !hostBadge && !branch) {
    return null;
  }
  return (
    <View style={styles.row}>
      {showProject ? (
        <Text
          testID="workspace-header-subtitle"
          style={hostBadge ? styles.projectBesideHost : styles.project}
          numberOfLines={1}
        >
          {subtitle}
        </Text>
      ) : null}
      {showProject && branch ? <Text style={styles.separator}>·</Text> : null}
      {branch ? (
        <View style={styles.branch} testID="workspace-header-branch">
          <ThemedGitBranch size={12} uniProps={branchIconMapping} />
          <Text style={styles.branchText} numberOfLines={1}>
            {branch}
          </Text>
        </View>
      ) : null}
      {(showProject || branch) && hostBadge ? <Text style={styles.separator}>·</Text> : null}
      {hostBadge ? <HostBadge badge={hostBadge} /> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The compact header stretches this row to its available title width. Within that width,
  // HostBadge yields its label first while retaining its fixed icon. Beside a host the project
  // does not shrink below its cap: even a weighted shrink takes a subpixel off it, which is enough
  // for the browser to ellipsize a short name ("re…" for "repo").
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    minWidth: 0,
    flexShrink: 1,
  },
  project: {
    color: theme.colors.foregroundMuted,
    fontSize: {
      xs: theme.fontSize.sm,
      md: theme.fontSize.base,
    },
    flexShrink: 1,
    minWidth: 0,
  },
  projectBesideHost: {
    color: theme.colors.foregroundMuted,
    fontSize: {
      xs: theme.fontSize.sm,
      md: theme.fontSize.base,
    },
    flexShrink: 0,
    maxWidth: "60%",
  },
  branch: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 1,
    minWidth: 0,
  },
  branchText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
    minWidth: 0,
  },
  separator: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 0,
  },
}));
