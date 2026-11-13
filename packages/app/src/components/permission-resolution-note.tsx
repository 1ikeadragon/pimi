import { memo, useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Check, X } from "lucide-react-native";
import { useTranslation } from "@/i18n/use-translation";
import type { AgentPermissionResolutionMarker } from "@pimi/protocol/agent-types";
import { DensityIcon } from "@/components/ui/density-icon";
import { bySizing } from "@/components/ui/control-sizing";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useSessionStore } from "@/stores/session-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";

function resolutionLabelKey(marker: AgentPermissionResolutionMarker) {
  if (marker.decision === "deny") return "agentStream.permission.deniedBy" as const;
  return marker.kind === "question"
    ? ("agentStream.permission.answeredBy" as const)
    : ("agentStream.permission.allowedBy" as const);
}

/**
 * Stands where a permission prompt was after another agent answered it: one muted line naming
 * who decided and what, which opens that agent.
 */
export const PermissionResolutionNote = memo(function PermissionResolutionNote({
  marker,
  serverId,
}: {
  marker: AgentPermissionResolutionMarker;
  serverId: string;
}) {
  const { t } = useTranslation();
  const { agentId } = marker.resolvedBy;
  const currentTitle = useSessionStore((state) => {
    const session = state.sessions[serverId];
    return (session?.agents.get(agentId) ?? session?.agentDetails.get(agentId))?.title;
  });
  const label = t(resolutionLabelKey(marker), {
    agent: currentTitle || marker.resolvedBy.title,
  });
  const handlePress = useCallback(() => {
    navigateToAgent({ serverId, agentId });
  }, [serverId, agentId]);
  const [isHovered, setIsHovered] = useState(false);
  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);
  const textStyle = useMemo(() => [styles.text, isHovered && styles.textHovered], [isHovered]);

  return (
    <PressHighlight
      style={[styles.row, isHovered && styles.rowHovered]}
      highlightStyle={styles.pressed}
      onPress={handlePress}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      accessibilityRole="link"
      testID="permission-resolution-note"
    >
      <View style={styles.icon}>
        <DensityIcon
          icon={marker.decision === "allow" ? Check : X}
          size="sm"
          color="foregroundMuted"
        />
      </View>
      <Text style={textStyle} numberOfLines={1}>
        {label}
        {" · "}
        {marker.tool}
        {marker.summary ? " " : null}
        {marker.summary ? <Text style={styles.summary}>{marker.summary}</Text> : null}
      </Text>
    </PressHighlight>
  );
});

// Sits on the activity rows' rail: same glyph column, text start, size and color.
const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    maxWidth: "100%",
    marginLeft: -theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    height: bySizing({ touch: 36, pointer: 28 }),
    borderRadius: theme.borderRadius.lg,
  },
  rowHovered: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  icon: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
    marginRight: theme.spacing[3],
  },
  text: {
    flexShrink: 1,
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  textHovered: {
    color: theme.colors.foreground,
  },
  pressed: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  summary: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
  },
}));
