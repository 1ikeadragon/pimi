import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo, Text, View, type LayoutChangeEvent } from "react-native";
import Svg, {
  Circle,
  G,
  Line,
  Path,
  Polygon,
  Polyline,
  Rect,
  Text as SvgText,
} from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import type { ChatVisualization } from "@pimi/protocol/chat-visualization";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isWeb } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";

const PLOT_HEIGHT = 164;
const AXIS_WIDTH = 52;
const PLOT_INSET = 8;
const GRID_STEPS = 4;
const MIN_LABEL_WIDTH = 64;
// A brief, bounded transition; exact readouts always show the current snapshot.
const TRANSITION_MS = 240;

function useChartTransition(chart: ChatVisualization) {
  const source = JSON.stringify(chart);
  const snapshot = useMemo(() => JSON.parse(source) as ChatVisualization, [source]);
  const previous = useRef<ChatVisualization | null>(null);
  const [reduceMotion, setReduceMotion] = useState<boolean | null>(null);
  const [transition, setTransition] = useState({
    previous: null as ChatVisualization | null,
    progress: 1,
  });
  useEffect(() => {
    let active = true;
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    async function readMotionPreference() {
      try {
        const enabled = await AccessibilityInfo.isReduceMotionEnabled();
        if (active) setReduceMotion(enabled);
      } catch {
        if (active) setReduceMotion(true);
      }
    }
    void readMotionPreference();
    return () => {
      active = false;
      subscription?.remove();
    };
  }, []);
  useEffect(() => {
    // Until the platform preference is known, show exact data without movement.
    if (reduceMotion === null) return;
    const from = previous.current;
    previous.current = snapshot;
    if (reduceMotion) {
      setTransition({ previous: from, progress: 1 });
      return;
    }
    let frame = 0;
    const start = performance.now();
    setTransition({ previous: from, progress: 0 });
    const advance = (now: number) => {
      const elapsed = Math.min(1, Math.max(0, (now - start) / TRANSITION_MS));
      setTransition({ previous: from, progress: 1 - (1 - elapsed) ** 3 });
      if (elapsed < 1) frame = requestAnimationFrame(advance);
    };
    frame = requestAnimationFrame(advance);
    return () => cancelAnimationFrame(frame);
  }, [snapshot, reduceMotion]);
  return transition;
}

function chartColors(theme: Theme) {
  const { colors, colorScheme } = theme;
  return {
    foreground: colors.foregroundMuted,
    grid: colors.border,
    guide: colors.foregroundMuted,
    series: [
      colors.accent,
      colors.palette.blue[colorScheme === "dark" ? 300 : 700],
      colors.statusWarning,
      colors.statusMerged,
    ],
  };
}

type ChartColors = ReturnType<typeof chartColors>;

function formatTick(value: number): string {
  const [mantissa, exponent] = value.toPrecision(3).split("e");
  const number = Number(mantissa).toString();
  return exponent === undefined ? number : `${number}e${exponent}`;
}

function ChartPlot({
  chart,
  colors,
  width,
  selected,
}: {
  chart: ChatVisualization;
  colors?: ChartColors;
  width: number;
  selected: number;
}) {
  const transition = useChartTransition(chart);
  if (!colors || width <= AXIS_WIDTH + PLOT_INSET) return null;
  const data = chart.series.flatMap(({ values }) => values);
  // Scale first so a valid finite input spanning both numeric extremes can still be plotted.
  const scale = Math.max(...data.map(Math.abs)) || 1;
  const min = Math.min(0, ...data) / scale;
  const max = Math.max(0, ...data) / scale;
  const range = max - min || 1;
  const step = (width - AXIS_WIDTH - PLOT_INSET) / chart.labels.length;
  const plotBottom = PLOT_HEIGHT - PLOT_INSET;
  const plotHeight = plotBottom - PLOT_INSET;
  const x = (index: number) => AXIS_WIDTH + step * (index + 0.5);
  const y = (value: number) => plotBottom - ((value - min) / range) * plotHeight;
  const zero = y(0);
  const previousLabels = transition.previous?.labels ?? [];
  const previousSeries = new Map(
    transition.previous?.series.map((series) => [series.name, series]),
  );
  const animatedY = (name: string, value: number, index: number) => {
    const oldIndex = previousLabels.indexOf(chart.labels[index]);
    const from = previousSeries.get(name)?.values[oldIndex] ?? 0;
    // Normalize before interpolation: subtracting finite numeric extremes can overflow.
    const start = Math.max(min, Math.min(max, from / scale));
    const normalized = start * (1 - transition.progress) + (value / scale) * transition.progress;
    return y(Math.max(min, Math.min(max, normalized)));
  };
  const barWidth = Math.min((step * 0.75) / chart.series.length, 24);
  const ticks = [0];
  if (min !== max) {
    const tickStep = range / GRID_STEPS;
    for (let index = 0; index <= GRID_STEPS; index++) {
      const tick = min + index * tickStep;
      // Leave room for the baseline label when a regular tick would nearly overlap it.
      if (Math.abs(tick) >= tickStep / 2) ticks.push(tick);
    }
  }

  return (
    <Svg width={width} height={PLOT_HEIGHT} accessible={false}>
      {ticks.map((tick) => (
        <G key={tick}>
          <Line
            x1={AXIS_WIDTH}
            x2={width - PLOT_INSET}
            y1={y(tick)}
            y2={y(tick)}
            stroke={tick === 0 ? colors.guide : colors.grid}
            opacity={tick === 0 ? 0.45 : 1}
          />
          <SvgText
            x={AXIS_WIDTH - PLOT_INSET}
            y={y(tick) + 4}
            textAnchor="end"
            fill={colors.foreground}
            fontSize={10}
          >
            {formatTick(Math.min(max, Math.max(min, tick)) * scale)}
          </SvgText>
        </G>
      ))}
      <Line
        x1={x(selected)}
        x2={x(selected)}
        y1={PLOT_INSET}
        y2={plotBottom}
        stroke={colors.guide}
        strokeDasharray="3 4"
      />
      {chart.series.map(({ name, values }, seriesIndex) => {
        const color = colors.series[seriesIndex];
        if (chart.type === "bar") {
          return (
            <G key={name}>
              {values.map((value, index) => {
                const end = animatedY(name, value, index);
                return (
                  <Rect
                    key={chart.labels[index]}
                    x={x(index) + (seriesIndex - chart.series.length / 2) * barWidth}
                    y={Math.min(zero, end)}
                    width={barWidth * 0.86}
                    height={Math.abs(end - zero)}
                    fill={color}
                    opacity={index === selected ? 1 : 0.72}
                    rx={Math.min(3, barWidth / 3)}
                  />
                );
              })}
            </G>
          );
        }
        return (
          <G key={name}>
            {chart.type === "area" ? (
              <Polygon
                points={`${x(0)},${zero} ${values
                  .map((value, index) => `${x(index)},${animatedY(name, value, index)}`)
                  .join(" ")} ${x(values.length - 1)},${zero}`}
                fill={color}
                opacity={0.16}
              />
            ) : null}
            <Polyline
              points={values
                .map((value, index) => `${x(index)},${animatedY(name, value, index)}`)
                .join(" ")}
              fill="none"
              stroke={color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            <Circle
              cx={x(selected)}
              cy={animatedY(name, values[selected], selected)}
              r={4}
              fill={color}
            />
          </G>
        );
      })}
    </Svg>
  );
}

const ThemedChartPlot = withUnistyles(ChartPlot);
const mapChartColors = (theme: Theme) => ({ colors: chartColors(theme) });

function ChartValues({
  chart,
  selected,
  colors,
}: {
  chart: ChatVisualization;
  selected: number;
  colors?: ChartColors;
}) {
  return (
    <View style={styles.values}>
      {chart.series.map(({ name, values }, index) => (
        <View key={name} style={styles.value}>
          <Svg width={8} height={8} accessible={false}>
            <Circle cx={4} cy={4} r={4} fill={colors?.series[index]} />
          </Svg>
          <Text style={styles.caption}>{name}</Text>
          <Text selectable style={styles.number}>
            {values[selected].toString()}
          </Text>
        </View>
      ))}
    </View>
  );
}

const ThemedChartValues = withUnistyles(ChartValues);

function ChartPoint({
  chart,
  index,
  width,
  open,
  onSelect,
  onInspect,
}: {
  chart: ChatVisualization;
  index: number;
  width: number;
  open: boolean;
  onSelect: (index: number) => void;
  onInspect: (label: string, open: boolean) => void;
}) {
  const label = chart.labels[index];
  const [focused, setFocused] = useState(false);
  const select = useCallback(() => onSelect(index), [index, onSelect]);
  const focus = useCallback(() => {
    setFocused(true);
    select();
  }, [select]);
  const blur = useCallback(() => setFocused(false), []);
  const inspect = useCallback((next: boolean) => onInspect(label, next), [label, onInspect]);
  const description = [
    label,
    ...chart.series.map(
      ({ name, values }) => `${name}: ${values[index]}${chart.unit ? ` ${chart.unit}` : ""}`,
    ),
  ].join(". ");
  return (
    <Tooltip open={open} onOpenChange={inspect}>
      <TooltipTrigger
        accessibilityRole="button"
        accessibilityLabel={description}
        testID={`chat-visualization-point-${index}`}
        onHoverIn={select}
        onFocus={focus}
        onBlur={blur}
        onPress={select}
        style={[
          styles.point,
          inlineUnistylesStyle({ left: AXIS_WIDTH + index * width, width }),
          focused && styles.pointFocused,
        ]}
      />
      <TooltipContent testID="chat-visualization-tooltip">
        <View style={styles.selection}>
          <Text style={styles.title}>
            {label}
            {chart.unit ? ` · ${chart.unit}` : ""}
          </Text>
          <ThemedChartValues chart={chart} selected={index} uniProps={mapChartColors} />
        </View>
      </TooltipContent>
    </Tooltip>
  );
}

function CartesianVisualization({ chart }: { chart: ChatVisualization }) {
  const { t } = useTranslation();
  const [width, setWidth] = useState(0);
  const [index, setIndex] = useState(0);
  const [inspectedLabel, setInspectedLabel] = useState<string | null>(null);
  const openLabel = chart.labels.includes(inspectedLabel ?? "") ? inspectedLabel : null;
  const inspect = useCallback((label: string, open: boolean) => {
    setInspectedLabel((current) => {
      if (open) return label;
      return current === label ? null : current;
    });
  }, []);
  useEffect(() => {
    if (!isWeb || openLabel === null) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setInspectedLabel(null);
    };
    window.addEventListener("keydown", dismiss, true);
    return () => window.removeEventListener("keydown", dismiss, true);
  }, [openLabel]);
  const last = chart.labels.length - 1;
  const selected = Math.min(index, last);
  const labelWidth = Math.max(0, width - AXIS_WIDTH - PLOT_INSET) / chart.labels.length;
  const showAllLabels = last === 0 || labelWidth >= MIN_LABEL_WIDTH;
  const measurePlot = useCallback(({ nativeEvent }: LayoutChangeEvent) => {
    setWidth(Math.floor(nativeEvent.layout.width));
  }, []);
  const previous = useCallback(() => setIndex(Math.max(0, selected - 1)), [selected]);
  const next = useCallback(() => setIndex(Math.min(last, selected + 1)), [last, selected]);

  return (
    <View style={styles.card} testID="chat-visualization">
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.title}>
          {chart.title}
        </Text>
        {chart.unit ? <Text style={styles.caption}>{chart.unit}</Text> : null}
      </View>
      <View style={styles.plot} onLayout={measurePlot}>
        <ThemedChartPlot
          chart={chart}
          selected={selected}
          width={width}
          uniProps={mapChartColors}
        />
        {labelWidth > 0 &&
          chart.labels.map((label, point) => (
            <ChartPoint
              key={label}
              chart={chart}
              index={point}
              width={labelWidth}
              open={openLabel === label}
              onSelect={setIndex}
              onInspect={inspect}
            />
          ))}
      </View>
      <View
        style={[
          styles.axisLabels,
          !showAllLabels &&
            inlineUnistylesStyle({
              paddingLeft: AXIS_WIDTH + labelWidth / 2,
              paddingRight: PLOT_INSET + labelWidth / 2,
            }),
        ]}
      >
        {showAllLabels ? (
          chart.labels.map((label) => (
            <Text key={label} style={[styles.caption, styles.axisLabel]} numberOfLines={1}>
              {label}
            </Text>
          ))
        ) : (
          <>
            <Text style={styles.caption} numberOfLines={1}>
              {chart.labels[0]}
            </Text>
            <Text style={styles.caption} numberOfLines={1}>
              {chart.labels[last]}
            </Text>
          </>
        )}
      </View>
      <View style={styles.detail}>
        <View style={styles.selection} accessibilityLiveRegion="polite">
          <Text style={styles.title}>{chart.labels[selected]}</Text>
          <ThemedChartValues chart={chart} selected={selected} uniProps={mapChartColors} />
        </View>
        {last > 0 ? (
          <View style={styles.controls}>
            <Button
              variant="ghost"
              size="sm"
              leftIcon={ChevronLeft}
              disabled={selected === 0}
              accessibilityLabel={t("message.visualization.previous")}
              onPress={previous}
            />
            <Button
              variant="ghost"
              size="sm"
              leftIcon={ChevronRight}
              disabled={selected === last}
              accessibilityLabel={t("message.visualization.next")}
              onPress={next}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}

// Normalize before summing so even several Number.MAX_VALUE slices remain finite.
function sliceFractions(chart: ChatVisualization): number[] {
  const values = chart.series[0].values;
  const scale = Math.max(...values);
  const normalized = values.map((value) => value / scale);
  const total = normalized.reduce((sum, value) => sum + value, 0);
  return normalized.map((value) => value / total);
}

function formatPercent(fraction: number, value: number): string {
  if (value > 0 && fraction < 0.0001) return "<0.01%";
  return `${Number((fraction * 100).toFixed(2))}%`;
}

const RADIAL_SIZE = 184;
const RADIAL_RADIUS = 84;
const RADIAL_CENTER = RADIAL_SIZE / 2;

function slicePath(start: number, fraction: number, innerRadius: number): string {
  const end = start + fraction * Math.PI * 2;
  const middle = (start + end) / 2;
  const point = (angle: number, radius: number) =>
    `${RADIAL_CENTER + Math.sin(angle) * radius},${RADIAL_CENTER - Math.cos(angle) * radius}`;
  // Two arcs also represent a full circle, where a single SVG arc has coincident ends.
  const outer = `M${point(start, RADIAL_RADIUS)} A${RADIAL_RADIUS},${RADIAL_RADIUS} 0 0 1 ${point(
    middle,
    RADIAL_RADIUS,
  )} A${RADIAL_RADIUS},${RADIAL_RADIUS} 0 0 1 ${point(end, RADIAL_RADIUS)}`;
  return innerRadius > 0
    ? `${outer} L${point(end, innerRadius)} A${innerRadius},${innerRadius} 0 0 0 ${point(
        middle,
        innerRadius,
      )} A${innerRadius},${innerRadius} 0 0 0 ${point(start, innerRadius)} Z`
    : `${outer} L${RADIAL_CENTER},${RADIAL_CENTER} Z`;
}

function RadialSlice({
  path,
  index,
  label,
  selected,
  colors,
  onSelect,
  onInspect,
}: {
  path: string;
  index: number;
  label: string;
  selected: boolean;
  colors?: ChartColors;
  onSelect: (index: number) => void;
  onInspect: (label: string, open: boolean) => void;
}) {
  const select = useCallback(() => onSelect(index), [index, onSelect]);
  const hover = useCallback(
    (event: { pointerType: string }) => {
      if (event.pointerType === "touch") return;
      select();
      onInspect(label, true);
    },
    [label, onInspect, select],
  );
  const leave = useCallback(() => onInspect(label, false), [label, onInspect]);
  return (
    <Path
      testID={`chat-visualization-slice-${index}`}
      d={path}
      fill={colors?.series[index % colors.series.length]}
      opacity={selected ? 1 : 0.72}
      stroke={colors?.grid}
      strokeWidth={1.5}
      onPress={select}
      {...(isWeb ? { onPointerEnter: hover, onPointerLeave: leave } : null)}
    />
  );
}

function RadialPlot({
  chart,
  colors,
  selected,
  onSelect,
  onInspect,
}: {
  chart: ChatVisualization;
  colors?: ChartColors;
  selected: number;
  onSelect: (index: number) => void;
  onInspect: (label: string, open: boolean) => void;
}) {
  const transition = useChartTransition(chart);
  const fractions = sliceFractions(chart);
  const from = transition.previous;
  const previous =
    from && (from.type === "pie" || from.type === "donut") ? sliceFractions(from) : [];
  let start = 0;
  return (
    <Svg width={RADIAL_SIZE} height={RADIAL_SIZE} accessible={false}>
      {fractions.map((fraction, index) => {
        const label = chart.labels[index];
        const oldIndex = from?.labels.indexOf(label) ?? -1;
        const animated =
          (previous[oldIndex] ?? 0) * (1 - transition.progress) + fraction * transition.progress;
        const path = slicePath(start, animated, chart.type === "donut" ? RADIAL_RADIUS * 0.58 : 0);
        start += animated * Math.PI * 2;
        if (animated <= 0) return null;
        return (
          <RadialSlice
            key={label}
            path={path}
            index={index}
            label={label}
            selected={selected === index}
            colors={colors}
            onSelect={onSelect}
            onInspect={onInspect}
          />
        );
      })}
    </Svg>
  );
}

const ThemedRadialPlot = withUnistyles(RadialPlot);

function SliceLegendItem({
  chart,
  index,
  fraction,
  selected,
  colors,
  onSelect,
}: {
  chart: ChatVisualization;
  index: number;
  fraction: number;
  selected: boolean;
  colors?: ChartColors;
  onSelect: (index: number) => void;
}) {
  const [focused, setFocused] = useState(false);
  const value = chart.series[0].values[index].toString();
  const percent = formatPercent(fraction, chart.series[0].values[index]);
  const [hovered, setHovered] = useState(false);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  const select = useCallback(() => onSelect(index), [index, onSelect]);
  const focus = useCallback(() => {
    setFocused(true);
    select();
  }, [select]);
  const blur = useCallback(() => setFocused(false), []);
  const hover = useCallback(() => setHovered(true), []);
  const leave = useCallback(() => setHovered(false), []);
  return (
    <PressHighlight
      testID={`chat-visualization-slice-legend-${index}`}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      accessibilityLabel={`${chart.labels[index]}. ${value}${
        chart.unit ? ` ${chart.unit}` : ""
      }. ${percent}`}
      onPress={select}
      onFocus={focus}
      onBlur={blur}
      onHoverIn={hover}
      onHoverOut={leave}
      highlightStyle={styles.sliceSelected}
      style={[
        styles.sliceLegend,
        (selected || hovered) && styles.sliceSelected,
        focused && styles.pointFocused,
      ]}
    >
      <Svg width={8} height={8} accessible={false}>
        <Circle cx={4} cy={4} r={4} fill={colors?.series[index % colors.series.length]} />
      </Svg>
      <Text style={[styles.caption, styles.sliceLabel]}>{chart.labels[index]}</Text>
      <Text style={styles.number}>{value}</Text>
      <Text style={styles.caption}>{percent}</Text>
    </PressHighlight>
  );
}

const ThemedSliceLegendItem = withUnistyles(SliceLegendItem);

function RadialVisualization({ chart }: { chart: ChatVisualization }) {
  const [index, setIndex] = useState(0);
  const [inspectedLabel, setInspectedLabel] = useState<string | null>(null);
  const selected = Math.min(index, chart.labels.length - 1);
  const inspected = chart.labels.indexOf(inspectedLabel ?? "");
  const fractions = sliceFractions(chart);
  const inspect = useCallback((label: string, open: boolean) => {
    setInspectedLabel((current) => {
      if (open) return label;
      return current === label ? null : current;
    });
  }, []);
  const changeOpen = useCallback((open: boolean) => {
    if (!open) setInspectedLabel(null);
  }, []);
  useEffect(() => {
    if (!isWeb || inspected < 0) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setInspectedLabel(null);
    };
    window.addEventListener("keydown", dismiss, true);
    return () => window.removeEventListener("keydown", dismiss, true);
  }, [inspected]);
  const details = (point: number) => (
    <View style={styles.selection}>
      <Text style={styles.title}>{chart.labels[point]}</Text>
      <Text selectable style={styles.number}>
        {chart.series[0].values[point].toString()}
        {chart.unit ? ` ${chart.unit}` : ""} ·{" "}
        {formatPercent(fractions[point], chart.series[0].values[point])}
      </Text>
    </View>
  );
  return (
    <View style={styles.card} testID="chat-visualization">
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.title}>
          {chart.title}
        </Text>
        {chart.unit ? <Text style={styles.caption}>{chart.unit}</Text> : null}
      </View>
      <View style={styles.radialPlot}>
        <Tooltip open={inspected >= 0} onOpenChange={changeOpen}>
          {/* The SVG paths handle hit testing; this noninteractive anchor positions the shared tooltip. */}
          <TooltipTrigger
            disabled
            accessible={false}
            pointerEvents="none"
            style={styles.radialAnchor}
          />
          <ThemedRadialPlot
            chart={chart}
            selected={selected}
            onSelect={setIndex}
            onInspect={inspect}
            uniProps={mapChartColors}
          />
          <TooltipContent testID="chat-visualization-tooltip">
            {inspected >= 0 ? details(inspected) : null}
          </TooltipContent>
        </Tooltip>
      </View>
      <Text style={styles.caption}>{chart.series[0].name}</Text>
      <View>
        {chart.labels.map((label, point) => (
          <ThemedSliceLegendItem
            key={label}
            chart={chart}
            index={point}
            fraction={fractions[point]}
            selected={selected === point}
            onSelect={setIndex}
            uniProps={mapChartColors}
          />
        ))}
      </View>
      <View style={styles.detail} accessibilityLiveRegion="polite">
        {details(selected)}
      </View>
    </View>
  );
}

export function Visualization({ chart }: { chart: ChatVisualization }) {
  return chart.type === "pie" || chart.type === "donut" ? (
    <RadialVisualization chart={chart} />
  ) : (
    <CartesianVisualization chart={chart} />
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  radialPlot: { width: RADIAL_SIZE, height: RADIAL_SIZE, alignSelf: "center" },
  radialAnchor: {
    position: "absolute",
    top: 0,
    left: 0,
    width: RADIAL_SIZE,
    height: RADIAL_SIZE,
  },
  sliceLegend: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[2],
    borderWidth: 1,
    borderColor: "transparent",
    borderRadius: theme.borderRadius.sm,
  },
  sliceSelected: { backgroundColor: theme.colors.surface2 },
  sliceLabel: { flex: 1, minWidth: 0 },
  header: {
    flexDirection: "row",
    alignItems: "baseline",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  plot: { height: PLOT_HEIGHT, alignSelf: "stretch" },
  // Full-height targets keep zero values and small line markers inspectable.
  point: {
    position: "absolute",
    top: 0,
    bottom: 0,
    borderWidth: 1,
    borderColor: "transparent",
  },
  pointFocused: {
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.sm,
  },
  axisLabels: {
    direction: "ltr",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingLeft: AXIS_WIDTH,
    paddingRight: PLOT_INSET,
  },
  axisLabel: { flex: 1, minWidth: 0, textAlign: "center" },
  detail: {
    flexDirection: "row",
    alignItems: "center",
    borderTopWidth: 1,
    borderColor: theme.colors.border,
    paddingTop: theme.spacing[2],
    gap: theme.spacing[2],
  },
  controls: { flexDirection: "row" },
  selection: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  values: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  value: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1],
    maxWidth: "100%",
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    flexShrink: 1,
  },
  caption: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
  number: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
    flexShrink: 1,
  },
}));
