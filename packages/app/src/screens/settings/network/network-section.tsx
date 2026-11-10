import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type {
  NetworkActivityHost,
  NetworkActivityRequest,
  NetworkActivitySnapshot,
} from "@pimi/protocol/messages";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { SettingsGroup } from "@/components/settings/headings/settings-group";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { getIsElectron } from "@/constants/platform";
import { useFetchQuery } from "@/data/query";
import { getDesktopHost } from "@/desktop/host";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { formatTimeAgo, formatTimeOfDay } from "@/utils/time";
import {
  buildNetworkView,
  formatBytes,
  formatDuration,
  formatRequestTarget,
  networkSourceLabel,
  requestStatus,
  type NetworkFilter,
  type NetworkSource,
} from "./network-model";

const POLL_INTERVAL_MS = 2_000;
const FETCH_LIMIT = 300;
const REQUEST_PAGE = 50;

type FetchState =
  | { status: "unavailable"; message: string }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready" };

function queryState(input: {
  enabled: boolean;
  unavailableMessage: string;
  isPending: boolean;
  error: Error | null;
}): FetchState {
  if (!input.enabled) return { status: "unavailable", message: input.unavailableMessage };
  if (input.error) return { status: "error", message: input.error.message };
  if (input.isPending) return { status: "loading" };
  return { status: "ready" };
}

function useDaemonNetworkActivity(serverId: string, includeLocal: boolean) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  // COMPAT(networkActivity): added in v0.17.18, remove gate after 2027-05-11.
  const supported = useHostFeature(serverId, "networkActivity");
  const enabled = Boolean(client) && connected && supported;
  const query = useFetchQuery({
    dataShape: "value",
    queryKey: ["network-activity", "daemon", serverId, includeLocal] as const,
    queryFn: () => client!.listNetworkActivity({ includeLocal, limit: FETCH_LIMIT }),
    enabled,
    staleTimeMs: 0,
    refetchInterval: enabled ? POLL_INTERVAL_MS : false,
    retry: false,
  });
  let unavailableMessage = "Update the host to see network activity";
  if (!connected || !client) unavailableMessage = "Host is offline";
  return {
    snapshot: enabled ? query.data : undefined,
    state: queryState({
      enabled,
      unavailableMessage,
      isPending: query.isPending,
      error: query.error,
    }),
    supported,
  };
}

function useDesktopNetworkActivity(includeLocal: boolean) {
  const bridge = getIsElectron() ? getDesktopHost()?.networkActivity : undefined;
  const enabled = Boolean(bridge);
  const query = useFetchQuery({
    dataShape: "value",
    queryKey: ["network-activity", "desktop", includeLocal] as const,
    queryFn: () => bridge!.list({ includeLocal, limit: FETCH_LIMIT }),
    enabled,
    staleTimeMs: 0,
    refetchInterval: enabled ? POLL_INTERVAL_MS : false,
    retry: false,
  });
  return {
    available: enabled,
    snapshot: enabled ? query.data : undefined,
    state: queryState({
      enabled,
      unavailableMessage: "Update the desktop app to see its network activity",
      isPending: query.isPending,
      error: query.error,
    }),
  };
}

export function NetworkSection({ serverId }: { serverId: string | null }) {
  if (!serverId) {
    return (
      <SettingsSection title="Network">
        <View style={settingsStyles.card}>
          <View style={settingsStyles.row}>
            <Text style={settingsStyles.rowHint}>Add a host to see network activity</Text>
          </View>
        </View>
      </SettingsSection>
    );
  }
  return <NetworkActivityView serverId={serverId} />;
}

function NetworkActivityView({ serverId }: { serverId: string }) {
  const isElectron = getIsElectron();
  const hosts = useHosts();
  const hostLabel = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
  const [query, setQuery] = useState("");
  const [showLocal, setShowLocal] = useState(false);
  const [sources, setSources] = useState<Record<NetworkSource, boolean>>({
    daemon: true,
    app: true,
    browser: true,
  });
  const [visibleRequests, setVisibleRequests] = useState(REQUEST_PAGE);

  const daemon = useDaemonNetworkActivity(serverId, showLocal);
  const desktop = useDesktopNetworkActivity(showLocal);

  const filter = useMemo<NetworkFilter>(
    () => ({ query, showLocal, sources }),
    [query, showLocal, sources],
  );
  const snapshots = useMemo<(NetworkActivitySnapshot | undefined)[]>(
    () => [daemon.snapshot, desktop.snapshot],
    [daemon.snapshot, desktop.snapshot],
  );
  const view = useMemo(() => buildNetworkView({ snapshots, filter }), [snapshots, filter]);
  const now = new Date();

  const toggleSource = useCallback((source: NetworkSource, value: boolean) => {
    setSources((current) => ({ ...current, [source]: value }));
  }, []);
  const toggleDaemon = useCallback(
    (value: boolean) => toggleSource("daemon", value),
    [toggleSource],
  );
  const toggleApp = useCallback((value: boolean) => toggleSource("app", value), [toggleSource]);
  const toggleBrowser = useCallback(
    (value: boolean) => toggleSource("browser", value),
    [toggleSource],
  );
  const showMore = useCallback(() => setVisibleRequests((count) => count + REQUEST_PAGE), []);

  const capturedSince = daemon.snapshot?.capturedSinceMs;

  return (
    <View testID="network-activity">
      <SettingsSection
        title="Overview"
        info="Outbound HTTP, HTTPS, and WebSocket requests made by Pimi itself. Only the method, host, port, and path are kept, never query strings, headers, or bodies. Records live in memory and reset when the daemon or app restarts."
      >
        <View style={settingsStyles.card}>
          <View style={styles.summary} testID="network-summary">
            <SummaryStat label="Requests" value={view.totals.requests} />
            <SummaryStat label="Hosts" value={view.totals.hosts} />
            <SummaryStat label="Errors" value={view.totals.errors} tone="error" />
            <SummaryStat label="Unknown hosts" value={view.totals.unknownHosts} tone="warning" />
          </View>
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle} numberOfLines={1}>
                {hostLabel}
              </Text>
              <Text style={settingsStyles.rowHint}>
                {daemonSummaryHint(daemon.state, capturedSince, now)}
                {view.totals.hiddenLocalRequests > 0
                  ? ` · ${view.totals.hiddenLocalRequests} local requests hidden`
                  : ""}
              </Text>
            </View>
          </View>
          <View
            style={[settingsStyles.row, settingsStyles.rowBorder]}
            testID="network-not-captured"
          >
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>Not captured</Text>
              <Text style={settingsStyles.rowHint}>
                Agent providers such as Claude Code, Codex, and OpenCode run as separate processes,
                as do plugins and terminals. Their network traffic does not appear here.
              </Text>
            </View>
          </View>
        </View>
      </SettingsSection>

      <SettingsSection title="Filters">
        <View style={settingsStyles.card}>
          <View style={settingsStyles.row}>
            <View style={styles.searchSlot}>
              <SearchField
                value={query}
                onChangeText={setQuery}
                placeholder="Filter by host, path, or purpose"
                clearAccessibilityLabel="Clear filter"
                testID="network-filter"
              />
            </View>
          </View>
          <ToggleRow label="Daemon" value={sources.daemon} onValueChange={toggleDaemon} />
          {isElectron ? (
            <>
              <ToggleRow label="App" value={sources.app} onValueChange={toggleApp} />
              <ToggleRow
                label="In-app browser"
                value={sources.browser}
                onValueChange={toggleBrowser}
              />
            </>
          ) : null}
          <ToggleRow
            label="Show local"
            hint="Requests to this machine, such as the app talking to its own daemon"
            value={showLocal}
            onValueChange={setShowLocal}
          />
        </View>
      </SettingsSection>

      {daemon.state.status === "unavailable" && sources.daemon ? (
        <View style={styles.alert}>
          <Alert
            variant="warning"
            title={daemon.state.message}
            description={
              daemon.supported
                ? "Daemon requests appear once the host reconnects."
                : "This host's daemon predates network activity recording."
            }
            testID="network-daemon-unavailable"
          />
        </View>
      ) : null}
      {daemon.state.status === "error" ? (
        <Text style={settingsStyles.rowError}>{daemon.state.message}</Text>
      ) : null}
      {isElectron && desktop.state.status === "unavailable" ? (
        <Text style={settingsStyles.rowHint}>{desktop.state.message}</Text>
      ) : null}

      <SettingsGroup title="Hosts" testID="network-hosts">
        {view.groups.length === 0 ? (
          <SettingsSection title="All hosts">
            <View style={settingsStyles.card}>
              <View style={settingsStyles.row}>
                <Text style={settingsStyles.rowHint}>No requests yet</Text>
              </View>
            </View>
          </SettingsSection>
        ) : (
          view.groups.map((group) => (
            <SettingsSection key={group.purpose} title={`${group.purpose} · ${group.count}`}>
              <View style={settingsStyles.card}>
                {group.hosts.map((host, index) => (
                  <HostRow
                    key={`${host.source}:${host.host}`}
                    host={host}
                    first={index === 0}
                    now={now}
                  />
                ))}
              </View>
            </SettingsSection>
          ))
        )}
      </SettingsGroup>

      <SettingsSection title="Recent requests" testID="network-requests">
        <View style={settingsStyles.card}>
          {view.requests.length === 0 ? (
            <View style={settingsStyles.row}>
              <Text style={settingsStyles.rowHint}>No requests yet</Text>
            </View>
          ) : (
            view.requests
              .slice(0, visibleRequests)
              .map((request, index) => (
                <RequestRow key={request.id} request={request} first={index === 0} />
              ))
          )}
        </View>
        {view.requests.length > visibleRequests ? (
          <View style={styles.loadMore}>
            <Button variant="ghost" onPress={showMore}>
              Load more
            </Button>
          </View>
        ) : null}
      </SettingsSection>
    </View>
  );
}

function daemonSummaryHint(state: FetchState, capturedSinceMs: number | undefined, now: Date) {
  if (state.status === "unavailable") return state.message;
  if (state.status === "loading") return "Loading...";
  if (state.status === "error") return "Unable to load daemon network activity";
  if (capturedSinceMs === undefined) return "Recording";
  return `Recording since daemon start, ${formatTimeAgo(new Date(capturedSinceMs), now)}`;
}

function SummaryStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "warning" | "error";
}) {
  let valueStyle = styles.statValue;
  if (value > 0 && tone === "warning") valueStyle = styles.statValueWarning;
  if (value > 0 && tone === "error") valueStyle = styles.statValueError;
  return (
    <View style={styles.stat}>
      <Text style={valueStyle}>{value.toLocaleString()}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function ToggleRow({
  label,
  hint,
  value,
  onValueChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
}) {
  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{label}</Text>
        {hint ? <Text style={settingsStyles.rowHint}>{hint}</Text> : null}
      </View>
      <Switch value={value} onValueChange={onValueChange} accessibilityLabel={label} />
    </View>
  );
}

function HostRow({ host, first, now }: { host: NetworkActivityHost; first: boolean; now: Date }) {
  const parts = [
    `${host.count} ${host.count === 1 ? "request" : "requests"}`,
    host.errors > 0 ? `${host.errors} ${host.errors === 1 ? "error" : "errors"}` : null,
    host.bytes > 0 ? formatBytes(host.bytes) : null,
    networkSourceLabel(host.source),
    formatTimeAgo(new Date(host.lastSeenMs), now),
  ].filter((part): part is string => part !== null);
  return (
    <View
      style={[settingsStyles.row, !first && settingsStyles.rowBorder]}
      testID={`network-host-${host.host}`}
    >
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {host.host || "unix socket"}
        </Text>
        <Text style={settingsStyles.rowHint} numberOfLines={1}>
          {parts.join(" · ")}
        </Text>
      </View>
      <StatusBadge
        label={host.known ? host.purpose : "Unknown host"}
        variant={host.known ? "muted" : "warning"}
      />
    </View>
  );
}

function RequestRow({ request, first }: { request: NetworkActivityRequest; first: boolean }) {
  const status = requestStatus(request);
  const duration = formatDuration(request.durationMs);
  const parts = [
    formatTimeOfDay(new Date(request.startedAtMs)),
    duration,
    request.responseBytes ? formatBytes(request.responseBytes) : null,
    networkSourceLabel(request.source),
    request.known ? request.purpose : null,
  ].filter((part): part is string => part !== null);
  return (
    <View
      style={[settingsStyles.row, !first && settingsStyles.rowBorder]}
      testID={`network-request-${request.id}`}
    >
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          <Text style={styles.method}>{request.method} </Text>
          {formatRequestTarget(request)}
        </Text>
        <Text style={settingsStyles.rowHint} numberOfLines={1}>
          {request.known ? null : <Text style={styles.unknown}>Unknown host · </Text>}
          {parts.join(" · ")}
        </Text>
      </View>
      <StatusBadge label={status.label} variant={status.tone} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  summary: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    rowGap: theme.spacing[4],
  },
  stat: {
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 96,
  },
  statValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
  },
  statValueWarning: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.lg,
  },
  statValueError: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.lg,
  },
  statLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
  searchSlot: {
    flex: 1,
  },
  method: {
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.medium,
  },
  unknown: {
    color: theme.colors.statusWarning,
  },
  alert: {
    marginBottom: theme.spacing[6],
  },
  loadMore: {
    alignItems: "center",
    marginTop: theme.spacing[2],
  },
}));
