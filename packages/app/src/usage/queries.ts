import { useTranslation } from "@/i18n/use-translation";
import { useCallback, useMemo } from "react";
import {
  skipToken,
  useMutation,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatuses,
  useHostRuntimeIsConnected,
  useHosts,
} from "@/runtime/host-runtime";
import { useAppSettings } from "@/hooks/use-settings";
import { useUsageSetting } from "./setting";
import { usageCopy } from "./copy";
import {
  replaceReport,
  resolveAgentUsageView,
  resolveUsageRefresh,
  resolveUsageView,
  settleReports,
  type UsageHost,
  type UsageQueryState,
  type AgentUsageView,
  type UsageRefresh,
  upsertReport,
} from "./model";
import type { UsageReportEntry, UsageView } from "./types";

// The daemon caches each report for five minutes, so re-reading it is cheap.
// An explicit refresh passes `forceRefresh` to bypass that cache.
const REPORTS_STALE_TIME_MS = 60_000;
const REPORTS_REFETCH_INTERVAL_MS = 5 * 60_000;

/** Every report list of a host: its own and each agent's. */
function hostUsageQueryKey(serverId: string) {
  return ["usage", serverId] as const;
}

function usageReportsQueryKey(serverId: string) {
  return [...hostUsageQueryKey(serverId), "reports"] as const;
}

function agentUsageQueryKey(serverId: string, agentId: string) {
  return [...hostUsageQueryKey(serverId), "agent", agentId] as const;
}

function requireClient(serverId: string) {
  const client = getHostRuntimeStore().getClient(serverId);
  if (!client) throw new Error(usageCopy.clientUnavailable);
  return client;
}

/**
 * Lists a host's reports, or one agent's, writing each into `queryKey` as it streams in so a slow
 * source never holds back the others. The finished list then replaces the streamed one, dropping
 * any report the host no longer has, but never a report refreshed while the list streamed.
 */
async function streamReports(input: {
  queryClient: QueryClient;
  queryKey: QueryKey;
  serverId: string;
  agentId?: string;
  forceRefresh?: boolean;
  /** Once aborted, reports still on their way are dropped instead of written. */
  signal?: AbortSignal;
}): Promise<UsageReportEntry[]> {
  const { queryClient, queryKey, serverId, agentId, forceRefresh = false, signal } = input;
  const { reports } = await requireClient(serverId).listUsageReports(
    { agentId, forceRefresh },
    (report) => {
      if (signal?.aborted) return;
      queryClient.setQueryData<UsageReportEntry[]>(queryKey, (current) =>
        upsertReport(current, report),
      );
    },
  );
  return settleReports(queryClient.getQueryData<UsageReportEntry[]>(queryKey), reports);
}

function listReports(
  queryClient: QueryClient,
  serverId: string,
  forceRefresh = false,
): Promise<UsageReportEntry[]> {
  return streamReports({
    queryClient,
    queryKey: usageReportsQueryKey(serverId),
    serverId,
    forceRefresh,
  });
}

async function getReport(
  serverId: string,
  reportId: string,
  forceRefresh = false,
  agentId?: string,
): Promise<UsageReportEntry | null> {
  return (
    (
      await requireClient(serverId).listUsageReports(
        agentId === undefined ? { reportIds: [reportId], forceRefresh } : { agentId, forceRefresh },
      )
    ).reports.find((report) => report.id === reportId) ?? null
  );
}

async function refreshReports(queryClient: QueryClient, serverId: string): Promise<void> {
  await queryClient.fetchQuery({
    queryKey: usageReportsQueryKey(serverId),
    queryFn: () => listReports(queryClient, serverId, true),
    staleTime: 0,
  });
}

function toQueryState(
  query: {
    data: UsageReportEntry[] | undefined;
    error: unknown;
    isFetching: boolean;
  },
  streamerMode: boolean,
): UsageQueryState {
  return {
    data: query.data && hideAccounts(query.data, streamerMode),
    error: query.error,
    isFetching: query.isFetching,
  };
}

// Streamer mode shows this in place of every provider account (usually an email).
const HIDDEN_ACCOUNT = "••••••";
const hiddenReports = new WeakMap<UsageReportEntry[], UsageReportEntry[]>();
const hiddenLabels = new WeakMap<ReadonlyMap<string, string>, ReadonlyMap<string, string>>();

function useStreamerMode(): boolean {
  return useAppSettings().settings.streamerMode;
}

/** The same reports with each account label masked; cached per list so identity stays stable. */
function hideAccounts(entries: UsageReportEntry[], streamerMode: boolean): UsageReportEntry[] {
  if (!streamerMode) return entries;
  let hidden = hiddenReports.get(entries);
  if (!hidden) {
    hidden = entries.map((entry) =>
      entry.account.label
        ? { ...entry, account: { ...entry.account, label: HIDDEN_ACCOUNT } }
        : entry,
    );
    hiddenReports.set(entries, hidden);
  }
  return hidden;
}

function hideAccountLabels(
  labels: ReadonlyMap<string, string>,
  streamerMode: boolean,
): ReadonlyMap<string, string> {
  if (!streamerMode) return labels;
  let hidden = hiddenLabels.get(labels);
  if (!hidden) {
    hidden = new Map([...labels.keys()].map((provider) => [provider, HIDDEN_ACCOUNT]));
    hiddenLabels.set(labels, hidden);
  }
  return hidden;
}

/** Usage reports for one host, as shown on its settings page. */
export function useHostUsage(serverId: string): { view: UsageView; refresh: () => void } {
  const setting = useUsageSetting(serverId);
  const streamerMode = useStreamerMode();
  const queryClient = useQueryClient();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const query = useFetchQuery({
    queryKey: usageReportsQueryKey(serverId),
    queryFn: () => listReports(queryClient, serverId),
    enabled: isConnected && setting.enabled,
    dataShape: "list",
    staleTimeMs: REPORTS_STALE_TIME_MS,
  });
  const refresh = useCallback(() => {
    void refreshReports(queryClient, serverId).catch(() => undefined);
  }, [queryClient, serverId]);
  const { t } = useTranslation();
  const hostLabel = useHosts().find((host) => host.serverId === serverId)?.label ?? serverId;
  const view = resolveUsageView(
    {
      hostLabel,
      enabled: setting.ready ? setting.enabled : undefined,
      isConnected,
      query: toQueryState(query, streamerMode),
    },
    t,
  );
  return { view, refresh };
}

const NO_PROVIDER_ACCOUNTS: ReadonlyMap<string, string> = new Map();

/**
 * The account each provider is signed into, by provider id, from the same sources as usage.
 * Empty while usage is off on the host or a provider's account cannot be identified.
 */
export function useProviderAccountLabels(serverId: string | null): ReadonlyMap<string, string> {
  const setting = useUsageSetting(serverId);
  const streamerMode = useStreamerMode();
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const query = useFetchQuery({
    queryKey: [...hostUsageQueryKey(serverId ?? ""), "provider-accounts"] as const,
    queryFn: async () => {
      const { accounts } = await requireClient(serverId ?? "").listUsageProviderAccounts();
      return new Map(accounts.map((account) => [account.provider, account.label]));
    },
    enabled: serverId !== null && isConnected && setting.enabled,
    dataShape: "value",
    staleTimeMs: REPORTS_STALE_TIME_MS,
  });
  return hideAccountLabels(query.data ?? NO_PROVIDER_ACCOUNTS, streamerMode);
}

const NO_REPORTS: UsageReportEntry[] = [];

interface UsageHostReportsInput {
  serverId: string | null;
  shouldPoll?: boolean;
}

/** A host's reports, with periodic refresh enabled only by the visible sidebar summary. */
export function useUsageHostReports({
  serverId,
  shouldPoll = false,
}: UsageHostReportsInput): UsageReportEntry[] {
  const setting = useUsageSetting(serverId);
  const streamerMode = useStreamerMode();
  const queryClient = useQueryClient();
  const query = useFetchQuery({
    enabled: setting.enabled,
    queryKey: usageReportsQueryKey(serverId ?? ""),
    queryFn: serverId ? () => listReports(queryClient, serverId) : skipToken,
    dataShape: "list",
    staleTimeMs: REPORTS_STALE_TIME_MS,
    refetchInterval: shouldPoll ? REPORTS_REFETCH_INTERVAL_MS : false,
  });
  return setting.enabled ? hideAccounts(query.data ?? NO_REPORTS, streamerMode) : NO_REPORTS;
}

/**
 * The reports of the account an agent runs under, as its meter's tooltip or sheet shows them.
 * Fetched while either is mounted, so only while it is open.
 */
export function useAgentUsage(serverId: string, agentId: string): AgentUsageView {
  const queryClient = useQueryClient();
  const canReport = useHostReportsUsage(serverId);
  const streamerMode = useStreamerMode();
  const queryKey = agentUsageQueryKey(serverId, agentId);
  const query = useFetchQuery({
    queryKey,
    // Consuming the signal cancels the request when the details close, so a reopen sends a new
    // request instead of joining one scoped to the login the agent ran under before.
    queryFn: ({ signal }) => streamReports({ queryClient, queryKey, serverId, agentId, signal }),
    enabled: canReport,
    // Another agent's reports never stand in while this one's load.
    dataShape: "value",
    // Dropped as soon as the details close: an agent resumed under another login keeps its ID, so
    // reports kept from an earlier open could show the old login. The daemon's cache keeps each
    // open's request cheap.
    gcTime: 0,
    // The daemon's errors (an unknown agent) do not heal on retry, and reopening the details
    // fetches again; retrying would hold the loading sentence for seconds instead.
    retry: false,
    staleTimeMs: REPORTS_STALE_TIME_MS,
  });
  const { t } = useTranslation();
  return resolveAgentUsageView({ canReport, query: toQueryState(query, streamerMode) }, t);
}

/** Whether a host is connected and reports usage, read without fetching anything. */
export function useHostReportsUsage(serverId: string): boolean {
  const isConnected = useHostRuntimeIsConnected(serverId);
  const setting = useUsageSetting(serverId);
  return isConnected && setting.enabled;
}

/** Every host with whether it is connected and reports usage, in host order. */
export function useUsageHosts(): UsageHost[] {
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);
  return useMemo(
    () =>
      hosts.map((host) => ({
        serverId: host.serverId,
        label: host.label,
        isConnected: connectionStatuses.get(host.serverId) === "online",
      })),
    [connectionStatuses, hosts],
  );
}

/**
 * Refreshes a host report, or the agent's session reports. The result replaces the card
 * in the requesting view. Host and agent views can use different logins of the same account.
 */
export function useReportRefresh(
  serverId: string,
  reportId: string,
  agentId?: string,
): { refresh: () => void; refreshState: UsageRefresh } {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => getReport(serverId, reportId, true, agentId),
    onSuccess: (report) => {
      queryClient.setQueryData<UsageReportEntry[]>(
        agentId === undefined
          ? usageReportsQueryKey(serverId)
          : agentUsageQueryKey(serverId, agentId),
        (reports) => (reports ? replaceReport(reports, reportId, report) : reports),
      );
    },
  });
  const { mutate } = mutation;
  const refresh = useCallback(() => mutate(), [mutate]);
  return { refresh, refreshState: resolveUsageRefresh(mutation) };
}
