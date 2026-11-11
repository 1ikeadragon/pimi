import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
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
import { useSessionStore, type Agent } from "@/stores/session-store";
import {
  managedSubagentStatusBucket,
  SUBAGENT_STATUS_LABEL_KEYS,
  type SubagentStatusBucket,
} from "@/subagents/status";
import { SubagentStatusDot } from "@/subagents/status-dot";
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

interface WorkerStatus {
  label: string;
  bucket: SubagentStatusBucket | "inactive";
}

/**
 * The worker's state in the words and colors the track and sidebar use for the same child
 * (`@/subagents/status`). Offline and archived are not states of the child, so they get their own
 * labels and the inactive dot; an unknown worker shows no state rather than a guess.
 */
function useWorkerStatus(agent: Agent | undefined, connected: boolean): WorkerStatus | null {
  const { t } = useTranslation();
  if (!agent) return null;
  if (!connected) return { label: t("common.connectionStatus.offline"), bucket: "inactive" };
  if (agent.archivedAt) return { label: t("agentList.badges.archived"), bucket: "inactive" };
  const bucket = managedSubagentStatusBucket(agent);
  return { label: t(SUBAGENT_STATUS_LABEL_KEYS[bucket]), bucket };
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
  const connected = useHostRuntimeIsConnected(source.serverId);
  const { entries } = useProvidersSnapshot(source.serverId);
  const toggleDetails = useCallback(() => setDetailsOpen((open) => !open), []);
  const openAgent = useCallback(
    () => navigateToAgent({ serverId: source.serverId, agentId: worker.id }),
    [source.serverId, worker.id],
  );
  const status = useWorkerStatus(agent, connected);
  if (!matchesWorker(agent, delegation)) return children;
  const provider = agent?.provider ?? worker.provider;
  const { providerLabel, modelLabel } = workerLabels(
    entries,
    provider,
    agent ? agent.model : worker.model,
  );
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
  status: WorkerStatus | null;
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
  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityLabel={status ? `Open agent: ${title}. ${status.label}` : `Open agent: ${title}`}
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
      {status ? (
        <View style={styles.status}>
          <SubagentStatusDot
            bucket={status.bucket}
            testID={`pimi-delegation-status-${status.bucket}`}
          />
          <Text style={styles.statusText} accessibilityLiveRegion="polite">
            {status.label}
          </Text>
        </View>
      ) : null}
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
  details: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
}));
