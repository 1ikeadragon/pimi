import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo, Text, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import type { ChartNode } from "@pimi/protocol/chat-view";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { SceneInteraction, useInspection } from "./interaction";
import { SceneCanvas } from "./painter";
import {
  CARTESIAN_HEIGHT,
  RADIAL_SIZE,
  buildChartScene,
  hitTestScene,
  isRadialChart,
  legendKeys,
  type ChartScene,
  type ChartTransition,
  type SceneLegendEntry,
  type SceneTarget,
} from "./scene";

// A brief, bounded transition; exact readouts always show the current snapshot.
const TRANSITION_MS = 240;
const AXIS_LABEL_HEIGHT = 16;
const NOTHING_HIDDEN: ReadonlySet<string> = new Set();

function useChartTransition(chart: ChartNode): ChartTransition {
  const source = JSON.stringify(chart);
  const snapshot = useMemo<ChartNode>(() => JSON.parse(source), [source]);
  const previous = useRef<ChartNode | null>(null);
  const [reduceMotion, setReduceMotion] = useState<boolean | null>(null);
  const [transition, setTransition] = useState<ChartTransition>({ previous: null, progress: 1 });
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

function Swatch({ slot, hidden = false }: { slot: number; hidden?: boolean }) {
  // Read at render: Unistyles styles must not be collected at module scope.
  const fills = [
    styles.series0,
    styles.series1,
    styles.series2,
    styles.series3,
    styles.series4,
    styles.series5,
    styles.series6,
    styles.series7,
  ];
  return <View style={[styles.swatch, fills[slot % fills.length], hidden && styles.swatchOff]} />;
}

function Readout({ target, unit }: { target: SceneTarget; unit?: string }) {
  return (
    <View style={styles.readout}>
      <Text style={styles.title}>
        {target.title}
        {unit ? ` · ${unit}` : ""}
      </Text>
      <View style={styles.values}>
        {target.readouts.map(({ slot, name, value, share }) => (
          <View key={name} style={styles.value}>
            <Swatch slot={slot} />
            <Text style={styles.caption}>{name}</Text>
            <Text selectable style={styles.number}>
              {value}
            </Text>
            {share ? <Text style={styles.caption}>{share}</Text> : null}
          </View>
        ))}
      </View>
    </View>
  );
}

function LegendToggle({
  entry,
  index,
  detailed,
  locked,
  onToggle,
  onFocusEntry,
}: {
  entry: SceneLegendEntry;
  index: number;
  /** A slice row also shows its value and share. */
  detailed: boolean;
  /** The last visible entry cannot be switched off. */
  locked: boolean;
  onToggle: (key: string) => void;
  onFocusEntry: (key: string) => void;
}) {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const accessibilityState = useMemo(
    () => ({ checked: !entry.hidden, disabled: locked }),
    [entry.hidden, locked],
  );
  const toggle = useCallback(() => onToggle(entry.key), [entry.key, onToggle]);
  const focus = useCallback(() => {
    setFocused(true);
    onFocusEntry(entry.key);
  }, [entry.key, onFocusEntry]);
  const blur = useCallback(() => setFocused(false), []);
  const hover = useCallback(() => setHovered(true), []);
  const leave = useCallback(() => setHovered(false), []);
  return (
    <PressHighlight
      testID={`chat-visualization-legend-${index}`}
      accessibilityRole="checkbox"
      accessibilityState={accessibilityState}
      accessibilityLabel={entry.key}
      disabled={locked}
      onPress={toggle}
      onFocus={focus}
      onBlur={blur}
      onHoverIn={hover}
      onHoverOut={leave}
      highlightStyle={styles.legendActive}
      style={[
        styles.legendEntry,
        detailed && styles.legendRow,
        hovered && !locked && styles.legendActive,
        focused && styles.focused,
      ]}
    >
      <Swatch slot={entry.slot} hidden={entry.hidden} />
      <Text
        numberOfLines={1}
        style={[styles.caption, detailed && styles.legendLabel, entry.hidden && styles.off]}
      >
        {entry.key}
      </Text>
      {detailed ? (
        <Text style={[styles.number, entry.hidden && styles.off]}>{entry.value}</Text>
      ) : null}
      {detailed && entry.share ? <Text style={styles.caption}>{entry.share}</Text> : null}
    </PressHighlight>
  );
}

function AxisLabels({ scene }: { scene: ChartScene }) {
  return (
    <View style={styles.axisLabels}>
      {scene.xLabels.map(({ x, width, text }) => (
        <Text
          key={`${x}:${text}`}
          numberOfLines={1}
          style={[
            styles.axisLabel,
            inlineUnistylesStyle({
              left: Math.max(0, Math.min(scene.width - width, x - width / 2)),
              width,
            }),
          ]}
        >
          {text}
        </Text>
      ))}
    </View>
  );
}

/** A chart without a frame, for use inside a view or a card. */
export function ChartView({ chart }: { chart: ChartNode }) {
  const { t } = useTranslation();
  const [width, setWidth] = useState(0);
  const [switchedOff, setSwitchedOff] = useState(NOTHING_HIDDEN);
  const [index, setIndex] = useState(0);
  const transition = useChartTransition(chart);

  const keys = useMemo(() => legendKeys(chart), [chart]);
  // An update can rename or drop what was switched off; never leave a chart with nothing shown.
  const hidden = useMemo(() => {
    const present = new Set(keys.filter((key) => switchedOff.has(key)));
    return present.size < keys.length ? present : NOTHING_HIDDEN;
  }, [keys, switchedOff]);
  const scene = useMemo(
    () => buildChartScene({ chart, width, hidden, transition }),
    [chart, hidden, transition, width],
  );

  const last = scene.targets.length - 1;
  const selected = Math.min(index, last);
  const { inspected, inspect } = useInspection(scene.targets);
  const hitTest = useCallback((x: number, y: number) => hitTestScene(scene, x, y), [scene]);
  const popoverUnit = isRadialChart(chart) ? undefined : chart.unit;
  const renderPopover = useCallback(
    (target: number) => <Readout target={scene.targets[target]} unit={popoverUnit} />,
    [popoverUnit, scene.targets],
  );
  const bounds = useMemo(
    () => ({ width: scene.width, height: scene.height }),
    [scene.height, scene.width],
  );
  const radial = isRadialChart(chart) ? chart : null;
  const isRadial = radial !== null;
  const axes = isRadialChart(chart) ? null : chart;
  const visibleCount = keys.length - hidden.size;

  const measure = useCallback(({ nativeEvent }: LayoutChangeEvent) => {
    const measured = Math.floor(nativeEvent.layout.width);
    // A hidden retained panel reports zero; keep the last real width.
    if (measured > 0) setWidth(measured);
  }, []);
  const toggle = useCallback(
    (key: string) => {
      setSwitchedOff((current) => {
        const next = new Set(current);
        if (next.delete(key)) return next;
        const shown = keys.filter((candidate) => !current.has(candidate));
        return shown.length > 1 ? next.add(key) : current;
      });
    },
    [keys],
  );
  const selectEntry = useCallback(
    (key: string) => {
      const target = scene.targets.findIndex((candidate) => candidate.key === key);
      if (target >= 0) setIndex(target);
    },
    [scene.targets],
  );
  const previous = useCallback(() => setIndex(Math.max(0, selected - 1)), [selected]);
  const next = useCallback(() => setIndex(Math.min(last, selected + 1)), [last, selected]);

  const legend = scene.legend.map((entry, position) => (
    <LegendToggle
      key={entry.key}
      entry={entry}
      index={position}
      detailed={isRadial}
      locked={!entry.hidden && visibleCount <= 1}
      onToggle={toggle}
      onFocusEntry={selectEntry}
    />
  ));
  const plotSize = isRadial
    ? { width: Math.min(width || RADIAL_SIZE, RADIAL_SIZE), height: RADIAL_SIZE }
    : { height: CARTESIAN_HEIGHT };

  return (
    <View style={styles.chart} testID="chat-visualization">
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.title}>
          {chart.title}
        </Text>
        {chart.unit ? <Text style={styles.caption}>{chart.unit}</Text> : null}
      </View>
      {!isRadial && scene.legend.length > 1 ? <View style={styles.legend}>{legend}</View> : null}
      {axes?.yLabel ? <Text style={styles.caption}>{axes.yLabel}</Text> : null}
      <View style={isRadial ? styles.radialBody : styles.body} onLayout={measure}>
        <View style={[styles.plot, inlineUnistylesStyle(plotSize)]}>
          <SceneCanvas scene={scene} selected={selected} />
          {width > 0 ? (
            <SceneInteraction
              targets={scene.targets}
              bounds={bounds}
              hitTest={hitTest}
              inspected={inspected}
              onSelect={setIndex}
              onInspect={inspect}
              renderPopover={renderPopover}
            />
          ) : null}
        </View>
        {radial ? (
          <View style={styles.slices}>
            <Text style={styles.caption}>{radial.series[0].name}</Text>
            {legend}
          </View>
        ) : null}
      </View>
      {isRadial ? null : <AxisLabels scene={scene} />}
      {axes?.xLabel ? <Text style={[styles.caption, styles.axisTitle]}>{axes.xLabel}</Text> : null}
      <View style={styles.detail}>
        <View style={styles.selection} accessibilityLiveRegion="polite">
          <Readout target={scene.targets[selected]} />
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
  chart: { gap: theme.spacing[2], minWidth: 0 },
  header: {
    flexDirection: "row",
    alignItems: "baseline",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[1] },
  legendEntry: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderWidth: 1,
    borderColor: "transparent",
    borderRadius: theme.borderRadius.md,
    maxWidth: "100%",
  },
  legendRow: { gap: theme.spacing[2], padding: theme.spacing[2] },
  legendLabel: { flex: 1, minWidth: 0 },
  legendActive: { backgroundColor: theme.colors.interactionHighlight },
  off: { opacity: theme.opacity[50] },
  body: { alignSelf: "stretch" },
  radialBody: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
  },
  slices: { flexGrow: 1, flexShrink: 1, flexBasis: 200, minWidth: 0 },
  // ltr: the plot is positioned in pixels from the left edge.
  plot: { direction: "ltr" },
  focused: {
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.sm,
  },
  axisLabels: { direction: "ltr", height: AXIS_LABEL_HEIGHT },
  axisLabel: {
    position: "absolute",
    top: 0,
    textAlign: "center",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  axisTitle: { textAlign: "center" },
  detail: {
    flexDirection: "row",
    alignItems: "center",
    borderTopWidth: 1,
    borderColor: theme.colors.border,
    paddingTop: theme.spacing[2],
    gap: theme.spacing[2],
  },
  controls: { flexDirection: "row" },
  selection: { flex: 1, minWidth: 0 },
  readout: { gap: theme.spacing[1] },
  values: {
    flexDirection: "row",
    flexWrap: "wrap",
    columnGap: theme.spacing[3],
    rowGap: theme.spacing[1],
  },
  value: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
    maxWidth: "100%",
  },
  swatch: { width: 8, height: 8, borderRadius: theme.borderRadius.full },
  swatchOff: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: theme.colors.foregroundMuted,
  },
  series0: { backgroundColor: theme.colors.chartSeries[0] },
  series1: { backgroundColor: theme.colors.chartSeries[1] },
  series2: { backgroundColor: theme.colors.chartSeries[2] },
  series3: { backgroundColor: theme.colors.chartSeries[3] },
  series4: { backgroundColor: theme.colors.chartSeries[4] },
  series5: { backgroundColor: theme.colors.chartSeries[5] },
  series6: { backgroundColor: theme.colors.chartSeries[6] },
  series7: { backgroundColor: theme.colors.chartSeries[7] },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
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
