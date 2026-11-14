import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import {
  NETWORK_LOG_RETENTION_DAYS_DEFAULT,
  NETWORK_LOG_RETENTION_DAYS_MAX,
  NETWORK_LOG_RETENTION_DAYS_MIN,
  type NetworkActivityRequest,
  type NetworkActivitySnapshot,
  type ResourceDestination,
} from "@pimi/protocol/messages";
import { useTranslation } from "@/i18n/use-translation";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { SettingsCollapsibleRow } from "@/components/settings/collapsible-row";
import { Button } from "@/components/ui/button";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { getIsElectron } from "@/constants/platform";
import { useFetchQuery } from "@/data/query";
import { getDesktopHost } from "@/desktop/host";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useAppSettings } from "@/hooks/use-settings";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";
import { formatTimeAgo, formatTimeOfDay } from "@/utils/time";
import {
  buildDestinationView,
  buildProcessTree,
  destinationTarget,
  formatBytes,
  formatCpu,
  formatDuration,
  formatRequestTarget,
  mergeRequests,
  networkSourceLabel,
  repeatLabel,
  requestStatus,
  type ProcessNode,
} from "./resources-model";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);

const POLL_INTERVAL_MS = 2_000;
const FETCH_LIMIT = 300;
const REQUEST_PAGE = 50;
const LIMITS_URL = "https://github.com/1ikeadragon/pimi/blob/main/public-docs/resources.md";

export function ResourcesSection({ serverId }: { serverId: string | null }) {
  const { t } = useTranslation();
  if (!serverId) {
    return (
      <SettingsSection title={t("settings.resources.title")}>
        <SettingsCard>
          <View style={settingsStyles.row}>
            <Text style={settingsStyles.rowHint}>{t("settings.resources.noHost")}</Text>
          </View>
        </SettingsCard>
      </SettingsSection>
    );
  }
  return <ResourcesView serverId={serverId} />;
}

function useDesktopProcesses(enabled: boolean) {
  const bridge = getIsElectron() ? getDesktopHost()?.networkActivity : undefined;
  const active = enabled && Boolean(bridge);
  const query = useFetchQuery({
    dataShape: "value",
    queryKey: ["resources", "desktop-processes"] as const,
    queryFn: () => bridge!.processes(),
    enabled: active,
    staleTimeMs: 0,
    refetchInterval: active ? POLL_INTERVAL_MS : false,
    retry: false,
  });
  return active ? query.data : undefined;
}

function useDesktopRequests() {
  const bridge = getIsElectron() ? getDesktopHost()?.networkActivity : undefined;
  const enabled = Boolean(bridge);
  const query = useFetchQuery({
    dataShape: "value",
    queryKey: ["resources", "desktop-requests"] as const,
    queryFn: () => bridge!.list({ includeLocal: false, limit: FETCH_LIMIT }),
    enabled,
    staleTimeMs: 0,
    refetchInterval: enabled ? POLL_INTERVAL_MS : false,
    retry: false,
  });
  return enabled ? query.data : undefined;
}

function ResourcesView({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const localServerId = useLocalDaemonServerId();
  const enabled = Boolean(client) && connected;
  // The app's processes are only the daemon's to sample when both run on this machine.
  const desktop = useDesktopProcesses(localServerId === serverId);
  const appRootPid = desktop?.rootPid;
  const { settings, updateSettings } = useAppSettings();
  const resolveNames = settings.resolveNetworkNames;
  const query = useFetchQuery({
    dataShape: "value",
    queryKey: ["resources", "daemon", serverId, appRootPid ?? null] as const,
    queryFn: () => client!.getResourcesSnapshot({ limit: FETCH_LIMIT, appRootPid, resolveNames }),
    enabled,
    staleTimeMs: 0,
    refetchInterval: enabled ? POLL_INTERVAL_MS : false,
    retry: false,
  });
  const desktopRequests = useDesktopRequests();
  const snapshot = enabled ? query.data : undefined;
  const agents = useSessionStore((state) => state.sessions[serverId]?.agents);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const { refetch } = query;
  const toggleNames = useCallback(
    (value: boolean) => {
      updateSettings({ resolveNetworkNames: value }).catch((failure: unknown) => {
        setActionError(failure instanceof Error ? failure.message : String(failure));
      });
    },
    [updateSettings],
  );
  // Refetch after the render that carries the new value, so the request reads it.
  useEffect(() => {
    refetch();
  }, [resolveNames, refetch]);

  const appLabels = useMemo(
    () => new Map((desktop?.processes ?? []).map((entry) => [entry.pid, entry.label])),
    [desktop],
  );
  const agentTitle = useCallback(
    (agentId: string) => agents?.get(agentId)?.title ?? null,
    [agents],
  );
  const tree = useMemo(
    () =>
      buildProcessTree({
        processes: snapshot?.processes ?? [],
        appLabels,
        agentTitle,
        labels: {
          app: t("settings.resources.app"),
          daemon: t("settings.resources.daemon"),
          terminals: t("settings.resources.terminals"),
          supervisor: t("settings.resources.supervisor"),
          worker: t("settings.resources.worker"),
        },
      }),
    [snapshot?.processes, appLabels, agentTitle, t],
  );
  const view = useMemo(() => buildDestinationView(snapshot?.destinations ?? []), [snapshot]);
  const requests = useMemo(
    () => mergeRequests([snapshot?.requests, desktopRequests]),
    [snapshot?.requests, desktopRequests],
  );

  const updateBaseline = useCallback(
    (input: { action: "trust" | "untrust" | "reset"; key?: string }) => {
      if (!client) return;
      setActionError(null);
      setBusyKey(input.key ?? input.action);
      client
        .updateResourcesBaseline(input)
        .then(() => refetch())
        .catch((failure: unknown) => {
          setActionError(failure instanceof Error ? failure.message : String(failure));
        })
        .finally(() => setBusyKey(null));
    },
    [client, refetch],
  );

  const trust = useCallback(
    (key: string) => updateBaseline({ action: "trust", key }),
    [updateBaseline],
  );
  const untrust = useCallback(
    (key: string) => updateBaseline({ action: "untrust", key }),
    [updateBaseline],
  );
  const reset = useCallback(() => updateBaseline({ action: "reset" }), [updateBaseline]);

  const resetButton = useMemo(
    () => (
      <Button
        variant="ghost"
        onPress={reset}
        disabled={busyKey === "reset"}
        testID="resources-reset"
      >
        {t("settings.resources.reset")}
      </Button>
    ),
    [reset, busyKey, t],
  );
  const limitsLink = useMemo(
    () => ({
      href: LIMITS_URL,
      label: t("settings.resources.limits"),
      accessibilityLabel: t("settings.resources.limits"),
    }),
    [t],
  );

  if (!enabled) {
    return (
      <SettingsSection title={t("settings.resources.title")}>
        <SettingsCard>
          <View style={settingsStyles.row}>
            <Text style={settingsStyles.rowHint}>{t("settings.resources.offline")}</Text>
          </View>
        </SettingsCard>
      </SettingsSection>
    );
  }

  return (
    <View testID="resources">
      <SettingsSection title={t("settings.resources.processes")} testID="resources-processes">
        <SettingsCard>
          <ProcessHeader />
          {tree.length === 0 ? (
            <View style={settingsStyles.row}>
              <Text style={settingsStyles.rowHint}>
                {query.error ? query.error.message : t("settings.resources.loading")}
              </Text>
            </View>
          ) : (
            tree.map((node) => <ProcessRow key={node.id} node={node} depth={0} />)
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title={t("settings.resources.network")}
        link={limitsLink}
        trailing={resetButton}
        testID="resources-network"
      >
        <SettingsCard>
          <SettingsRow label={t("settings.resources.resolveNames")}>
            <Switch
              value={resolveNames}
              onValueChange={toggleNames}
              accessibilityLabel={t("settings.resources.resolveNames")}
              testID="resources-resolve-names"
            />
          </SettingsRow>
          <NewDestinations
            items={view.fresh}
            agentTitle={agentTitle}
            busyKey={busyKey}
            onTrust={trust}
          />
          <SettingsCollapsibleRow
            label={t("settings.resources.byProcess")}
            summary={String(view.byProcess.length)}
            testID="resources-by-process"
          >
            {view.byProcess.map((entry) => (
              <ProcessDestinations
                key={entry.program}
                program={entry.program}
                destinations={entry.destinations}
              />
            ))}
          </SettingsCollapsibleRow>
          <SettingsCollapsibleRow
            label={t("settings.resources.known")}
            summary={String(view.known.length)}
            testID="resources-known"
          >
            {view.known.map((entry) => (
              <KnownRow
                key={entry.key}
                entry={entry}
                busy={busyKey === entry.key}
                onUntrust={untrust}
              />
            ))}
          </SettingsCollapsibleRow>
          <SettingsCollapsibleRow
            label={t("settings.resources.requests")}
            summary={String(requests.length)}
            testID="resources-requests"
          >
            <RequestList requests={requests} />
          </SettingsCollapsibleRow>
        </SettingsCard>
        {actionError ? <Text style={settingsStyles.rowError}>{actionError}</Text> : null}
      </SettingsSection>

      <LogsSection serverId={serverId} log={snapshot?.requests.log ?? null} />
    </View>
  );
}

// ---- processes -------------------------------------------------------------------------

function ProcessHeader() {
  const { t } = useTranslation();
  return (
    <View style={[settingsStyles.row, styles.headerRow]}>
      <Text style={[styles.headerText, styles.nameColumn]}>{t("settings.resources.name")}</Text>
      <Text style={[styles.headerText, styles.cpuColumn]}>{t("settings.resources.cpu")}</Text>
      <Text style={[styles.headerText, styles.memoryColumn]}>{t("settings.resources.memory")}</Text>
      <Text style={[styles.headerText, styles.connectionsColumn]}>
        {t("settings.resources.connections")}
      </Text>
    </View>
  );
}

const ProcessRow = memo(function ProcessRow({ node, depth }: { node: ProcessNode; depth: number }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(depth < 2);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const hasChildren = node.children.length > 0;
  const accessibilityState = useMemo(
    () => (hasChildren ? { expanded } : undefined),
    [hasChildren, expanded],
  );
  const Chevron = expanded ? ThemedChevronDown : ThemedChevronRight;
  const indent = useMemo(() => ({ paddingLeft: depth * 16 }), [depth]);
  return (
    <View testID={`resources-process-${node.id}`}>
      <PressHighlight
        onPress={hasChildren ? toggle : undefined}
        accessibilityRole={hasChildren ? "button" : undefined}
        accessibilityState={accessibilityState}
        style={[settingsStyles.row, settingsStyles.rowBorder, styles.processRow]}
      >
        <View style={[styles.nameColumn, styles.nameRow, indent]}>
          <View style={styles.chevron}>
            {hasChildren ? <Chevron size={14} uniProps={mutedIconColorMapping} /> : null}
          </View>
          <Text style={settingsStyles.rowTitle} numberOfLines={1}>
            {node.label}
          </Text>
          {node.pid !== null ? <Text style={styles.pid}>{node.pid}</Text> : null}
          {node.newDestinations > 0 ? (
            <StatusBadge label={t("settings.resources.new")} variant="warning" />
          ) : null}
        </View>
        <Text style={[styles.number, styles.cpuColumn]}>{formatCpu(node.cpuPercent)}</Text>
        <Text style={[styles.number, styles.memoryColumn]}>{formatBytes(node.rssBytes)}</Text>
        <Text style={[styles.number, styles.connectionsColumn]}>{node.connections}</Text>
      </PressHighlight>
      {expanded
        ? node.children.map((child) => <ProcessRow key={child.id} node={child} depth={depth + 1} />)
        : null}
    </View>
  );
});

// ---- network ---------------------------------------------------------------------------

function NewDestinations({
  items,
  agentTitle,
  busyKey,
  onTrust,
}: {
  items: ResourceDestination[];
  agentTitle: (agentId: string) => string | null;
  busyKey: string | null;
  onTrust: (key: string) => void;
}) {
  const { t } = useTranslation();
  const now = new Date();
  return (
    <View testID="resources-new">
      <View style={[settingsStyles.row, styles.headerRow]}>
        <Text style={styles.headerText}>{t("settings.resources.new")}</Text>
      </View>
      {items.length === 0 ? (
        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <Text style={settingsStyles.rowHint}>{t("settings.resources.nothingNew")}</Text>
        </View>
      ) : (
        items.map((entry) => {
          const agent = entry.agentId ? agentTitle(entry.agentId) : null;
          return (
            <View
              key={entry.key}
              style={[settingsStyles.row, settingsStyles.rowBorder]}
              testID={`resources-new-${entry.key}`}
            >
              <View style={settingsStyles.rowContent}>
                <Text style={settingsStyles.rowTitle} numberOfLines={1}>
                  {entry.program} · {destinationTarget(entry)}
                </Text>
                <Text style={settingsStyles.rowHint} numberOfLines={1}>
                  {agent ? `${agent} · ` : ""}
                  {t("settings.resources.firstSeen", {
                    time: formatTimeAgo(new Date(entry.firstSeenMs), now),
                  })}
                </Text>
              </View>
              <View style={styles.badges}>
                <StatusBadge label={t("settings.resources.unknown")} variant="warning" />
                {entry.ipOnly ? (
                  <StatusBadge label={t("settings.resources.ipOnly")} variant="muted" />
                ) : null}
              </View>
              <TrustButton
                entryKey={entry.key}
                busy={busyKey === entry.key}
                label={t("settings.resources.trust")}
                onPress={onTrust}
              />
            </View>
          );
        })
      )}
    </View>
  );
}

function TrustButton({
  entryKey,
  busy,
  label,
  onPress,
}: {
  entryKey: string;
  busy: boolean;
  label: string;
  onPress: (key: string) => void;
}) {
  const press = useCallback(() => onPress(entryKey), [onPress, entryKey]);
  return (
    <Button variant="outline" onPress={press} disabled={busy}>
      {label}
    </Button>
  );
}

function ProcessDestinations({
  program,
  destinations,
}: {
  program: string;
  destinations: ResourceDestination[];
}) {
  return (
    <SettingsCollapsibleRow label={program} summary={String(destinations.length)}>
      {destinations.map((entry) => (
        <DestinationLine key={entry.key} entry={entry} />
      ))}
    </SettingsCollapsibleRow>
  );
}

function DestinationLine({ entry }: { entry: ResourceDestination }) {
  const { t } = useTranslation();
  return (
    <View style={settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {destinationTarget(entry)}
        </Text>
        <Text style={settingsStyles.rowHint} numberOfLines={1}>
          {entry.count}× · {formatTimeAgo(new Date(entry.lastSeenMs), new Date())}
        </Text>
      </View>
      {entry.known ? null : (
        <StatusBadge label={t("settings.resources.unknown")} variant="warning" />
      )}
      {entry.ipOnly ? <StatusBadge label={t("settings.resources.ipOnly")} variant="muted" /> : null}
    </View>
  );
}

function KnownRow({
  entry,
  busy,
  onUntrust,
}: {
  entry: ResourceDestination;
  busy: boolean;
  onUntrust: (key: string) => void;
}) {
  const { t } = useTranslation();
  const press = useCallback(() => onUntrust(entry.key), [onUntrust, entry.key]);
  return (
    <View style={settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {entry.program} · {destinationTarget(entry)}
        </Text>
        <Text style={settingsStyles.rowHint} numberOfLines={1}>
          {entry.count}× · {formatTimeAgo(new Date(entry.lastSeenMs), new Date())}
        </Text>
      </View>
      {entry.trusted ? (
        <Button variant="ghost" onPress={press} disabled={busy}>
          {t("settings.resources.untrust")}
        </Button>
      ) : null}
    </View>
  );
}

// ---- requests --------------------------------------------------------------------------

function RequestList({ requests }: { requests: NetworkActivityRequest[] }) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(REQUEST_PAGE);
  const more = useCallback(() => setVisible((count) => count + REQUEST_PAGE), []);
  if (requests.length === 0) {
    return (
      <View style={settingsStyles.row}>
        <Text style={settingsStyles.rowHint}>{t("settings.resources.nothingYet")}</Text>
      </View>
    );
  }
  return (
    <View>
      {requests.slice(0, visible).map((request) => (
        <RequestRow key={request.id} request={request} />
      ))}
      {requests.length > visible ? (
        <View style={styles.loadMore}>
          <Button variant="ghost" onPress={more}>
            {t("settings.resources.more")}
          </Button>
        </View>
      ) : null}
    </View>
  );
}

function RequestRow({ request }: { request: NetworkActivityRequest }) {
  const status = requestStatus(request);
  const parts = [
    formatTimeOfDay(new Date(request.startedAtMs)),
    formatDuration(request.durationMs),
    request.responseBytes ? formatBytes(request.responseBytes) : null,
    repeatLabel(request),
    request.program ?? networkSourceLabel(request.source),
    request.known ? request.purpose : null,
  ].filter((part): part is string => part !== null);
  return (
    <View style={settingsStyles.row} testID={`resources-request-${request.id}`}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          <Text style={styles.method}>{request.method} </Text>
          {formatRequestTarget(request)}
        </Text>
        <Text style={settingsStyles.rowHint} numberOfLines={1}>
          {parts.join(" · ")}
        </Text>
      </View>
      <StatusBadge label={status.label} variant={status.tone} />
    </View>
  );
}

// ---- logs ------------------------------------------------------------------------------

function LogsSection({ serverId, log }: { serverId: string; log: NetworkActivitySnapshot["log"] }) {
  const { t } = useTranslation();
  const connected = useHostRuntimeIsConnected(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const localServerId = useLocalDaemonServerId();
  const openLogsFolder = getIsElectron()
    ? getDesktopHost()?.networkActivity?.openLogsFolder
    : undefined;
  const canOpenFolder = Boolean(openLogsFolder) && localServerId === serverId;
  const [error, setError] = useState<string | null>(null);

  const settings = config?.log?.network;
  const enabled = settings?.enabled !== false;
  const retentionDays = settings?.retentionDays ?? NETWORK_LOG_RETENTION_DAYS_DEFAULT;

  const update = useCallback(
    (network: { enabled?: boolean; retentionDays?: number }) => {
      setError(null);
      patchConfig({ log: { network } }).catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure));
      });
    },
    [patchConfig],
  );
  const toggleEnabled = useCallback((value: boolean) => update({ enabled: value }), [update]);
  const decrease = useCallback(
    () => update({ retentionDays: Math.max(NETWORK_LOG_RETENTION_DAYS_MIN, retentionDays - 1) }),
    [update, retentionDays],
  );
  const increase = useCallback(
    () => update({ retentionDays: Math.min(NETWORK_LOG_RETENTION_DAYS_MAX, retentionDays + 1) }),
    [update, retentionDays],
  );
  const openFolder = useCallback(() => {
    setError(null);
    openLogsFolder?.().catch((failure: unknown) => {
      setError(failure instanceof Error ? failure.message : String(failure));
    });
  }, [openLogsFolder]);

  if (!connected || !config) return null;

  return (
    <SettingsSection title={t("settings.resources.logs")} testID="resources-logs">
      <SettingsCard>
        <SettingsRow label={t("settings.resources.save")}>
          <Switch
            value={enabled}
            onValueChange={toggleEnabled}
            accessibilityLabel={t("settings.resources.save")}
          />
        </SettingsRow>
        <SettingsRow label={t("settings.resources.days")}>
          <View style={styles.stepper}>
            <Button
              variant="outline"
              onPress={decrease}
              disabled={retentionDays <= NETWORK_LOG_RETENTION_DAYS_MIN}
              accessibilityLabel={t("settings.resources.fewerDays")}
              testID="network-log-retention-decrease"
            >
              -
            </Button>
            <Text style={styles.stepperValue} testID="network-log-retention-value">
              {retentionDays}
            </Text>
            <Button
              variant="outline"
              onPress={increase}
              disabled={retentionDays >= NETWORK_LOG_RETENTION_DAYS_MAX}
              accessibilityLabel={t("settings.resources.moreDays")}
              testID="network-log-retention-increase"
            >
              +
            </Button>
          </View>
        </SettingsRow>
        <SettingsRow
          label={log ? formatBytes(log.bytes) : t("settings.resources.notSaving")}
          testID="network-log-size"
        >
          {canOpenFolder ? (
            <Button variant="outline" onPress={openFolder} testID="network-log-open-folder">
              {t("settings.resources.openFolder")}
            </Button>
          ) : null}
        </SettingsRow>
      </SettingsCard>
      {error ? <Text style={settingsStyles.rowError}>{error}</Text> : null}
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  headerRow: {
    paddingVertical: theme.spacing[2],
  },
  headerText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  processRow: {
    paddingVertical: theme.spacing[2],
  },
  nameColumn: {
    flex: 1,
    minWidth: 0,
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  cpuColumn: {
    width: 56,
    textAlign: "right",
  },
  memoryColumn: {
    width: 80,
    textAlign: "right",
  },
  connectionsColumn: {
    width: 44,
    textAlign: "right",
  },
  number: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  chevron: {
    width: 14,
    alignItems: "center",
  },
  pid: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  badges: {
    flexDirection: "row",
    gap: theme.spacing[1],
  },
  stepper: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  stepperValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    minWidth: 28,
    textAlign: "center",
  },
  method: {
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.medium,
  },
  loadMore: {
    alignItems: "center",
    paddingVertical: theme.spacing[2],
  },
}));
