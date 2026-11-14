import Svg, { Circle, G, Line, Path, Polyline, Rect, Text as SvgText } from "react-native-svg";
import { withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import type { ChartScene, Point, SceneMark } from "./scene";

function sceneColors(theme: Theme) {
  const { colors } = theme;
  return {
    label: colors.foregroundMuted,
    grid: colors.border,
    guide: colors.foregroundMuted,
    band: colors.surface2,
    surface: colors.surface1,
    series: colors.chartSeries,
  };
}

type SceneColors = ReturnType<typeof sceneColors>;

const RESTING_OPACITY = 0.72;
const AREA_OPACITY = 0.16;

function pointList(points: readonly Point[]): string {
  return points.map(({ x, y }) => `${x},${y}`).join(" ");
}

/** One series draws at most one mark of a type per target. */
function markKey(mark: SceneMark): string {
  const target = "target" in mark ? mark.target : "all";
  return `${mark.type}:${mark.slot}:${target}`;
}

function Mark({
  mark,
  selected,
  colors,
}: {
  mark: SceneMark;
  selected: number;
  colors: SceneColors;
}) {
  const color = colors.series[mark.slot % colors.series.length];
  if (mark.type === "area") {
    return <Path d={mark.path} fill={color} opacity={AREA_OPACITY} />;
  }
  if (mark.type === "line") {
    return (
      <Path
        d={mark.path}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    );
  }
  const isSelected = mark.target === selected;
  if (mark.type === "point") {
    if (mark.whenSelected && !isSelected) return null;
    return (
      <Circle
        cx={mark.x}
        cy={mark.y}
        r={isSelected ? 5 : 4}
        fill={color}
        opacity={isSelected || mark.whenSelected ? 1 : RESTING_OPACITY}
        stroke={colors.surface}
        strokeWidth={isSelected ? 2 : 1}
      />
    );
  }
  if (mark.type === "arc") {
    return (
      <Path
        d={mark.path}
        fill={color}
        opacity={isSelected ? 1 : RESTING_OPACITY}
        stroke={colors.surface}
        strokeWidth={2}
        strokeLinejoin="round"
      />
    );
  }
  return <Path d={mark.path} fill={color} opacity={isSelected ? 1 : RESTING_OPACITY} />;
}

/** Draws any chart scene. It holds no chart-type knowledge; the scene decides the marks. */
function ScenePainter({
  scene,
  selected,
  colors,
}: {
  scene: ChartScene;
  selected: number;
  colors?: SceneColors;
}) {
  if (!colors || scene.width <= 0) return null;
  const { plot } = scene;
  const target = scene.targets[selected];
  return (
    <Svg width={scene.width} height={scene.height} aria-hidden>
      {scene.guide === "band" && target ? (
        <Rect
          x={target.box.x}
          y={target.box.y}
          width={target.box.width}
          height={target.box.height}
          fill={colors.band}
          rx={4}
        />
      ) : null}
      {scene.yTicks.map((tick) => (
        <G key={tick.position}>
          <Line
            x1={plot.x}
            x2={plot.x + plot.width}
            y1={tick.position}
            y2={tick.position}
            stroke={tick.baseline ? colors.guide : colors.grid}
            opacity={tick.baseline ? 0.45 : 1}
          />
          <SvgText
            x={plot.x - 8}
            y={tick.position + 4}
            textAnchor="end"
            fill={colors.label}
            fontSize={11}
          >
            {tick.label}
          </SvgText>
        </G>
      ))}
      {scene.guide === "line" && target ? (
        <Line
          x1={target.anchor.x}
          x2={target.anchor.x}
          y1={plot.y}
          y2={plot.y + plot.height}
          stroke={colors.guide}
          strokeDasharray="3 4"
        />
      ) : null}
      {scene.marks.map((mark) => (
        <Mark key={markKey(mark)} mark={mark} selected={selected} colors={colors} />
      ))}
    </Svg>
  );
}

const ThemedScenePainter = withUnistyles(ScenePainter);
const mapSceneColors = (theme: Theme) => ({ colors: sceneColors(theme) });

export function SceneCanvas({ scene, selected }: { scene: ChartScene; selected: number }) {
  return <ThemedScenePainter scene={scene} selected={selected} uniProps={mapSceneColors} />;
}

function Sparkline({
  points,
  width,
  height,
  color,
}: {
  points: readonly Point[];
  width: number;
  height: number;
  color?: string;
}) {
  if (!color) return null;
  const last = points[points.length - 1];
  return (
    <Svg width={width} height={height} aria-hidden>
      <Polyline
        points={pointList(points)}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <Circle cx={last.x} cy={last.y} r={2} fill={color} />
    </Svg>
  );
}

export const ThemedSparkline = withUnistyles(Sparkline);
