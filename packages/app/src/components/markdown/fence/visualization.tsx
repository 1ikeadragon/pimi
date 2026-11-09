import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo, Text, View, type LayoutChangeEvent } from "react-native";
import Svg, { Circle, G, Line, Polyline, Rect, Text as SvgText } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import type { ChatVisualization } from "@pimi/protocol/chat-visualization";
import { Button } from "@/components/ui/button";
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
  onSelect,
}: {
  chart: ChatVisualization;
  colors?: ChartColors;
  width: number;
  selected: number;
  onSelect: (index: number) => void;
}) {
  const transition = useChartTransition(chart);
  const selectPoint = useMemo(
    () => chart.labels.map((_, index) => () => onSelect(index)),
    [chart.labels, onSelect],
  );
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
      {chart.labels.map((label, index) => (
        <Rect
          key={label}
          x={AXIS_WIDTH + index * step}
          y={0}
          width={step}
          height={PLOT_HEIGHT}
          fill="transparent"
          onPress={selectPoint[index]}
        />
      ))}
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

export function Visualization({ chart }: { chart: ChatVisualization }) {
  const { t } = useTranslation();
  const [width, setWidth] = useState(0);
  const [index, setIndex] = useState(0);
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
          onSelect={setIndex}
          uniProps={mapChartColors}
        />
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

const styles = StyleSheet.create((theme) => ({
  card: {
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  header: { flexDirection: "row", alignItems: "baseline", flexWrap: "wrap", gap: theme.spacing[2] },
  plot: { height: PLOT_HEIGHT, alignSelf: "stretch" },
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
  caption: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, flexShrink: 1 },
  number: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
    flexShrink: 1,
  },
}));
