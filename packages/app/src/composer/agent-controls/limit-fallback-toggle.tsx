import { memo, useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/contexts/toast-api-context";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useTranslation } from "@/i18n/use-translation";
import { useSessionStore } from "@/stores/session-store";

/**
 * Per-chat opt-out from the host's auto-switch on limit. Shown only while the host has the
 * feature on, so a chat never carries a switch that does nothing.
 */
export const LimitFallbackToggle = memo(function LimitFallbackToggle({
  serverId,
  agentId,
}: {
  serverId: string;
  agentId: string;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { config } = useDaemonConfig(serverId);
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const disabled = useSessionStore(
    (state) => state.sessions[serverId]?.agents?.get(agentId)?.limitFallbackDisabled === true,
  );
  const handleChange = useCallback(
    (enabled: boolean) => {
      if (!client) return;
      client.setAgentLimitFallbackDisabled(agentId, !enabled).catch((error: unknown) => {
        toast.error(
          `${t("agentControls.limitFallback.error")}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    },
    [agentId, client, t, toast],
  );
  if (config?.limitFallback.enabled !== true) return null;
  return (
    <View style={styles.row} testID="agent-limit-fallback-toggle">
      <View style={styles.text}>
        <Text style={styles.label}>{t("agentControls.limitFallback.label")}</Text>
        <Text style={styles.hint}>{t("agentControls.limitFallback.hint")}</Text>
      </View>
      <Switch
        value={!disabled}
        disabled={!client}
        onValueChange={handleChange}
        accessibilityLabel={t("agentControls.limitFallback.label")}
        testID="agent-limit-fallback-switch"
      />
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  text: {
    flex: 1,
    gap: theme.spacing[1],
  },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
