import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";
import Svg, { Circle, G, Path, Polygon, Rect, Text as SvgText } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  Bot,
  CircleCheck,
  CircleDot,
  CircleX,
  CodeXml,
  Database,
  FileText,
  Globe,
  KeyRound,
  Layers,
  Server,
  TriangleAlert,
  User,
  Wrench,
  type LucideIcon,
} from "lucide-react-native";
import type { FlowKind, FlowNode, ViewTone } from "@pimi/protocol/chat-view";
import { ScrollView } from "@/components/ui/scroll-view";
import { identityForeground, type IdentityColorName } from "@/styles/identity-colors";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import type { Theme } from "@/styles/theme";
import {
  FLOW_EDGE_LABEL_FONT_SIZE,
  FLOW_FONT_SIZE,
  FLOW_LINE_HEIGHT,
  FLOW_TEXT_INSET,
  FLOW_TILE_SIZE,
  FLOW_TILE_STRIP,
  buildFlowScene,
  hitTestFlow,
  type FlowBox,
  type FlowScene,
} from "./flow-layout";
import { FLOW_FADE_CLASS, FLOW_FADE_STYLE, FLOW_MARCH_CLASS, useFlowOnScreen } from "./flow-motion";
import { SceneInteraction, useInspection } from "./interaction";

const BOX_RADIUS = 8;
const LANE_RADIUS = 10;
const EDGE_WIDTH = 1.5;
const FOCUSED_EDGE_WIDTH = 2;
const EDGE_DASH = "6 4";
/** A back edge closes a cycle; dotted, so a retry or loop reads apart from the forward edges. */
const BACK_EDGE_DASH = "2 3";
/** A 10% wash of the box's colour over the card, 20% on the box in focus. */
const BODY_TINT = 0.1;
const FOCUSED_BODY_TINT = 0.2;
/** While a box is in focus, boxes it does not touch and edges that do not touch it recede. */
const DIMMED_BOX = 0.35;
const DIMMED_EDGE = 0.2;
const SIDE_ICON = 16;
const TOP_ICON = 13;

/** Each kind takes one of the identity hues, at the status band's lightness for the theme. */
const KIND_HUE: Record<FlowKind, IdentityColorName | null> = {
  step: null,
  user: "sky",
  agent: "violet",
  service: "blue",
  data: "emerald",
  file: "teal",
  queue: "amber",
  tool: "orange",
  code: "indigo",
  external: "pink",
  secret: "red",
};

const KIND_ICON: Record<FlowKind, LucideIcon> = {
  step: CircleDot,
  user: User,
  agent: Bot,
  service: Server,
  data: Database,
  file: FileText,
  queue: Layers,
  tool: Wrench,
  code: CodeXml,
  external: Globe,
  secret: KeyRound,
};

/** A plain step that carries a tone shows the tone's icon. */
const TONE_ICON: Record<ViewTone, LucideIcon> = {
  neutral: CircleDot,
  positive: CircleCheck,
  negative: CircleX,
  warning: TriangleAlert,
};

function boxIcon({ kind, tone }: FlowBox): LucideIcon {
  return kind === "step" ? TONE_ICON[tone] : KIND_ICON[kind];
}

function flowColors(theme: Theme) {
  const { colors } = theme;
  const tones: Record<Exclude<ViewTone, "neutral">, string> = {
    positive: colors.statusSuccess,
    negative: colors.statusDanger,
    warning: colors.statusWarning,
  };
  /**
   * The box's colour: its tone when it has one, else its kind's hue, else muted ink. Each clears
   * 3:1 against the card, so it serves as the box border, the tile, and the focused box's edges,
   * and the card colour drawn on the tile clears 3:1 against it for the icon. The hairline border
   * token (about 1.1-1.4:1 on the card) would not.
   */
  const boxColor = ({ kind, tone }: { kind: FlowKind; tone: ViewTone }) => {
    if (tone !== "neutral") return tones[tone];
    const hue = KIND_HUE[kind];
    return hue ? identityForeground(hue, theme.colorScheme) : colors.foregroundMuted;
  };
  return {
    lane: colors.surface2,
    laneLabel: colors.foregroundMuted,
    box: colors.surface1,
    text: colors.foreground,
    edge: colors.foregroundMuted,
    edgeLabel: colors.foregroundMuted,
    edgeLabelFill: colors.surface1,
    edgeLabelBorder: colors.border,
    marker: colors.foregroundMuted,
    boxColor,
    font: theme.fontFamily.ui,
  };
}

type FlowColors = ReturnType<typeof flowColors>;

/** A web-only CSS class on an SVG element; react-native-svg passes it through to the DOM. */
function cssClass(name: string | undefined): object {
  return name ? { className: name } : {};
}

/** A rectangle with its own radius per corner: top-left, top-right, bottom-right, bottom-left. */
function roundedRect(
  x: number,
  y: number,
  width: number,
  height: number,
  [tl, tr, br, bl]: [number, number, number, number],
): string {
  const right = x + width;
  const bottom = y + height;
  return [
    `M${x + tl},${y}`,
    `H${right - tr}`,
    tr ? `A${tr},${tr} 0 0 1 ${right},${y + tr}` : "",
    `V${bottom - br}`,
    br ? `A${br},${br} 0 0 1 ${right - br},${bottom}` : "",
    `H${x + bl}`,
    bl ? `A${bl},${bl} 0 0 1 ${x},${bottom - bl}` : "",
    `V${y + tl}`,
    tl ? `A${tl},${tl} 0 0 1 ${x + tl},${y}` : "",
    "Z",
  ].join("");
}

function tilePath({ box, tile }: FlowBox): string {
  if (tile === "side") {
    return roundedRect(box.x, box.y, FLOW_TILE_SIZE, box.height, [BOX_RADIUS, 0, 0, BOX_RADIUS]);
  }
  return roundedRect(box.x, box.y, box.width, FLOW_TILE_STRIP, [BOX_RADIUS, BOX_RADIUS, 0, 0]);
}

/** The box in focus and the boxes one edge away from it; null when nothing is in focus. */
function litBoxes(scene: FlowScene, focused: number): Set<number> | null {
  if (focused < 0) return null;
  const lit = new Set([focused]);
  for (const { from, to } of scene.edges) {
    if (from === focused) lit.add(to);
    if (to === focused) lit.add(from);
  }
  return lit;
}

/** Draws a flow scene. The scene decides every position; this only paints it. */
function FlowPainter({
  scene,
  highlighted,
  marching,
  colors,
}: {
  scene: FlowScene;
  /** The box in focus: it and its neighbours stay lit and its edges take its colour; -1 for none. */
  highlighted: number;
  /** Whether the dashed edges march: on web, while the flow is on screen. */
  marching: boolean;
  colors?: FlowColors;
}) {
  if (!colors || scene.width <= 0) return null;
  const lit = litBoxes(scene, highlighted);
  const touches = (from: number, to: number) => from === highlighted || to === highlighted;
  const focusColor = highlighted >= 0 ? colors.boxColor(scene.boxes[highlighted]) : colors.edge;
  const edgeOpacity = (from: number, to: number) => (!lit || touches(from, to) ? 1 : DIMMED_EDGE);
  // Focused edges are painted last so they sit above the edges they cross.
  const edges = [...scene.edges].sort(
    (a, b) => Number(touches(a.from, a.to)) - Number(touches(b.from, b.to)),
  );
  const fade = cssClass(FLOW_FADE_CLASS);
  const march = cssClass(marching ? FLOW_MARCH_CLASS : undefined);
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
        return (
          <G key={edge.key} opacity={edgeOpacity(edge.from, edge.to)} {...fade}>
            <Path
              d={edge.path}
              fill="none"
              stroke={active ? focusColor : colors.edge}
              strokeWidth={active ? FOCUSED_EDGE_WIDTH : EDGE_WIDTH}
              strokeDasharray={edge.back ? BACK_EDGE_DASH : EDGE_DASH}
              strokeLinecap="round"
              {...march}
            />
          </G>
        );
      })}
      {scene.edges.map((edge) =>
        edge.label ? (
          // The edge's verb on a pill in the card colour, over the edge.
          <G key={`label:${edge.key}`} opacity={edgeOpacity(edge.from, edge.to)} {...fade}>
            <Rect
              x={edge.label.box.x}
              y={edge.label.box.y}
              width={edge.label.box.width}
              height={edge.label.box.height}
              rx={edge.label.box.height / 2}
              fill={colors.edgeLabelFill}
              stroke={touches(edge.from, edge.to) ? focusColor : colors.edgeLabelBorder}
              strokeWidth={1}
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
        const color = colors.boxColor(item);
        const focused = index === highlighted;
        const side = item.tile === "side";
        const textX = side ? box.x + FLOW_TILE_SIZE + FLOW_TEXT_INSET : box.x + box.width / 2;
        const bodyTop = side ? box.y : box.y + FLOW_TILE_STRIP;
        const bodyHeight = side ? box.height : box.height - FLOW_TILE_STRIP;
        const textTop = bodyTop + (bodyHeight - item.lines.length * FLOW_LINE_HEIGHT) / 2;
        return (
          <G key={item.key} opacity={!lit || lit.has(index) ? 1 : DIMMED_BOX} {...fade}>
            {/* Opaque under the wash, so a lane band does not show through the box. */}
            <Rect
              x={box.x}
              y={box.y}
              width={box.width}
              height={box.height}
              rx={BOX_RADIUS}
              fill={colors.box}
            />
            <Rect
              x={box.x}
              y={box.y}
              width={box.width}
              height={box.height}
              rx={BOX_RADIUS}
              fill={color}
              fillOpacity={focused ? FOCUSED_BODY_TINT : BODY_TINT}
              stroke={color}
              strokeWidth={focused ? 1.5 : 1}
            />
            <Path d={tilePath(item)} fill={color} />
            {item.lines.map((line, row) => (
              <SvgText
                // eslint-disable-next-line react/no-array-index-key
                key={row}
                x={textX}
                y={textTop + row * FLOW_LINE_HEIGHT + FLOW_FONT_SIZE}
                textAnchor={side ? "start" : "middle"}
                fill={colors.text}
                fontSize={FLOW_FONT_SIZE}
                fontFamily={colors.font}
              >
                {line}
              </SvgText>
            ))}
            {item.detail ? (
              // Marks a box that has more to read on hover or press.
              <Circle cx={box.x + box.width - 6} cy={bodyTop + 6} r={2} fill={colors.marker} />
            ) : null}
          </G>
        );
      })}
      {/* Heads go above the boxes so each tip lands on its box's border, not under it. */}
      {edges.map((edge) => {
        const active = touches(edge.from, edge.to);
        return (
          <Polygon
            key={`head:${edge.key}`}
            points={edge.arrow}
            fill={active ? focusColor : colors.edge}
            opacity={edgeOpacity(edge.from, edge.to)}
            {...fade}
          />
        );
      })}
    </Svg>
  );
}

const ThemedFlowPainter = withUnistyles(FlowPainter);
const mapFlowColors = (theme: Theme) => ({ colors: flowColors(theme) });

/**
 * The tile icons. Each Lucide icon is its own SVG, so they sit in views over the painted scene
 * rather than as an SVG nested in another.
 */
function FlowIcons({
  scene,
  highlighted,
  color,
}: {
  scene: FlowScene;
  highlighted: number;
  color?: string;
}) {
  if (!color) return null;
  const lit = litBoxes(scene, highlighted);
  return scene.boxes.map((item, index) => {
    const Icon = boxIcon(item);
    const { box } = item;
    const side = item.tile === "side";
    const size = side ? SIDE_ICON : TOP_ICON;
    const left = side ? box.x + (FLOW_TILE_SIZE - size) / 2 : box.x + (box.width - size) / 2;
    const top = side ? box.y + (box.height - size) / 2 : box.y + (FLOW_TILE_STRIP - size) / 2;
    return (
      <View
        key={item.key}
        style={[
          styles.icon,
          FLOW_FADE_STYLE,
          inlineUnistylesStyle({ left, top, opacity: !lit || lit.has(index) ? 1 : DIMMED_BOX }),
        ]}
      >
        <Icon size={size} color={color} strokeWidth={2.25} />
      </View>
    );
  });
}

const ThemedFlowIcons = withUnistyles(FlowIcons);
// The card colour on the tile: every tile colour clears 3:1 against it.
const mapIconColor = (theme: Theme) => ({ color: theme.colors.surface1 });

/**
 * A flow diagram. It is laid out for the width it is given; when even the better of its two
 * directions is wider than that, it scrolls sideways like a wide table.
 */
export function FlowView({ node }: { node: FlowNode }) {
  const [width, setWidth] = useState(0);
  const container = useRef<View>(null);
  const onScreen = useFlowOnScreen(container);
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
      <ThemedFlowPainter
        scene={scene}
        highlighted={inspected}
        marching={onScreen}
        uniProps={mapFlowColors}
      />
      <ThemedFlowIcons scene={scene} highlighted={inspected} uniProps={mapIconColor} />
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
    <View ref={container} style={styles.flow} onLayout={measure} testID="chat-view-flow">
      {body}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  flow: { alignSelf: "stretch", minWidth: 0 },
  // ltr: the scene is positioned in pixels from the left edge.
  canvas: { direction: "ltr" },
  icon: { position: "absolute", pointerEvents: "none" },
  popover: { gap: theme.spacing[1], maxWidth: 260, paddingVertical: theme.spacing[1] },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  detail: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
