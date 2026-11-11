import type { TFunction } from "i18next";
import { i18n } from "@/i18n/i18next";
import { usageCopy } from "./copy";
import type { UsageDisplayAs } from "./preferences";
import type { UsageReport, UsageReportEntry, UsageView, UsageWindow } from "./types";

export function usedPercent(window: UsageWindow): number | null {
  if (window.usedPct != null) return window.usedPct;
  if (window.remainingPct != null) return 100 - window.remainingPct;
  return null;
}

/** The percent a window shows under the user's used/remaining preference. */
export function displayPercent(window: UsageWindow, displayAs: UsageDisplayAs): number | null {
  if (displayAs === "used") return usedPercent(window);
  if (window.remainingPct != null) return window.remainingPct;
  const used = usedPercent(window);
  return used == null ? null : 100 - used;
}

/**
 * A window row's accessible label: what pinning it pins, then what the row shows. The row is a
 * checkbox, so its checked state says whether it is pinned: "Pin Claude Session, 31% · resets in
 * 2h", checked.
 */
export function usageWindowRowLabel(input: {
  pinLabel: string;
  value: string;
  trailing: string | null | undefined;
}): string {
  const summary = input.trailing ? `${input.value} · ${input.trailing}` : input.value;
  return `${input.pinLabel}, ${summary}`;
}

/** A user-requested refresh of one report. The previous report stays on screen throughout. */
export type UsageRefresh = "idle" | "pending" | "failed";

export function resolveUsageRefresh(mutation: {
  isPending: boolean;
  error: unknown;
}): UsageRefresh {
  if (mutation.isPending) return "pending";
  if (mutation.error) return "failed";
  return "idle";
}

/**
 * A host's report list with one report swapped for its refreshed copy, in place.
 * `null` means the daemon no longer knows the ID, so the report leaves the list.
 */
export function replaceReport(
  reports: readonly UsageReportEntry[],
  reportId: string,
  refreshed: UsageReportEntry | null,
): UsageReportEntry[] {
  if (!refreshed) return reports.filter((report) => report.id !== reportId);
  return reports.map((report) => (report.id === reportId ? refreshed : report));
}

/**
 * The later-fetched of two copies of one report. A list request's copies were fetched when it
 * started, so a Refresh that lands while it streams is newer than what the request still delivers.
 */
function laterFetched(shown: UsageReportEntry, arriving: UsageReportEntry): UsageReportEntry {
  return Date.parse(shown.fetchedAt) > Date.parse(arriving.fetchedAt) ? shown : arriving;
}

/**
 * A report list with one streamed report in place of its previous copy, or appended if new. A
 * copy fetched after the streamed one stays.
 */
export function upsertReport(
  reports: readonly UsageReportEntry[] | undefined,
  report: UsageReportEntry,
): UsageReportEntry[] {
  if (!reports?.some((entry) => entry.id === report.id)) return [...(reports ?? []), report];
  return reports.map((entry) => (entry.id === report.id ? laterFetched(entry, report) : entry));
}

/**
 * Keep displayed reports in place: the finished list is in fetch-completion order, which can
 * change on every refresh. Drop missing reports, append new ones, and keep newer fetched copies.
 */
export function settleReports(
  shown: readonly UsageReportEntry[] | undefined,
  finished: readonly UsageReportEntry[],
): UsageReportEntry[] {
  const remaining = new Map(finished.map((report) => [report.id, report]));
  const settled: UsageReportEntry[] = [];
  for (const report of shown ?? []) {
    const arriving = remaining.get(report.id);
    if (!arriving) {
      continue;
    }
    settled.push(laterFetched(report, arriving));
    remaining.delete(report.id);
  }
  return [...settled, ...remaining.values()];
}

export interface UsageQueryState {
  data: UsageReportEntry[] | undefined;
  error: unknown;
  isFetching: boolean;
}

export function resolveUsageView(
  input: {
    enabled?: boolean;
    hostLabel: string;
    isConnected: boolean;
    query: UsageQueryState | undefined;
  },
  t: TFunction = i18n.t,
): UsageView {
  const { hostLabel, isConnected, query } = input;
  if (!isConnected)
    return {
      kind: "unavailable",
      message: t("providerUsage.hostUnavailable", { host: hostLabel }),
    };
  if (input.enabled === false)
    return { kind: "off", message: t("providerUsage.off", { host: hostLabel }) };
  if (query?.data) {
    return { kind: "ready", reports: query.data, isRefreshing: query.isFetching };
  }
  if (query?.error) {
    return {
      kind: "error",
      message: query.error instanceof Error ? query.error.message : String(query.error),
    };
  }
  return { kind: "loading" };
}

/** What a meter popover shows of its agent's usage: nothing while the host cannot say. */
export type AgentUsageView =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; reports: UsageReportEntry[] };

export function resolveAgentUsageView(
  input: {
    canReport: boolean;
    query: UsageQueryState;
  },
  t: TFunction = i18n.t,
): AgentUsageView {
  const { canReport, query } = input;
  if (!canReport) return { kind: "none" };
  // A failed request keeps the reports from before it, or those that streamed in before it failed;
  // shown alone they would pass for the agent's complete, current usage.
  if (query.error) {
    const reason = query.error instanceof Error ? query.error.message : String(query.error);
    return { kind: "error", message: t("providerUsage.agentError", { reason }) };
  }
  if (query.data) {
    return query.data.length === 0 ? { kind: "none" } : { kind: "ready", reports: query.data };
  }
  return { kind: "loading" };
}

export interface UsageHost {
  serverId: string;
  label: string;
  isConnected: boolean;
}

/** Where usage looks for its host: the user's saved pick, then the workspace they are in. */
export interface UsageHostChoice {
  pickedServerId: string | null;
  activeServerId: string | null;
  hosts: readonly UsageHost[];
}

/**
 * The host the Usage row and modal read: the picked host, else the active workspace's host, else the
 * first host. Each only while it is connected.
 */
export function resolveUsageHostId(choice: UsageHostChoice): string | null {
  const reporting = choice.hosts.filter((host) => host.isConnected);
  const find = (serverId: string | null) => reporting.find((host) => host.serverId === serverId);
  return (
    (find(choice.pickedServerId) ?? find(choice.activeServerId) ?? reporting[0])?.serverId ?? null
  );
}

/** Current outcome owns messages; only a successful poll owns values and freshness. */
export function resolveUsageReport(entry: UsageReportEntry, t: TFunction) {
  const available = entry.report.status === "available";
  // A failed attempt is never a successful update.
  const snapshot = available ? null : (entry.lastSuccessful ?? null);
  const content = entry.report.status === "available" ? entry.report : (snapshot?.report ?? null);
  const messages: string[] = [];
  if (!available) {
    messages.push(
      ...(entry.loginErrors ?? []).map(
        (login) => `${login.harness}: ${usageProblemText(login.report, t)}`,
      ),
    );
  }
  return {
    windows: content?.windows ?? [],
    balances: content?.balances ?? [],
    details: content?.details ?? [],
    planLabel: content?.planLabel ?? null,
    // Only available entries carry successfulAt; failures show the retained snapshot's time.
    successfulAt: available
      ? (entry.successfulAt ?? entry.fetchedAt)
      : (snapshot?.fetchedAt ?? null),
    retained: snapshot !== null,
    messages,
  };
}

function usageProblemText(report: UsageReport, t: TFunction): string {
  if (report.status === "error") return report.error;
  if (report.status === "unavailable") return usageCopy.problem(report.problem, new Date(), t);
  return "";
}
