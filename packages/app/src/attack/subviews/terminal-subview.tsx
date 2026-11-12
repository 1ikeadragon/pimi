import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View, type LayoutChangeEvent } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { DensityIcon } from "@/components/ui/density-icon";
import { PressHighlight } from "@/components/ui/press-highlight";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { TerminalPane } from "@/components/terminal-pane";
import { usePaneContext } from "@/panels/pane-context";
import { useAttackRunTerminals, type AttackRunTerminal } from "../use-attack-run-terminals";
import { useAttackShellFeed } from "../use-attack-shell-feed";
import type { AttackRunAgent } from "../use-attack-run-agents";
import type { AttackSubviewProps } from "./types";

type Mode = "feed" | "live";
const ALL = "all";
// Plan limits: four panes a page, two live xterm panes mounted at once.
const MAX_LIVE = 2;
const WIDE_WIDTH = 700;
const noop = () => {};

function columnsFor(width: number): { columns: number; pageSize: number } {
  return width >= WIDE_WIDTH ? { columns: 2, pageSize: 4 } : { columns: 1, pageSize: 3 };
}

export function TerminalSubview({ serverId, workspaceId, agents }: AttackSubviewProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>("feed");
  const [filter, setFilter] = useState<string>(ALL);
  const [page, setPage] = useState(0);
  const [width, setWidth] = useState(1100);
  const [opened, setOpened] = useState<string[]>([]);
  const agentIds = useMemo(() => agents.map((row) => row.agent.id), [agents]);
  const { terminals, workspaceDirectory } = useAttackRunTerminals(serverId, workspaceId, agentIds);
  const activeFilter = filter === ALL || agentIds.includes(filter) ? filter : ALL;
  const roleById = useMemo(() => new Map(agents.map((row) => [row.agent.id, row.role])), [agents]);

  const feedAgents = useMemo(
    () => (activeFilter === ALL ? agents : agents.filter((row) => row.agent.id === activeFilter)),
    [activeFilter, agents],
  );
  const liveTerminals = useMemo(
    () =>
      activeFilter === ALL
        ? terminals
        : terminals.filter((terminal) => terminal.ownerAgentId === activeFilter),
    [activeFilter, terminals],
  );
  // The first terminals an agent opens go live on their own; the rest wait behind "Open live".
  useEffect(() => {
    if (opened.length === 0 && terminals.length > 0) {
      setOpened(terminals.slice(0, MAX_LIVE).map((terminal) => terminal.id));
    }
  }, [opened.length, terminals]);
  const openLive = useCallback((id: string) => {
    setOpened((current) => [...current.filter((entry) => entry !== id), id].slice(-MAX_LIVE));
  }, []);

  const { columns, pageSize } = columnsFor(width);
  const total = mode === "feed" ? feedAgents.length : liveTerminals.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(page, pages - 1);
  useEffect(() => {
    if (page !== current) setPage(current);
  }, [current, page]);
  const start = current * pageSize;
  const pageAgents = feedAgents.slice(start, start + pageSize);
  const pageTerminals = liveTerminals.slice(start, start + pageSize);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setWidth(event.nativeEvent.layout.width);
  }, []);
  const modeOptions = useMemo<SegmentedControlOption<Mode>[]>(
    () => [
      {
        value: "feed",
        label: t("attack.subviews.terminal.feed"),
        testID: "attack-terminal-mode-feed",
      },
      {
        value: "live",
        label: t("attack.subviews.terminal.live"),
        testID: "attack-terminal-mode-live",
      },
    ],
    [t],
  );
  const onFilter = useCallback((id: string) => {
    setFilter(id);
    setPage(0);
  }, []);
  const previous = useCallback(() => setPage(current - 1), [current]);
  const next = useCallback(() => setPage(current + 1), [current]);

  if (agents.length === 0 && terminals.length === 0) {
    return (
      <View style={styles.empty} testID="attack-subview-terminal">
        <Text style={styles.emptyText}>{t("attack.subviews.terminal.empty")}</Text>
      </View>
    );
  }
  const items = mode === "feed" ? pageAgents : pageTerminals;
  const rows = Math.ceil(items.length / columns);
  return (
    <View style={styles.root} onLayout={onLayout} testID="attack-subview-terminal">
      <View style={styles.bar}>
        <ScrollView horizontal style={styles.chips} contentContainerStyle={styles.chipsContent}>
          <FilterChip
            id={ALL}
            label={t("attack.subviews.terminal.filterAll")}
            active={activeFilter === ALL}
            onSelect={onFilter}
          />
          {agents.map((row) => (
            <FilterChip
              key={row.agent.id}
              id={row.agent.id}
              label={row.role}
              active={activeFilter === row.agent.id}
              onSelect={onFilter}
            />
          ))}
        </ScrollView>
        {pages > 1 ? (
          <View style={styles.pagination}>
            <ToolbarButton
              label={t("attack.grid.previous")}
              disabled={current === 0}
              onPress={previous}
            >
              <DensityIcon icon={ChevronLeft} size="sm" color="foregroundMuted" />
            </ToolbarButton>
            <Text style={styles.pageText}>
              {current + 1} / {pages}
            </Text>
            <ToolbarButton
              label={t("attack.grid.next")}
              disabled={current === pages - 1}
              onPress={next}
            >
              <DensityIcon icon={ChevronRight} size="sm" color="foregroundMuted" />
            </ToolbarButton>
          </View>
        ) : null}
        <SegmentedControl options={modeOptions} value={mode} onValueChange={setMode} size="sm" />
      </View>
      {items.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>{t("attack.subviews.terminal.empty")}</Text>
        </View>
      ) : (
        <View style={styles.grid}>
          {Array.from({ length: rows }, (_row, row) => (
            <View key={row} style={styles.row}>
              {mode === "feed"
                ? pageAgents
                    .slice(row * columns, (row + 1) * columns)
                    .map((item) => <FeedPane key={item.agent.id} serverId={serverId} row={item} />)
                : pageTerminals
                    .slice(row * columns, (row + 1) * columns)
                    .map((terminal) => (
                      <LivePane
                        key={terminal.id}
                        serverId={serverId}
                        cwd={workspaceDirectory}
                        terminal={terminal}
                        role={roleById.get(terminal.ownerAgentId) ?? ""}
                        mounted={opened.includes(terminal.id)}
                        onOpen={openLive}
                      />
                    ))}
              {row === rows - 1 && items.length % columns !== 0
                ? Array.from({ length: columns - (items.length % columns) }, (_slot, filler) => (
                    <View key={`filler-${filler}`} style={styles.filler} />
                  ))
                : null}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const FilterChip = memo(function FilterChip({
  id,
  label,
  active,
  onSelect,
}: {
  id: string;
  label: string;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  const press = useCallback(() => onSelect(id), [id, onSelect]);
  return (
    <PressHighlight
      onPress={press}
      style={[styles.chip, active && styles.chipActive]}
      testID={`attack-terminal-filter-${id}`}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>
        {label}
      </Text>
    </PressHighlight>
  );
});

const FeedPane = memo(function FeedPane({
  serverId,
  row,
}: {
  serverId: string;
  row: AttackRunAgent;
}) {
  const { t } = useTranslation();
  const feed = useAttackShellFeed(serverId, row.agent.id, true);
  return (
    <View style={styles.pane} testID={`attack-terminal-feed-${row.agent.id}`}>
      <View style={styles.paneHeader}>
        <Text style={styles.paneRole} numberOfLines={1}>
          {row.role}
        </Text>
        <Text style={styles.paneMeta}>bash</Text>
      </View>
      {feed.lines.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>{t("attack.subviews.terminal.noShell")}</Text>
        </View>
      ) : (
        // Lines sit against the bottom edge and the oldest fall off the top: a tail view with no
        // scroll state to maintain.
        <View style={styles.feed}>
          {feed.lines.map((line) => (
            <Text
              key={line.key}
              numberOfLines={1}
              style={[
                styles.line,
                line.kind === "command" && styles.lineCommand,
                line.kind === "status" && styles.lineStatus,
              ]}
            >
              {line.kind === "command" ? `$ ${line.text}` : line.text}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
});

const LivePane = memo(function LivePane({
  serverId,
  cwd,
  terminal,
  role,
  mounted,
  onOpen,
}: {
  serverId: string;
  cwd: string | null;
  terminal: AttackRunTerminal;
  role: string;
  mounted: boolean;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { openFileInWorkspace } = usePaneContext();
  const open = useCallback(() => onOpen(terminal.id), [onOpen, terminal.id]);
  return (
    <View style={styles.pane} testID={`attack-terminal-live-${terminal.id}`}>
      <View style={styles.paneHeader}>
        <Text style={styles.paneRole} numberOfLines={1}>
          {role}
        </Text>
        <Text style={styles.paneMeta} numberOfLines={1}>
          {terminal.title}
        </Text>
      </View>
      {mounted && cwd ? (
        <View style={styles.xterm}>
          <TerminalPane
            serverId={serverId}
            cwd={cwd}
            terminalId={terminal.id}
            isWorkspaceFocused
            isPaneFocused={false}
            onOpenFileExplorer={noop}
            onOpenWorkspaceFile={openFileInWorkspace}
          />
        </View>
      ) : (
        <View style={styles.empty}>
          <Button
            size="sm"
            variant="secondary"
            onPress={open}
            testID={`attack-terminal-open-${terminal.id}`}
          >
            {t("attack.subviews.terminal.openLive")}
          </Button>
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, minHeight: 0 },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
  },
  chips: { flex: 1, minWidth: 0 },
  chipsContent: { gap: theme.spacing[1], alignItems: "center" },
  chip: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  chipActive: { backgroundColor: theme.colors.surface2 },
  chipText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  chipTextActive: { color: theme.colors.foreground },
  pagination: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  pageText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  grid: { flex: 1, minHeight: 0, gap: theme.spacing[2], padding: theme.spacing[4] },
  row: { flex: 1, minHeight: 0, flexDirection: "row", gap: theme.spacing[2] },
  filler: { flex: 1, minWidth: 0 },
  pane: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.terminal.background,
  },
  paneHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  paneRole: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, fontWeight: "500" },
  paneMeta: { flex: 1, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  feed: {
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
    justifyContent: "flex-end",
    padding: theme.spacing[3],
  },
  line: {
    flexShrink: 0,
    lineHeight: 16,
    color: theme.colors.terminal.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
  lineCommand: { color: theme.colors.palette.green[500], fontWeight: "600" },
  lineStatus: { color: theme.colors.palette.red[500] },
  xterm: { flex: 1, minHeight: 0 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.spacing[6] },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));
