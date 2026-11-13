import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "@/i18n/use-translation";
import { Text, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronUp } from "lucide-react-native";
import type { ViewNode } from "@pimi/protocol/chat-view";
import { PressHighlight } from "@/components/ui/press-highlight";
import { ScrollView } from "@/components/ui/scroll-view";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import type { Theme } from "@/styles/theme";

type TableNode = Extract<ViewNode, { type: "table" }>;
type Cell = TableNode["rows"][number][number];
type SortDirection = "ascending" | "descending";

interface TableSort {
  column: number;
  direction: SortDirection;
}

/** A column of short values, such as numbers, stays readable narrower than one of words. */
const SHORT_COLUMN_WIDTH = 72;
const MIN_COLUMN_WIDTH = 96;
const SHORT_CELL_LENGTH = 8;
/** Past this a longer cell earns its column no more room; it wraps instead. */
const MAX_COLUMN_WEIGHT = 28;
const SORT_ICON_SIZE = 12;

const ThemedChevronUp = withUnistyles(ChevronUp);
const ThemedChevronDown = withUnistyles(ChevronDown);
const mapSortIcon = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** Numbers sort before text and by value; text sorts the way a reader expects "item 10" after "item 9". */
function compareCells(a: Cell, b: Cell): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

interface PositionedRow {
  /** Where the agent put the row; its identity while the reader re-sorts. */
  position: number;
  cells: Cell[];
}

function sortRows(rows: TableNode["rows"], sort: TableSort | null): PositionedRow[] {
  const positioned = rows.map((cells, position) => ({ cells, position }));
  if (!sort) return positioned;
  const sign = sort.direction === "ascending" ? 1 : -1;
  return positioned.sort(
    (a, b) =>
      sign * compareCells(a.cells[sort.column], b.cells[sort.column]) || a.position - b.position,
  );
}

function nextSort(current: TableSort | null, column: number): TableSort | null {
  if (current?.column !== column) return { column, direction: "ascending" };
  if (current.direction === "ascending") return { column, direction: "descending" };
  return null;
}

interface ColumnFit {
  /** The column's share of the table's width, from its longest cell. */
  flex: number;
  minWidth: number;
}

function fitColumns(node: TableNode): ColumnFit[] {
  return node.columns.map(({ label }, column) => {
    const longestCell = node.rows.reduce(
      (length, row) => Math.max(length, (row[column] ?? "").toString().length),
      0,
    );
    // The heading wraps onto a second line, so only the cells decide how narrow a column may be.
    return {
      flex: Math.min(MAX_COLUMN_WEIGHT, Math.max(SHORT_CELL_LENGTH, longestCell, label.length)),
      minWidth: longestCell <= SHORT_CELL_LENGTH ? SHORT_COLUMN_WIDTH : MIN_COLUMN_WIDTH,
    };
  });
}

function HeaderCell({
  label,
  column,
  fit,
  alignEnd,
  direction,
  onSort,
}: {
  label: string;
  column: number;
  fit: ColumnFit;
  alignEnd: boolean;
  direction: SortDirection | null;
  onSort: (column: number) => void;
}) {
  const { t } = useTranslation();
  const sort = useCallback(() => onSort(column), [column, onSort]);
  const state = direction ?? "unsorted";
  return (
    <PressHighlight
      testID={`chat-view-table-header-${column}`}
      accessibilityRole="button"
      accessibilityLabel={t(`message.visualization.sort.${state}`, { column: label })}
      aria-sort={direction ?? "none"}
      onPress={sort}
      highlightStyle={styles.pressed}
      style={[
        styles.cell,
        styles.headerCell,
        alignEnd && styles.cellEnd,
        inlineUnistylesStyle(fit),
      ]}
    >
      <Text numberOfLines={2} style={styles.headerText}>
        {label}
      </Text>
      {/* The slot is always reserved so sorting never changes a column's width. */}
      <View style={styles.sortIcon}>
        {direction === "ascending" ? (
          <ThemedChevronUp size={SORT_ICON_SIZE} uniProps={mapSortIcon} />
        ) : null}
        {direction === "descending" ? (
          <ThemedChevronDown size={SORT_ICON_SIZE} uniProps={mapSortIcon} />
        ) : null}
      </View>
    </PressHighlight>
  );
}

export function TableView({ node }: { node: TableNode }) {
  const [sort, setSort] = useState<TableSort | null>(null);
  const active = sort && sort.column < node.columns.length ? sort : null;
  const rows = useMemo(() => sortRows(node.rows, active), [active, node.rows]);
  const alignEnd = useMemo(
    () =>
      node.columns.map(({ align }, column) => {
        if (align) return align === "end";
        return node.rows.every((row) => typeof row[column] === "number");
      }),
    [node.columns, node.rows],
  );
  const changeSort = useCallback((column: number) => {
    setSort((current) => nextSort(current, column));
  }, []);
  const columns = useMemo(() => fitColumns(node), [node]);
  const [available, setAvailable] = useState(0);
  const measure = useCallback(({ nativeEvent }: LayoutChangeEvent) => {
    const measured = Math.floor(nativeEvent.layout.width);
    // A hidden retained panel reports zero; keep the last real width.
    if (measured > 0) setAvailable(measured);
  }, []);
  // A scroller's content is as wide as its longest lines, so a table of sentences would never
  // wrap and would push its later columns off a phone. The table is given the card's width
  // instead, and scrolls only when its columns cannot all be legible in it.
  const needed = columns.reduce((sum, column) => sum + column.minWidth, 0);
  const width = Math.max(available, needed);
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={needed > available}
      style={FILL}
      contentContainerStyle={GROW}
      onLayout={measure}
    >
      <View
        testID="chat-view-table"
        style={[
          styles.table,
          inlineUnistylesStyle(available > 0 ? { width } : { minWidth: needed }),
        ]}
      >
        <View style={styles.row}>
          {node.columns.map(({ label }, column) => (
            <HeaderCell
              key={label}
              label={label}
              column={column}
              fit={columns[column]}
              alignEnd={alignEnd[column]}
              direction={active?.column === column ? active.direction : null}
              onSort={changeSort}
            />
          ))}
        </View>
        {rows.map(({ cells, position }) => (
          <View key={position} style={[styles.row, styles.rowBorder]} testID="chat-view-table-row">
            {cells.map((cell, column) => (
              <View
                key={node.columns[column].label}
                style={[
                  styles.cell,
                  alignEnd[column] && styles.cellEnd,
                  inlineUnistylesStyle(columns[column]),
                ]}
              >
                <Text
                  selectable
                  style={[styles.cellText, typeof cell === "number" && styles.cellNumber]}
                >
                  {cell.toString()}
                </Text>
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

// Theme-free: a scroller's content container is not a style Unistyles tracks.
// A horizontal scroll view sizes its content to fit, so the table is told to fill the card.
// These are plain objects: Unistyles styles do not reach a scroll view's content container on web.
const FILL = { alignSelf: "stretch", width: "100%" } as const;
const GROW = { flexGrow: 1, minWidth: "100%" } as const;

const styles = StyleSheet.create((theme) => ({
  table: { flexGrow: 1 },
  row: { flexDirection: "row" },
  rowBorder: { borderTopWidth: 1, borderColor: theme.colors.border },
  cell: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
  },
  cellEnd: { justifyContent: "flex-end" },
  headerCell: { gap: theme.spacing[1], borderRadius: theme.borderRadius.md },
  pressed: { backgroundColor: theme.colors.interactionHighlight },
  headerText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    flexShrink: 1,
  },
  sortIcon: { width: SORT_ICON_SIZE, height: SORT_ICON_SIZE },
  cellText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, flexShrink: 1 },
  cellNumber: { fontVariant: ["tabular-nums"] },
}));
