import { memo, useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Check, X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { AgentPermissionResolutionMarker } from "@pimi/protocol/agent-types";
import { DensityIcon } from "@/components/ui/density-icon";
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
      style={styles.row}
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

// Sits on the tool-call rows' rail: same icon slot, text size and color, without their chrome.
const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    maxWidth: "100%",
    marginLeft: -4,
    paddingVertical: theme.spacing[1],
    paddingRight: theme.spacing[2],
    marginBottom: theme.spacing[1],
    borderRadius: theme.borderRadius.lg,
  },
  icon: {
    width: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
    marginRight: theme.spacing[1],
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
    backgroundColor: theme.colors.surface2,
  },
  summary: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
}));
