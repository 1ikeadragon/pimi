import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";
import Svg, { Circle, G, Path, Polygon, Rect, Text as SvgText } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { FlowNode, ViewTone } from "@pimi/protocol/chat-view";
import { ScrollView } from "@/components/ui/scroll-view";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import type { Theme } from "@/styles/theme";
import {
  FLOW_EDGE_LABEL_FONT_SIZE,
  FLOW_FONT_SIZE,
  FLOW_LINE_HEIGHT,
  buildFlowScene,
  hitTestFlow,
  type FlowScene,
} from "./flow-layout";
import { SceneInteraction, useInspection } from "./interaction";

const BOX_RADIUS = 8;
const LANE_RADIUS = 10;
const EDGE_OPACITY = 0.7;
const BACK_EDGE_DASH = "4 3";

function flowColors(theme: Theme) {
  const { colors } = theme;
  const tones: Record<ViewTone, string> = {
    neutral: colors.border,
    positive: colors.statusSuccess,
    negative: colors.statusDanger,
    warning: colors.statusWarning,
  };
  return {
    lane: colors.surface2,
    laneLabel: colors.foregroundMuted,
    box: colors.surface1,
    text: colors.foreground,
    edge: colors.foregroundMuted,
    edgeLabel: colors.foregroundMuted,
    edgeLabelFill: colors.surface1,
    marker: colors.foregroundMuted,
    highlight: colors.accent,
    tones,
    font: theme.fontFamily.ui,
  };
}

type FlowColors = ReturnType<typeof flowColors>;

/** Draws a flow scene. The scene decides every position; this only paints it. */
function FlowPainter({
  scene,
  highlighted,
  colors,
}: {
  scene: FlowScene;
  /** The inspected box, whose box and edges are drawn in the accent colour; -1 for none. */
  highlighted: number;
  colors?: FlowColors;
}) {
  if (!colors || scene.width <= 0) return null;
  const touches = (from: number, to: number) => from === highlighted || to === highlighted;
  // Highlighted edges are painted last so they sit above the edges they cross.
  const edges = [...scene.edges].sort(
    (a, b) => Number(touches(a.from, a.to)) - Number(touches(b.from, b.to)),
  );
  return (
    <Svg width={scene.width} height={scene.height}>
      {scene.lanes.map((lane) => (
        <G key={lane.key}>
          <Rect
            x={lane.box.x}
            y={lane.box.y}
            width={lane.box.width}
            height={lane.box.height}
            rx={LANE_RADIUS}
            fill={colors.lane}
          />
          <SvgText
            x={lane.labelAt.x}
            y={lane.labelAt.y}
            textAnchor={lane.labelAnchor}
            fill={colors.laneLabel}
            fontSize={FLOW_EDGE_LABEL_FONT_SIZE}
            fontWeight="500"
            fontFamily={colors.font}
          >
            {lane.label}
          </SvgText>
        </G>
      ))}
      {edges.map((edge) => {
        const active = touches(edge.from, edge.to);
        const stroke = active ? colors.highlight : colors.edge;
        return (
          <G key={edge.key} opacity={active ? 1 : EDGE_OPACITY}>
            <Path
              d={edge.path}
              fill="none"
              stroke={stroke}
              strokeWidth={active ? 1.75 : 1.25}
              strokeDasharray={edge.back ? BACK_EDGE_DASH : undefined}
            />
            <Polygon points={edge.arrow} fill={stroke} />
          </G>
        );
      })}
      {scene.edges.map((edge) =>
        edge.label ? (
          <G key={`label:${edge.key}`}>
            <Rect
              x={edge.label.box.x}
              y={edge.label.box.y}
              width={edge.label.box.width}
              height={edge.label.box.height}
              rx={4}
              fill={colors.edgeLabelFill}
            />
            <SvgText
              x={edge.label.box.x + edge.label.box.width / 2}
              y={edge.label.box.y + edge.label.box.height / 2 + 4}
              textAnchor="middle"
              fill={colors.edgeLabel}
              fontSize={FLOW_EDGE_LABEL_FONT_SIZE}
              fontFamily={colors.font}
            >
              {edge.label.text}
            </SvgText>
          </G>
        ) : null,
      )}
      {scene.boxes.map((item, index) => {
        const { box } = item;
        const active = index === highlighted;
        const toned = item.tone !== "neutral";
        const textTop = box.y + (box.height - item.lines.length * FLOW_LINE_HEIGHT) / 2;
        return (
          <G key={item.key}>
            <Rect
              x={box.x}
              y={box.y}
              width={box.width}
              height={box.height}
              rx={BOX_RADIUS}
              fill={colors.box}
              stroke={active ? colors.highlight : colors.tones[item.tone]}
              strokeWidth={active || toned ? 1.5 : 1}
            />
            {item.lines.map((line, row) => (
              <SvgText
                // eslint-disable-next-line react/no-array-index-key
                key={row}
                x={box.x + box.width / 2}
                y={textTop + row * FLOW_LINE_HEIGHT + FLOW_FONT_SIZE}
                textAnchor="middle"
                fill={colors.text}
                fontSize={FLOW_FONT_SIZE}
                fontFamily={colors.font}
              >
                {line}
              </SvgText>
            ))}
            {item.detail ? (
              // Marks a box that has more to read on hover or press.
              <Circle cx={box.x + box.width - 6} cy={box.y + 6} r={2} fill={colors.marker} />
            ) : null}
          </G>
        );
      })}
    </Svg>
  );
}

const ThemedFlowPainter = withUnistyles(FlowPainter);
const mapFlowColors = (theme: Theme) => ({ colors: flowColors(theme) });

/**
 * A flow diagram. It is laid out for the width it is given; when even the better of its two
 * directions is wider than that, it scrolls sideways like a wide table.
 */
export function FlowView({ node }: { node: FlowNode }) {
  const [width, setWidth] = useState(0);
  const scene = useMemo(() => buildFlowScene(node, width), [node, width]);
  const { inspected, inspect } = useInspection(scene.targets);
  const measure = useCallback(({ nativeEvent }: LayoutChangeEvent) => {
    const measured = Math.floor(nativeEvent.layout.width);
    // A hidden retained panel reports zero; keep the last real width.
    if (measured > 0) setWidth(measured);
  }, []);
  const hitTest = useCallback((x: number, y: number) => hitTestFlow(scene, x, y), [scene]);
  const select = useCallback(
    (index: number) => inspect(scene.targets[index]?.key ?? null, true),
    [inspect, scene.targets],
  );
  const renderPopover = useCallback(
    (index: number) => {
      const box = scene.boxes[index];
      if (!box?.detail) return null;
      return (
        <View style={styles.popover}>
          <Text style={styles.title}>{box.label}</Text>
          <Text style={styles.detail}>{box.detail}</Text>
        </View>
      );
    },
    [scene.boxes],
  );
  const bounds = useMemo(
    () => ({ width: scene.width, height: scene.height }),
    [scene.height, scene.width],
  );
  const canvas = (
    <View
      style={[styles.canvas, inlineUnistylesStyle({ width: scene.width, height: scene.height })]}
    >
      <ThemedFlowPainter scene={scene} highlighted={inspected} uniProps={mapFlowColors} />
      <SceneInteraction
        targets={scene.targets}
        bounds={bounds}
        hitTest={hitTest}
        inspected={inspected}
        onSelect={select}
        onInspect={inspect}
        renderPopover={renderPopover}
        clearBox
        testIDPrefix="chat-view-flow-node"
      />
    </View>
  );
  let body: ReactNode = null;
  if (width > 0) {
    body =
      scene.width > width ? (
        <ScrollView horizontal showsHorizontalScrollIndicator>
          {canvas}
        </ScrollView>
      ) : (
        canvas
      );
  }
  return (
    <View style={styles.flow} onLayout={measure} testID="chat-view-flow">
      {body}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  flow: { alignSelf: "stretch", minWidth: 0 },
  // ltr: the scene is positioned in pixels from the left edge.
  canvas: { direction: "ltr" },
  popover: { gap: theme.spacing[1], maxWidth: 260, paddingVertical: theme.spacing[1] },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  detail: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
