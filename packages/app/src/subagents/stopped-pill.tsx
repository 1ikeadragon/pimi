import { STOPPED_BY_AGENT_ID_LABEL } from "@pimi/protocol/agent-labels";
import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text } from "react-native";
import { useTranslation } from "@/i18n/use-translation";
import { StyleSheet } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { composerPillStyles } from "@/composer/pill-styles";
import { useToast } from "@/contexts/toast-context";
import { useSessionStore } from "@/stores/session-store";
import { toErrorMessage } from "@/utils/error-messages";

/**
 * After Stop also stopped this agent's working subagents: "Stopped with N subagents · Resume".
 * Resume sends each of them, and this agent when it was mid-turn, a short continue prompt. The
 * daemon removes the marker when the agent starts any other turn, so typing a new message
 * dismisses the pill without resuming anything.
 */
export function StoppedSubagentsPill({
  serverId,
  agentId,
}: {
  serverId: string;
  agentId: string;
}): ReactElement | null {
  const { t } = useTranslation();
  const toast = useToast();
  const count = useSessionStore((state) => {
    let stopped = 0;
    for (const agent of state.sessions[serverId]?.agents.values() ?? []) {
      if (!agent.archivedAt && agent.labels[STOPPED_BY_AGENT_ID_LABEL] === agentId) stopped += 1;
    }
    return stopped;
  });
  const [isPending, setIsPending] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);
  const handlePress = useCallback(() => {
    const client = useSessionStore.getState().sessions[serverId]?.client;
    if (!client || isPending) return;
    setIsPending(true);
    client
      .resumeStoppedSubagents(agentId)
      .catch((error: unknown) => toast.error(toErrorMessage(error)))
      .finally(() => setIsPending(false));
  }, [agentId, isPending, serverId, toast]);
  const accessibilityState = useMemo(() => ({ disabled: isPending, busy: isPending }), [isPending]);
  const bodyStyle = useMemo(
    () => [composerPillStyles.body, isHovered && composerPillStyles.bodyActive],
    [isHovered],
  );

  if (count === 0) return null;
  return (
    <PressHighlight
      testID="composer-stopped-subagents-pill"
      accessibilityRole="button"
      accessibilityLabel={t("subagents.resumeStoppedLabel")}
      accessibilityState={accessibilityState}
      disabled={isPending}
      onPress={handlePress}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      style={bodyStyle}
      highlightStyle={composerPillStyles.bodyActive}
    >
      <Text style={composerPillStyles.label} numberOfLines={1}>
        {count === 1 ? t("subagents.stoppedOne") : t("subagents.stoppedMany", { count })}
        {" · "}
        <Text style={styles.action}>{t("subagents.resumeStopped")}</Text>
      </Text>
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  action: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
}));
