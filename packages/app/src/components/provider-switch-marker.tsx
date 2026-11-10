import { memo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ArrowRight } from "lucide-react-native";
import type {
  AgentProviderSwitchEndpoint,
  AgentProviderSwitchMarker,
} from "@pimi/protocol/agent-types";
import { ModelProviderGlyph } from "@/components/model-browser";
import { DensityIcon } from "@/components/ui/density-icon";

const GLYPH_SIZE = 13;

function endpointLabel(endpoint: AgentProviderSwitchEndpoint): string {
  const provider = endpoint.providerLabel ?? endpoint.provider;
  const model = endpoint.modelLabel ?? endpoint.model;
  return model ? `${provider} · ${model}` : provider;
}

function Endpoint({
  endpoint,
  serverId,
}: {
  endpoint: AgentProviderSwitchEndpoint;
  serverId: string;
}) {
  return (
    <View style={styles.endpoint}>
      <ModelProviderGlyph provider={endpoint.provider} serverId={serverId} size={GLYPH_SIZE} />
      <Text style={styles.label} numberOfLines={1}>
        {endpointLabel(endpoint)}
      </Text>
    </View>
  );
}

/**
 * Marks where in a chat the provider changed: a rule across the thread with the two providers
 * at its center, so the change reads as a seam in the conversation rather than as a message.
 */
export const ProviderSwitchMarker = memo(function ProviderSwitchMarker({
  marker,
  serverId,
}: {
  marker: AgentProviderSwitchMarker;
  serverId: string;
}) {
  return (
    <View
      style={styles.row}
      testID="provider-switch-marker"
      accessibilityLabel={`${endpointLabel(marker.from)} → ${endpointLabel(marker.to)}`}
    >
      <View style={styles.rule} />
      <View style={styles.center}>
        <Endpoint endpoint={marker.from} serverId={serverId} />
        <DensityIcon icon={ArrowRight} size="sm" sizeAdjustment={-4} color="foregroundMuted" />
        <Endpoint endpoint={marker.to} serverId={serverId} />
      </View>
      <View style={styles.rule} />
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  // The rules give way first, so two long model names still fit a narrow chat.
  rule: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: theme.spacing[4],
    height: 1,
    backgroundColor: theme.colors.border,
  },
  center: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    flexWrap: "wrap",
    flexShrink: 1,
    gap: theme.spacing[2],
  },
  endpoint: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 1,
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
}));
