import { useCallback, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { PimiDelegation } from "@/utils/pimi-delegation";
import { AGENT_PROVIDER_DEFINITIONS } from "@pimi/protocol/provider-manifest";
import { ModelProviderGlyph } from "@/components/model-browser";
import { Button } from "@/components/ui/button";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { selectAgentTurnPresentation, useSessionStore, type Agent } from "@/stores/session-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";

function matchesWorker(agent: Agent | undefined, { source, worker }: PimiDelegation) {
  if (
    agent &&
    (agent.serverId !== source.serverId ||
      agent.parentAgentId !== source.agentId ||
      agent.provider !== worker.provider ||
      (agent.labels["paseo.parent-server-id"] !== undefined &&
        agent.labels["paseo.parent-server-id"] !== source.serverId))
  ) {
    return false;
  }
  return true;
}

function workerStatus(agent: Agent | undefined, connected: boolean, isActive: boolean) {
  let status = "Created · Status unavailable";
  if (agent) {
    if (!connected) status = "Offline · Status unavailable";
    else if (agent.archivedAt) status = "Archived";
    else if (agent.pendingPermissions.length || agent.attentionReason === "permission")
      status = "Needs permission";
    else if (agent.status === "error") status = "Failed";
    else if (isActive || agent.status === "running" || (agent.backgroundWork?.count ?? 0) > 0)
      status = "Working";
    else if (agent.status === "initializing") status = "Starting";
    else if (agent.status === "closed") status = "Closed";
    else if (agent.attentionReason === "finished") status = "Finished";
    else status = "Idle";
  }
  return status;
}

function workerLabels(
  entries: ReturnType<typeof useProvidersSnapshot>["entries"],
  provider: string,
  modelId: string | null | undefined,
) {
  const entry = entries?.find((item) => item.provider === provider);
  const providerLabel =
    entry?.label ??
    AGENT_PROVIDER_DEFINITIONS.find((item) => item.id === provider)?.label ??
    provider;
  const modelLabel = entry?.models?.find((model) => model.id === modelId)?.label ?? modelId;
  return { providerLabel, modelLabel };
}

/** A creation receipt whose status is subscribed to the host's real worker state. */
export function PimiDelegationCard({
  delegation,
  children,
}: {
  delegation: PimiDelegation;
  children: ReactNode;
}) {
  const { source, worker, sharedContext, shortened } = delegation;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const agent = useSessionStore((state) => {
    const session = state.sessions[source.serverId];
    return session?.agents.get(worker.id) ?? session?.agentDetails.get(worker.id);
  });
  const isActive = useSessionStore(
    (state) => selectAgentTurnPresentation(state.sessions[source.serverId], worker.id).isActive,
  );
  const connected = useHostRuntimeIsConnected(source.serverId);
  const { entries } = useProvidersSnapshot(source.serverId);
  const toggleDetails = useCallback(() => setDetailsOpen((open) => !open), []);
  const openAgent = useCallback(
    () => navigateToAgent({ serverId: source.serverId, agentId: worker.id }),
    [source.serverId, worker.id],
  );
  if (!matchesWorker(agent, delegation)) return children;
  const provider = agent?.provider ?? worker.provider;
  const { providerLabel, modelLabel } = workerLabels(
    entries,
    provider,
    agent ? agent.model : worker.model,
  );
  const status = workerStatus(agent, connected, isActive);
  let contextLabel = "Separate context";
  if (sharedContext) contextLabel = shortened ? "Context shared · Shortened" : "Context shared";
  return (
    <View style={styles.card} testID="pimi-delegation-card">
      <View style={styles.header}>
        <View style={styles.identity}>
          <ModelProviderGlyph
            provider={provider}
            serverId={source.serverId}
            size={18}
            tone="foreground"
          />
          <Text style={styles.provider} numberOfLines={1}>
            {providerLabel}
          </Text>
        </View>
        <Text style={styles.status} accessibilityLiveRegion="polite">
          {status}
        </Text>
      </View>
      {modelLabel ? (
        <Text style={styles.meta} selectable>
          {modelLabel}
        </Text>
      ) : null}
      <Text style={styles.title} selectable>
        {agent?.title || worker.title}
      </Text>
      <View style={styles.footer}>
        <Text style={styles.context}>{contextLabel}</Text>
        <View style={styles.actions}>
          <Button variant="ghost" size="sm" onPress={toggleDetails}>
            {detailsOpen ? "Hide details" : "Details"}
          </Button>
          {agent ? (
            <Button variant="secondary" size="sm" onPress={openAgent}>
              Open agent
            </Button>
          ) : null}
        </View>
      </View>
      {detailsOpen ? children : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    marginVertical: theme.spacing[2],
    padding: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
    gap: theme.spacing[2],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
  identity: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 1,
  },
  provider: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    flexShrink: 1,
  },
  status: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  meta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  context: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    backgroundColor: theme.colors.surface2,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.spacing[1],
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
}));
