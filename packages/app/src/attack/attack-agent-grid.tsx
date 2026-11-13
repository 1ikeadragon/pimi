import { useCallback, useEffect, useState } from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";
import { useTranslation } from "@/i18n/use-translation";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { DensityIcon } from "@/components/ui/density-icon";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { AttackAgentTile } from "./attack-agent-tile";
import type { AttackRunAgent } from "./use-attack-run-agents";

// Three columns from 1100px, two from 700px, one below; never more than six tiles a page.
function layoutFor(width: number): { columns: number; rows: number } {
  if (width >= 1100) return { columns: 3, rows: 2 };
  if (width >= 700) return { columns: 2, rows: 2 };
  return { columns: 1, rows: 3 };
}

export function AttackAgentGrid({
  agents,
  serverId,
  workspaceId,
  live,
  onFocus,
}: {
  agents: AttackRunAgent[];
  serverId: string;
  workspaceId: string;
  live: boolean;
  onFocus: (agentId: string) => void;
}) {
  const { t } = useTranslation();
  const [width, setWidth] = useState(1100);
  const [page, setPage] = useState(0);
  const { columns, rows } = layoutFor(width);
  const pageSize = columns * rows;
  const pages = Math.max(1, Math.ceil(agents.length / pageSize));
  const current = Math.min(page, pages - 1);
  useEffect(() => {
    if (page !== current) setPage(current);
  }, [current, page]);
  const tiles = agents.slice(current * pageSize, (current + 1) * pageSize);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setWidth(event.nativeEvent.layout.width);
  }, []);
  const previous = useCallback(() => setPage(current - 1), [current]);
  const next = useCallback(() => setPage(current + 1), [current]);
  const rowCount = Math.ceil(tiles.length / columns);
  return (
    <View style={styles.root} onLayout={onLayout} testID="attack-agent-grid">
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
      <View style={styles.grid}>
        {Array.from({ length: rowCount }, (_row, row) => (
          <View key={row} style={styles.row}>
            {tiles.slice(row * columns, (row + 1) * columns).map((item) => (
              <AttackAgentTile
                key={item.agent.id}
                row={item}
                serverId={serverId}
                workspaceId={workspaceId}
                live={live}
                onFocus={onFocus}
              />
            ))}
            {row === rowCount - 1 && tiles.length % columns !== 0
              ? Array.from({ length: columns - (tiles.length % columns) }, (_slot, filler) => (
                  <View key={`filler-${filler}`} style={styles.filler} />
                ))
              : null}
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, minHeight: 0 },
  pagination: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
  },
  pageText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  grid: {
    flex: 1,
    minHeight: 0,
    gap: theme.spacing[2],
    padding: theme.spacing[4],
  },
  row: { flex: 1, minHeight: 0, flexDirection: "row", gap: theme.spacing[2] },
  filler: { flex: 1, minWidth: 0 },
}));
