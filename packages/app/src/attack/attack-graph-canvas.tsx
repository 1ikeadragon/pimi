import { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View, type LayoutChangeEvent } from "react-native";
import Svg, { Path } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import type { AttackGraphModel, GraphColumn, GraphNode } from "./attack-graph-model";

const NODE_HEIGHT = 28;
const ROW_PITCH = 36;
const COLUMN_GAP = 32;
const PADDING = 16;
const HEADER_HEIGHT = 28;
const MIN_WIDTH = 640;

// The theme reaches the edges through the SVG's `color` (strokes use currentColor): a themed
// <Path> would be wrapped in a <div> on web, which an <svg> does not render.
const EdgeSvg = withUnistyles(Svg, (theme) => ({ color: theme.colors.border }));
const ActiveEdgeSvg = withUnistyles(Svg, (theme) => ({ color: theme.colors.foregroundMuted }));

interface Placed {
  node: GraphNode;
  left: number;
  top: number;
}

function edgeD(from: Placed, to: Placed, width: number): string {
  const x1 = from.left + width;
  const y1 = from.top + NODE_HEIGHT / 2;
  const x2 = to.left;
  const y2 = to.top + NODE_HEIGHT / 2;
  const mid = (x1 + x2) / 2;
  return `M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`;
}

/**
 * Four fixed columns of pressable nodes with the edges drawn as SVG underneath. Node text and
 * press targets are ordinary views, so they take the theme and focus like the rest of the app.
 */
export function AttackGraphCanvas({
  model,
  columnLabels,
  selectedId,
  onSelect,
}: {
  model: AttackGraphModel;
  columnLabels: readonly [string, string, string, string];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [measured, setMeasured] = useState(0);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setMeasured(Math.floor(event.nativeEvent.layout.width));
  }, []);
  const width = Math.max(MIN_WIDTH, measured);
  const nodeWidth = Math.floor((width - PADDING * 2 - COLUMN_GAP * 3) / 4);
  const height = HEADER_HEIGHT + model.rows * ROW_PITCH + PADDING;

  const placed = useMemo(() => {
    const map = new Map<string, Placed>();
    for (const node of model.nodes) {
      map.set(node.id, {
        node,
        left: PADDING + node.column * (nodeWidth + COLUMN_GAP),
        top: HEADER_HEIGHT + node.row * ROW_PITCH,
      });
    }
    return map;
  }, [model.nodes, nodeWidth]);

  const { allD, activeD } = useMemo(() => {
    const all: string[] = [];
    const active: string[] = [];
    for (const edge of model.edges) {
      const from = placed.get(edge.from);
      const to = placed.get(edge.to);
      if (!from || !to) continue;
      const d = edgeD(from, to, nodeWidth);
      if (selectedId && (edge.from === selectedId || edge.to === selectedId)) active.push(d);
      else all.push(d);
    }
    return { allD: all.join(" "), activeD: active.join(" ") };
  }, [model.edges, nodeWidth, placed, selectedId]);

  const columns: GraphColumn[] = [0, 1, 2, 3];
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={measured < MIN_WIDTH}>
      <View style={styles.scroller} onLayout={onLayout}>
        <View
          style={[styles.canvas, inlineUnistylesStyle({ width, height })]}
          testID="attack-graph-canvas"
        >
          <EdgeSvg width={width} height={height} style={styles.svg} pointerEvents="none">
            <Path d={allD} fill="none" stroke="currentColor" strokeWidth={1.25} />
          </EdgeSvg>
          {activeD ? (
            <ActiveEdgeSvg width={width} height={height} style={styles.svg} pointerEvents="none">
              <Path d={activeD} fill="none" stroke="currentColor" strokeWidth={1.75} />
            </ActiveEdgeSvg>
          ) : null}
          {columns.map((column) => (
            <Text
              key={column}
              style={[
                styles.columnLabel,
                inlineUnistylesStyle({
                  left: PADDING + column * (nodeWidth + COLUMN_GAP),
                  width: nodeWidth,
                }),
              ]}
              numberOfLines={1}
            >
              {columnLabels[column]}
            </Text>
          ))}
          {model.nodes.map((node) => {
            const at = placed.get(node.id);
            if (!at) return null;
            return (
              <GraphNodeView
                key={node.id}
                node={node}
                left={at.left}
                top={at.top}
                width={nodeWidth}
                selected={node.id === selectedId}
                onSelect={onSelect}
              />
            );
          })}
        </View>
      </View>
    </ScrollView>
  );
}

function GraphNodeView({
  node,
  left,
  top,
  width,
  selected,
  onSelect,
}: {
  node: GraphNode;
  left: number;
  top: number;
  width: number;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const onPress = useCallback(() => onSelect(node.id), [node.id, onSelect]);
  const solid =
    node.kind === "finding" || node.kind === "lead" || node.kind === "agent" || node.severity;
  return (
    <PressHighlight
      onPress={onPress}
      disabled={node.kind === "more"}
      accessibilityLabel={node.label}
      testID={`attack-graph-node-${node.id}`}
      style={[
        styles.node,
        selected && styles.nodeSelected,
        inlineUnistylesStyle({ left, top, width }),
      ]}
    >
      <View
        style={[
          styles.dot,
          !solid && styles.dotHollow,
          node.severity === "blocker" && styles.dotBlocker,
          node.severity === "major" && styles.dotMajor,
          node.severity === "minor" && styles.dotMinor,
          !node.severity && solid && styles.dotNeutral,
        ]}
      />
      <Text
        style={[styles.nodeLabel, node.kind === "more" && styles.nodeLabelMuted]}
        numberOfLines={1}
      >
        {node.label}
      </Text>
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  scroller: { minWidth: "100%" },
  canvas: { position: "relative" },
  svg: { position: "absolute", top: 0, left: 0 },
  columnLabel: {
    position: "absolute",
    top: theme.spacing[1],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: "500",
  },
  node: {
    position: "absolute",
    height: NODE_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  nodeSelected: {
    borderColor: theme.colors.foregroundMuted,
    backgroundColor: theme.colors.surface3,
  },
  dot: { width: 8, height: 8, borderRadius: theme.borderRadius.full, flexShrink: 0 },
  dotHollow: { borderWidth: 1, borderColor: theme.colors.foregroundMuted },
  dotNeutral: { backgroundColor: theme.colors.foregroundMuted },
  dotBlocker: { backgroundColor: theme.colors.statusDanger },
  dotMajor: { backgroundColor: theme.colors.statusWarning },
  dotMinor: { backgroundColor: theme.colors.foregroundMuted },
  nodeLabel: { flex: 1, minWidth: 0, color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  nodeLabelMuted: { color: theme.colors.foregroundMuted },
}));
