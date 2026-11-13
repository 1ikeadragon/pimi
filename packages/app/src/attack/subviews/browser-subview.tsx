import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Image, ScrollView, Text, View, type LayoutChangeEvent } from "react-native";
import { useTranslation } from "@/i18n/use-translation";
import { StyleSheet } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { getDesktopHost } from "@/desktop/host";
import type { BrowserRecord } from "@/desktop/browser/store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { FocusPanel } from "../attack-agent-focus";
import { useBrowserThumbnail } from "../use-browser-thumbnail";
import type { AttackSubviewProps } from "./types";

// Plan limits: one live stage (a resident webview is one DOM element, live in one place only),
// at most eight stills in the filmstrip, four of them refreshing. The capture queue itself keeps
// one capture in flight and pauses while the window is hidden.
const MAX_STILLS = 8;
const MAX_REFRESHING = 4;
const WIDE_WIDTH = 760;

interface Tab {
  record: BrowserRecord;
  agentId: string;
  role: string;
  working: boolean;
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}` || "/";
  } catch {
    return url || "about:blank";
  }
}

/** Browser ids the desktop webview guard has refused a navigation for, for the stage badge. */
function useRefusedBrowsers(runId: string): ReadonlySet<string> {
  const [refused, setRefused] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const subscription = getDesktopHost()?.events?.on?.("attack-navigation-refused", (payload) => {
      if (typeof payload !== "object" || payload === null) return;
      const event = payload as Record<string, unknown>;
      if (event.runId !== runId || typeof event.browserId !== "string") return;
      const browserId = event.browserId;
      setRefused((current) => (current.has(browserId) ? current : new Set(current).add(browserId)));
    });
    if (typeof subscription === "function") return subscription;
    return () => {
      void subscription?.then((dispose) => dispose());
    };
  }, [runId]);
  return refused;
}

export function BrowserSubview({ workspaceId, run, agents, live }: AttackSubviewProps) {
  const { t } = useTranslation();
  const [width, setWidth] = useState(1100);
  const [picked, setPicked] = useState<string | null>(null);
  const refused = useRefusedBrowsers(run.id);
  const tabs = useMemo<Tab[]>(
    () =>
      agents.flatMap((row) =>
        row.browsers.map((record) => ({
          record,
          agentId: row.agent.id,
          role: row.role,
          working: row.state === "working",
        })),
      ),
    [agents],
  );
  // The newest tab is staged until the owner picks another; a closed pick falls back to it.
  const newest = useMemo(
    () =>
      tabs.reduce<Tab | null>(
        (a, b) => (!a || b.record.createdAt > a.record.createdAt ? b : a),
        null,
      ),
    [tabs],
  );
  const staged = tabs.find((tab) => tab.record.browserId === picked) ?? newest;
  const stagedId = staged?.record.browserId ?? null;
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setWidth(event.nativeEvent.layout.width);
  }, []);
  const target = useMemo<WorkspaceTabTarget | null>(
    () => (stagedId ? { kind: "browser", browserId: stagedId } : null),
    [stagedId],
  );
  // The staged tab is the real webview, so it is never also a still. Working agents' tabs refresh
  // first; the rest are captured once.
  const strip = useMemo(() => {
    const rest = tabs.filter((tab) => tab.record.browserId !== stagedId);
    const stills = new Set(rest.slice(0, MAX_STILLS).map((tab) => tab.record.browserId));
    const refreshing = new Set(
      rest
        .filter((tab) => stills.has(tab.record.browserId) && tab.working)
        .slice(0, MAX_REFRESHING)
        .map((tab) => tab.record.browserId),
    );
    return { rest, stills, refreshing };
  }, [stagedId, tabs]);

  if (tabs.length === 0 || !staged || !target) {
    return (
      <View style={styles.empty} testID="attack-subview-browser">
        <Text style={styles.emptyText}>{t("attack.subviews.browser.empty")}</Text>
      </View>
    );
  }
  const wide = width >= WIDE_WIDTH;
  let lastAgent = "";
  return (
    <View style={styles.root} onLayout={onLayout} testID="attack-subview-browser">
      <View style={styles.bar}>
        <Text style={styles.owner} numberOfLines={1}>
          {staged.role}
        </Text>
        <Text style={styles.url} numberOfLines={1} testID="attack-browser-stage-url">
          {staged.record.url || "about:blank"}
        </Text>
        {refused.has(staged.record.browserId) ? (
          <View style={styles.refused} testID="attack-browser-refused">
            <Text style={styles.refusedText}>{t("attack.subviews.browser.refused")}</Text>
          </View>
        ) : null}
        <View style={styles.liveBadge}>
          <Text style={styles.liveText}>{t("attack.subviews.browser.live", { count: 1 })}</Text>
        </View>
      </View>
      <View style={[styles.body, wide ? styles.bodyWide : styles.bodyNarrow]}>
        <ScrollView
          horizontal={!wide}
          style={wide ? styles.stripWide : styles.stripNarrow}
          contentContainerStyle={wide ? styles.stripContentWide : styles.stripContentNarrow}
          testID="attack-browser-filmstrip"
        >
          {strip.rest.map((tab) => {
            const showRole = tab.agentId !== lastAgent;
            lastAgent = tab.agentId;
            return (
              <Still
                key={tab.record.browserId}
                tab={tab}
                workspaceId={workspaceId}
                showRole={showRole && wide}
                hasStill={strip.stills.has(tab.record.browserId)}
                refreshing={live && strip.refreshing.has(tab.record.browserId)}
                wide={wide}
                onPick={setPicked}
              />
            );
          })}
        </ScrollView>
        <View style={styles.stage}>
          <FocusPanel target={target} />
        </View>
      </View>
    </View>
  );
}

const Still = memo(function Still({
  tab,
  workspaceId,
  showRole,
  hasStill,
  refreshing,
  wide,
  onPick,
}: {
  tab: Tab;
  workspaceId: string;
  showRole: boolean;
  hasStill: boolean;
  refreshing: boolean;
  wide: boolean;
  onPick: (browserId: string) => void;
}) {
  const { t } = useTranslation();
  const { browserId, url, title } = tab.record;
  const still = useBrowserThumbnail(hasStill ? browserId : null, workspaceId, refreshing);
  const source = useMemo(() => (still ? { uri: still } : undefined), [still]);
  const press = useCallback(() => onPick(browserId), [browserId, onPick]);
  return (
    <View style={wide ? styles.cellWide : styles.cellNarrow}>
      {showRole ? (
        <Text style={styles.cellRole} numberOfLines={1}>
          {tab.role}
        </Text>
      ) : null}
      <PressHighlight
        onPress={press}
        style={styles.cell}
        accessibilityRole="button"
        accessibilityLabel={title || pathOf(url)}
        testID={`attack-browser-still-${browserId}`}
      >
        <View style={styles.stillFrame}>
          {source ? (
            <Image
              source={source}
              style={styles.stillImage}
              resizeMode="cover"
              accessibilityIgnoresInvertColors
            />
          ) : (
            <Text style={styles.noPreview}>{t("attack.subviews.browser.noPreview")}</Text>
          )}
        </View>
        <Text style={styles.cellPath} numberOfLines={1}>
          {pathOf(url)}
        </Text>
      </PressHighlight>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, minHeight: 0 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.spacing[6] },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
  },
  owner: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, fontWeight: "500" },
  url: { flex: 1, minWidth: 0, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  refused: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.palette.amber[500],
  },
  refusedText: { color: theme.colors.palette.amber[500], fontSize: theme.fontSize.sm },
  liveBadge: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  liveText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  body: { flex: 1, minHeight: 0 },
  bodyWide: { flexDirection: "row" },
  bodyNarrow: { flexDirection: "column" },
  stripWide: {
    width: 184,
    flexGrow: 0,
    borderRightWidth: 1,
    borderColor: theme.colors.border,
  },
  stripNarrow: { flexGrow: 0, borderBottomWidth: 1, borderColor: theme.colors.border },
  stripContentWide: { padding: theme.spacing[2], gap: theme.spacing[2] },
  stripContentNarrow: { padding: theme.spacing[2], gap: theme.spacing[2] },
  cellWide: { gap: theme.spacing[1] },
  cellNarrow: { width: 150, gap: theme.spacing[1] },
  cellRole: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, fontWeight: "500" },
  cell: { gap: theme.spacing[1] },
  stillFrame: {
    aspectRatio: 1.6,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    // A page assumes a white canvas; the still keeps its transparent background.
    backgroundColor: "#ffffff",
  },
  stillImage: { width: "100%", height: "100%" },
  noPreview: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  cellPath: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  stage: { flex: 1, minWidth: 0, minHeight: 0 },
}));
