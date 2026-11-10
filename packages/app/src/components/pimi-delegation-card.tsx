import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ChevronDown, ChevronUp } from "lucide-react-native";
import type { PimiDelegation } from "@/utils/pimi-delegation";
import { AGENT_PROVIDER_DEFINITIONS } from "@pimi/protocol/provider-manifest";
import { ModelProviderGlyph } from "@/components/model-browser";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
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

type WorkerTone = "idle" | "working" | "attention" | "failed" | "done";

interface WorkerStatus {
  label: string;
  tone: WorkerTone;
}

function workerStatus(
  agent: Agent | undefined,
  connected: boolean,
  isActive: boolean,
): WorkerStatus {
  if (!agent) return { label: "Created", tone: "idle" };
  if (!connected) return { label: "Offline", tone: "idle" };
  if (agent.archivedAt) return { label: "Archived", tone: "idle" };
  if (agent.pendingPermissions.length || agent.attentionReason === "permission")
    return { label: "Needs permission", tone: "attention" };
  if (agent.status === "error") return { label: "Failed", tone: "failed" };
  if (isActive || agent.status === "running" || (agent.backgroundWork?.count ?? 0) > 0)
    return { label: "Working", tone: "working" };
  if (agent.status === "initializing") return { label: "Starting", tone: "working" };
  if (agent.status === "closed") return { label: "Closed", tone: "idle" };
  if (agent.attentionReason === "finished") return { label: "Finished", tone: "done" };
  return { label: "Idle", tone: "idle" };
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
  if (sharedContext) contextLabel = shortened ? "Context shared, shortened" : "Context shared";
  const title = agent?.title || worker.title;
  const meta = [providerLabel, modelLabel, contextLabel].filter(Boolean).join(" · ");
  return (
    <View style={styles.card} testID="pimi-delegation-card">
      <View style={styles.header}>
        <DelegationRow
          title={title}
          meta={meta}
          status={status}
          onOpen={agent ? openAgent : undefined}
          provider={provider}
          serverId={source.serverId}
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={detailsOpen ? ChevronUp : ChevronDown}
          accessibilityLabel={detailsOpen ? "Hide details" : "Show details"}
          onPress={toggleDetails}
        />
      </View>
      {detailsOpen ? <View style={styles.details}>{children}</View> : null}
    </View>
  );
}

const GLYPH_SIZE = 16;

/** The whole row opens the agent, so there is no separate button to find. */
function DelegationRow({
  title,
  meta,
  status,
  provider,
  serverId,
  onOpen,
}: {
  title: string;
  meta: string;
  status: WorkerStatus;
  provider: string;
  serverId: string;
  onOpen?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const hoverIn = useCallback(() => setHovered(true), []);
  const hoverOut = useCallback(() => setHovered(false), []);
  const rowStyle = useMemo(
    () => [styles.row, hovered && onOpen && styles.rowHovered],
    [hovered, onOpen],
  );
  const dotStyle = useMemo(() => [styles.dot, DOT_STYLES[status.tone]], [status.tone]);
  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityLabel={`Open agent: ${title}. ${status.label}`}
      disabled={!onOpen}
      onPress={onOpen}
      onHoverIn={hoverIn}
      onHoverOut={hoverOut}
      highlightStyle={styles.rowHovered}
      style={rowStyle}
    >
      <ModelProviderGlyph
        provider={provider}
        serverId={serverId}
        size={GLYPH_SIZE}
        tone="foreground"
      />
      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {meta}
        </Text>
      </View>
      <View style={styles.status}>
        <View style={dotStyle} />
        <Text style={styles.statusText} accessibilityLiveRegion="polite">
          {status.label}
        </Text>
      </View>
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    marginVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
  },
  header: { flexDirection: "row", alignItems: "center", paddingRight: theme.spacing[1] },
  row: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    columnGap: theme.spacing[3],
    rowGap: theme.spacing[1],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  rowHovered: { backgroundColor: theme.colors.surface2 },
  text: { flex: 1, minWidth: 140, gap: 2 },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  meta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  status: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1.5] },
  statusText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  dot: { width: 7, height: 7, borderRadius: theme.borderRadius.full },
  dotIdle: { backgroundColor: theme.colors.border },
  dotWorking: { backgroundColor: theme.colors.statusDotRunning },
  dotAttention: { backgroundColor: theme.colors.statusDotWarning },
  dotFailed: { backgroundColor: theme.colors.statusDotDanger },
  dotDone: { backgroundColor: theme.colors.statusDotSuccess },
  details: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
}));

const DOT_STYLES = {
  idle: styles.dotIdle,
  working: styles.dotWorking,
  attention: styles.dotAttention,
  failed: styles.dotFailed,
  done: styles.dotDone,
} satisfies Record<WorkerTone, unknown>;
