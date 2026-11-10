import { memo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type {
  AgentProviderSwitchEndpoint,
  AgentProviderSwitchMarker,
} from "@pimi/protocol/agent-types";
import { ModelProviderGlyph } from "@/components/model-browser";
import { ICON_SIZE } from "@/styles/theme";

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
      <ModelProviderGlyph provider={endpoint.provider} serverId={serverId} size={ICON_SIZE.sm} />
      <Text style={styles.label} numberOfLines={1}>
        {endpointLabel(endpoint)}
      </Text>
    </View>
  );
}

/** Shows where in a chat the provider changed. */
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
      <Endpoint endpoint={marker.from} serverId={serverId} />
      <Text style={styles.arrow}>→</Text>
      <Endpoint endpoint={marker.to} serverId={serverId} />
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    marginVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
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
  arrow: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
