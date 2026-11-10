import type { ReactElement } from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ViewNode } from "@pimi/protocol/chat-view";
import { ChartView } from "./chart";
import { BadgeView, MetricView, ProgressView, TextView } from "./nodes";
import { TableView } from "./table";

type NodeOf<Type extends ViewNode["type"]> = Extract<ViewNode, { type: Type }>;

/** Children have no ids; a view is replaced whole, so position is their identity. */
function Children({ nodes, cellStyle }: { nodes: ViewNode[]; cellStyle?: StyleProp<ViewStyle> }) {
  return nodes.map((child, position) => (
    // eslint-disable-next-line react/no-array-index-key
    <View key={position} style={cellStyle ?? styles.cell}>
      <ViewNodeView node={child} />
    </View>
  ));
}

function StackView({ node }: { node: NodeOf<"stack"> }) {
  if (node.direction !== "row") {
    return (
      <View style={styles.column}>
        <Children nodes={node.children} />
      </View>
    );
  }
  return (
    <View style={styles.row}>
      <Children nodes={node.children} cellStyle={styles.rowCell} />
    </View>
  );
}

function GridView({ node }: { node: NodeOf<"grid"> }) {
  // A cell never narrows below its minimum, so a wide grid wraps to fewer columns on a phone.
  const cells = [styles.grid1, styles.grid2, styles.grid3, styles.grid4];
  return (
    <View style={styles.row}>
      <Children nodes={node.children} cellStyle={cells[(node.columns ?? 2) - 1]} />
    </View>
  );
}

function SectionView({ node }: { node: NodeOf<"section"> }) {
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.sectionTitle}>
        {node.title}
      </Text>
      <View style={styles.column}>
        <Children nodes={node.children} />
      </View>
    </View>
  );
}

/**
 * The registry: every catalog node type and the component that draws it. The parser admits no
 * other type, and a new one fails to compile here until it has a component.
 */
export function ViewNodeView({ node }: { node: ViewNode }): ReactElement {
  switch (node.type) {
    case "stack":
      return <StackView node={node} />;
    case "grid":
      return <GridView node={node} />;
    case "section":
      return <SectionView node={node} />;
    case "metric":
      return <MetricView node={node} />;
    case "chart":
      return <ChartView chart={node} />;
    case "table":
      return <TableView node={node} />;
    case "progress":
      return <ProgressView node={node} />;
    case "text":
      return <TextView node={node} />;
    case "badge":
      return <BadgeView node={node} />;
  }
}

const GRID_CELL = { flexGrow: 1, flexShrink: 1, minWidth: 136 } as const;

const styles = StyleSheet.create((theme) => ({
  column: { gap: theme.spacing[4] },
  row: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[4] },
  cell: { minWidth: 0 },
  rowCell: { flexGrow: 1, flexShrink: 1, flexBasis: 136, minWidth: 0 },
  // Each basis leaves room for the gaps between that many cells.
  grid1: { ...GRID_CELL, flexBasis: "100%" },
  grid2: { ...GRID_CELL, flexBasis: "40%" },
  grid3: { ...GRID_CELL, flexBasis: "27%" },
  grid4: { ...GRID_CELL, flexBasis: "21%" },
  section: { gap: theme.spacing[2] },
  sectionTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
}));
