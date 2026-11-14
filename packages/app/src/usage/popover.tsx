import { useCallback, useEffect, useRef, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "@/i18n/use-translation";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { MenuRoot, MenuSurface, useMenuContext } from "@/components/ui/menu";
import { openPimiUsage } from "@/navigation/pimi-usage";
import { builtinSidebarNavLabelKey } from "@/sidebar-nav/model";
import { useUsageDisplay } from "./display";
import { useUsageHostSelection } from "./hosts";
import { UsageWindowBar } from "./window-bar";
import { useHostUsage } from "./queries";
import { UsageBody, UsageMessage } from "./usage-section";
import { cacheShare, formatCostUsd, formatPercent, formatTokens } from "./overview/format";
import { useUsageRescan, useUsageSummaryQuery, type UsageSummary } from "./overview/queries";
import type { UsageReportEntry } from "./types";

const POPOVER_WIDTH = 360;
const NOOP = () => undefined;

/**
 * The Usage popover: plan limits, today's spend and a week sparkline, and a way into the full
 * screen. An anchored popover on wide layouts, a bottom sheet on compact ones. `children` renders
 * the trigger and receives the function that toggles the popover.
 */
export function UsagePopover({ children }: { children: (toggle: () => void) => ReactElement }) {
  const { t } = useTranslation();
  return (
    <MenuRoot compactMode="sheet">
      <UsagePopoverAnchor>{children}</UsagePopoverAnchor>
      <MenuSurface
        side="right"
        align="end"
        width={POPOVER_WIDTH}
        sheetTitle={t(builtinSidebarNavLabelKey("usage"))}
        testID="usage-popover"
      >
        <UsagePopoverBody />
      </MenuSurface>
    </MenuRoot>
  );
}

function UsagePopoverAnchor({
  children,
}: {
  children: (toggle: () => void) => ReactElement;
}): ReactElement {
  const ctx = useMenuContext("UsagePopover");
  const open = useRef(ctx.open);
  open.current = ctx.open;
  const toggle = () => {
    ctx.setOpen(!open.current);
  };
  return (
    <View ref={ctx.triggerRef} collapsable={false}>
      {children(toggle)}
    </View>
  );
}

function UsagePopoverBody(): ReactNode {
  const { t } = useTranslation();
  const { serverId } = useUsageHostSelection();
  if (!serverId) {
    return <UsageMessage text={t("providerUsage.noHosts")} />;
  }
  return <HostUsagePopoverBody key={serverId} serverId={serverId} />;
}

function HostUsagePopoverBody({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const ctx = useMenuContext("UsagePopover");
  const { view, refresh } = useHostUsage(serverId);
  const reports = view.kind === "ready" ? view.reports : [];
  const { display } = useUsageDisplay(reports);
  const { rescan } = useUsageRescan(serverId);
  useEffect(rescan, [rescan]);
  const { setOpen } = ctx;
  const openFull = useCallback(() => {
    setOpen(false);
    openPimiUsage();
  }, [setOpen]);
  return (
    <View style={styles.body} testID="usage-popover-body">
      {view.kind === "ready" && reports.length > 0 ? (
        <PopoverLimits reports={reports} displayAs={display.displayAs} />
      ) : (
        <UsageBody serverId={serverId} view={view} display={display} onRefresh={refresh} />
      )}
      <PopoverToday serverId={serverId} />
      <Button variant="outline" onPress={openFull} testID="usage-popover-open">
        {t("usageOverview.popover.openUsage")}
      </Button>
    </View>
  );
}

function PopoverLimits({
  reports,
  displayAs,
}: {
  reports: readonly UsageReportEntry[];
  displayAs: "used" | "remaining";
}) {
  return (
    <View style={styles.limits}>
      {reports.map((entry) =>
        entry.report.status === "available" ? (
          <View key={entry.id} style={styles.source}>
            <Text style={styles.sourceTitle}>
              {[entry.sourceLabel, entry.account.label, entry.report.planLabel]
                .filter(Boolean)
                .join(" · ")}
            </Text>
            {entry.report.windows.map((window) => (
              <UsageWindowBar
                key={window.id}
                window={window}
                displayAs={displayAs}
                pinnable={false}
                pinned={false}
                onTogglePin={NOOP}
                pinLabel=""
                pinTestID={`usage-popover-window-${window.id}`}
              />
            ))}
          </View>
        ) : null,
      )}
    </View>
  );
}

function PopoverToday({ serverId }: { serverId: string }) {
  const { t, i18n } = useTranslation();
  const query = useUsageSummaryQuery(serverId);
  const summary = query.data;
  // Hidden, not zero, while the host has no history or does not answer.
  if (!summary || summary.firstEventAt === null) return null;
  return <TodayBlock summary={summary} locale={i18n.resolvedLanguage} t={t} />;
}

function TodayBlock({
  summary,
  locale,
  t,
}: {
  summary: UsageSummary;
  locale: string | undefined;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const share = cacheShare(summary.today);
  const cost = formatCostUsd(summary.today, locale);
  const parts = [
    t("usageOverview.popover.tokens", { count: formatTokens(summary.today.total, locale) }),
    cost,
    share === null ? null : t("usageOverview.popover.cached", { percent: formatPercent(share) }),
  ].filter(Boolean);
  const peak = Math.max(1, ...summary.days.map((day) => day.total));
  return (
    <View style={styles.today} testID="usage-popover-today">
      <View style={styles.todayText}>
        <Text style={styles.todayLabel}>{t("usageOverview.popover.today")}</Text>
        <Text style={styles.todayValue} numberOfLines={2}>
          {parts.join(" · ")}
        </Text>
      </View>
      <View style={[styles.spark, summary.scanning && styles.sparkStale]}>
        {summary.days.map((day, index) => (
          <View
            key={day.day}
            style={[
              styles.sparkBar,
              index === summary.days.length - 1 && styles.sparkToday,
              { height: Math.max(2, Math.round((day.total / peak) * 28)) },
            ]}
          />
        ))}
      </View>
      <Text style={styles.todayLabel}>{t("usageOverview.popover.lastSevenDays")}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { padding: theme.spacing[3], gap: theme.spacing[3] },
  limits: { gap: theme.spacing[3] },
  source: { gap: theme.spacing[2] },
  sourceTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  today: { gap: theme.spacing[2] },
  todayText: { gap: theme.spacing[1] },
  todayLabel: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  todayValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontVariant: ["tabular-nums"],
  },
  spark: { flexDirection: "row", alignItems: "flex-end", gap: theme.spacing[1], height: 28 },
  sparkStale: { opacity: 0.5 },
  sparkBar: {
    flex: 1,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface4,
  },
  sparkToday: { backgroundColor: theme.colors.accent },
}));
