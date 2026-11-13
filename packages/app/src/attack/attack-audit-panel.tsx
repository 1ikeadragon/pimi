import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useTranslation } from "@/i18n/use-translation";
import { ChevronDown } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AttackAuditEntry, AttackRun } from "@pimi/protocol/attack/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/contexts/toast-context";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { toErrorMessage } from "@/utils/error-messages";
import type { AttackRunAgent } from "./use-attack-run-agents";

// The daemon returns its newest 200 entries. A change in the run's findings or status refetches
// at once; while the tab is open on a live run it also refetches every few seconds, because a
// refused navigation changes nothing the app already watches.
const AUDIT_REFRESH_MS = 5000;

/**
 * The run's audit log from the daemon. Fetched whenever `changeKey` changes (the findings pane
 * passes a key built from the run status and its findings) and, while `watch` is set, on a
 * timer. Entries are kept per run so switching runs never shows another run's log.
 */
export function useAttackAudit(input: {
  serverId: string;
  runId: string | null;
  changeKey: string;
  watch: boolean;
}): { entries: AttackAuditEntry[]; error: string | null } {
  const { serverId, runId, changeKey, watch } = input;
  const client = useHostRuntimeClient(serverId);
  const [state, setState] = useState<{
    runId: string;
    entries: AttackAuditEntry[];
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!client || !runId) return;
    let cancelled = false;
    const load = () => {
      client
        .attackRunGet({ runId })
        .then((payload) => {
          if (!cancelled) setState({ runId, entries: payload.audit, error: null });
          return payload;
        })
        .catch((caught: unknown) => {
          if (!cancelled) {
            setState((current) => ({
              runId,
              entries: current?.runId === runId ? current.entries : [],
              error: toErrorMessage(caught),
            }));
          }
        });
    };
    load();
    if (!watch) return () => void (cancelled = true);
    const timer = setInterval(load, AUDIT_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, runId, changeKey, watch]);
  if (state && state.runId === runId) return { entries: state.entries, error: state.error };
  return { entries: [], error: null };
}

const FINDING_ID = /\b[0-9a-f]{32}\b/g;

function shortDetail(detail: string | null): string {
  return detail ? detail.replace(FINDING_ID, (id) => id.slice(0, 8)) : "";
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

function formatTime(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return date.toLocaleTimeString([], { hour12: false });
}

export function AttackAuditPanel({
  run,
  entries,
  error,
  agents,
}: {
  run: AttackRun;
  entries: AttackAuditEntry[];
  error: string | null;
  agents: AttackRunAgent[];
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [filter, setFilter] = useState<string | null>(null);
  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of agents) map.set(item.agent.id, item.role);
    return map;
  }, [agents]);
  useEffect(() => setFilter(null), [run.id]);

  const actions = useMemo(() => [...new Set(entries.map((entry) => entry.action))], [entries]);
  const visible = useMemo(() => {
    const seen = new Map<string, number>();
    const shown = filter ? entries.filter((entry) => entry.action === filter) : entries;
    return shown.map((entry) => {
      const base = `${entry.at}|${entry.action}|${entry.agentId ?? ""}|${entry.detail ?? ""}`;
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      return { entry, key: `${base}|${count}` };
    });
  }, [entries, filter]);
  const onCopy = useCallback(() => {
    const text = visible.map((row) => JSON.stringify(row.entry)).join("\n");
    Clipboard.setStringAsync(text).then(
      () => toast.copied(),
      (caught: unknown) => toast.error(toErrorMessage(caught)),
    );
  }, [toast, visible]);

  const spend = useMemo(() => {
    const rows = Object.entries(run.spentByAgent)
      .map(([agentId, tokens]) => ({
        agentId,
        tokens,
        label: names.get(agentId) ?? agentId.slice(0, 8),
      }))
      .sort((a, b) => b.tokens - a.tokens);
    const known = rows.reduce((sum, row) => sum + row.tokens, 0);
    return { rows, other: Math.max(0, run.spent.tokens - known) };
  }, [names, run.spent.tokens, run.spentByAgent]);

  const filterLabel = filter ? t(`attack.findings.audit.actions.${filter}`) : null;
  return (
    <ScrollView contentContainerStyle={styles.content} testID="attack-audit-panel">
      <View style={styles.section} testID="attack-audit-spend">
        <Text style={styles.sectionTitle}>
          {t("attack.findings.audit.spend")} · {formatTokens(run.spent.tokens)}
        </Text>
        {spend.rows.length === 0 ? (
          <Text style={styles.muted}>{t("attack.findings.audit.spendEmpty")}</Text>
        ) : (
          <>
            {spend.rows.map((row) => (
              <View key={row.agentId} style={styles.spendRow}>
                <Text style={styles.spendLabel} numberOfLines={1}>
                  {row.label}
                </Text>
                <Text style={styles.spendValue}>{formatTokens(row.tokens)}</Text>
              </View>
            ))}
            {spend.other > 0 ? (
              <View style={styles.spendRow}>
                <Text style={styles.muted}>{t("attack.findings.audit.spendOther")}</Text>
                <Text style={styles.muted}>{formatTokens(spend.other)}</Text>
              </View>
            ) : null}
          </>
        )}
      </View>

      <View style={styles.toolbar}>
        <DropdownMenu>
          <DropdownMenuTrigger
            accessibilityLabel={t("attack.findings.audit.filterAll")}
            testID="attack-audit-filter"
          >
            <View style={styles.filterTrigger}>
              <Text style={styles.filterText} numberOfLines={1}>
                {filterLabel ?? t("attack.findings.audit.filterAll")}
              </Text>
              <ChevronDown size={12} color="gray" />
            </View>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" scrollable maxHeight={320}>
            <FilterItem
              label={t("attack.findings.audit.filterAll")}
              value={null}
              selected={filter === null}
              onPick={setFilter}
            />
            {actions.map((action) => (
              <FilterItem
                key={action}
                label={t(`attack.findings.audit.actions.${action}`)}
                value={action}
                selected={filter === action}
                onPick={setFilter}
              />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          size="sm"
          variant="ghost"
          onPress={onCopy}
          disabled={visible.length === 0}
          testID="attack-audit-copy"
        >
          {t("attack.findings.audit.copy")}
        </Button>
      </View>

      {entries.length === 0 ? (
        <Text style={styles.muted}>{t("attack.findings.audit.empty")}</Text>
      ) : null}
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      <View style={styles.list}>
        {visible.map(({ entry, key }) => (
          <View key={key} style={styles.entry} testID="attack-audit-entry">
            <Text style={styles.time}>{formatTime(entry.at)}</Text>
            <View style={styles.entryBody}>
              <Text style={styles.action} numberOfLines={1}>
                {t(`attack.findings.audit.actions.${entry.action}`)}
              </Text>
              <Text style={styles.detail} numberOfLines={2}>
                {[
                  entry.agentId
                    ? (names.get(entry.agentId) ?? entry.agentId.slice(0, 8))
                    : t("attack.findings.audit.owner"),
                  shortDetail(entry.detail),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            </View>
          </View>
        ))}
      </View>
      {entries.length > 0 ? (
        <Text style={styles.muted}>
          {t("attack.findings.audit.last", { count: entries.length })}
        </Text>
      ) : null}
    </ScrollView>
  );
}

function FilterItem({
  label,
  value,
  selected,
  onPick,
}: {
  label: string;
  value: string | null;
  selected: boolean;
  onPick: (value: string | null) => void;
}) {
  const onSelect = useCallback(() => onPick(value), [onPick, value]);
  return (
    <DropdownMenuItem selected={selected} showSelectedCheck onSelect={onSelect}>
      {label}
    </DropdownMenuItem>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { padding: theme.spacing[3], gap: theme.spacing[4] },
  section: { gap: theme.spacing[1] },
  sectionTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: "500",
  },
  spendRow: { flexDirection: "row", justifyContent: "space-between", gap: theme.spacing[2] },
  spendLabel: { flex: 1, color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  spendValue: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  toolbar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  filterTrigger: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  filterText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  list: { gap: theme.spacing[2] },
  entry: { flexDirection: "row", gap: theme.spacing[3] },
  time: {
    width: 64,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
  entryBody: { flex: 1, minWidth: 0 },
  action: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  detail: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  errorText: { color: theme.colors.palette.red[300], fontSize: theme.fontSize.sm },
}));
