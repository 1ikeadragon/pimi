import type { ChartNode } from "@pimi/protocol/chat-view";

/** A chart as geometry: what to paint, what can be selected, and what each selection reads out. */

export const CARTESIAN_HEIGHT = 180;
export const RADIAL_SIZE = 184;
/** The theme defines this many series colours; a slot past the last one wraps. */
export const SERIES_SLOTS = 8;

const PLOT_INSET = 8;
const TICK_INTERVALS = 4;
const TICK_CHARACTER_WIDTH = 6;
const MIN_AXIS_WIDTH = 28;
const MAX_AXIS_WIDTH = 64;
const SCATTER_AXIS_HEIGHT = 18;
const BAR_GROUP_SHARE = 0.72;
const MAX_BAR_WIDTH = 28;
/** Surface shown between neighbouring fills so they read as separate marks. */
const MARK_GAP = 2;
const POINT_HIT_RADIUS = 24;
const DONUT_HOLE = 0.58;

export interface Point {
  x: number;
  y: number;
}

export interface Box extends Point {
  width: number;
  height: number;
}

export interface SceneReadout {
  slot: number;
  name: string;
  value: string;
  share?: string;
}

/** Something the reader can select: a label's column, a scatter point, or a slice. */
export interface SceneTarget {
  /** Stable across updates of the same chart, so an open tooltip follows its datum. */
  key: string;
  title: string;
  readouts: SceneReadout[];
  description: string;
  anchor: Point;
  box: Box;
}

export type SceneMark =
  | { type: "bar"; path: string; slot: number; target: number }
  | { type: "line"; path: string; slot: number }
  | { type: "area"; path: string; slot: number }
  | { type: "point"; x: number; y: number; slot: number; target: number; whenSelected: boolean }
  | { type: "arc"; path: string; slot: number; target: number };

export interface SceneTick {
  position: number;
  label: string;
  baseline: boolean;
}

export interface SceneAxisLabel {
  x: number;
  width: number;
  text: string;
}

export interface SceneLegendEntry {
  key: string;
  slot: number;
  hidden: boolean;
  value?: string;
  share?: string;
}

type SceneHit =
  | { type: "bands"; left: number; step: number }
  | { type: "points" }
  | { type: "arcs"; center: number; inner: number; outer: number; spans: ArcSpan[] };

interface ArcSpan {
  start: number;
  end: number;
  target: number;
}

export interface ChartScene {
  width: number;
  height: number;
  plot: Box;
  yTicks: SceneTick[];
  xLabels: SceneAxisLabel[];
  /** How a selected target is marked across the plot. */
  guide: "line" | "band" | "none";
  marks: SceneMark[];
  targets: SceneTarget[];
  legend: SceneLegendEntry[];
  hit: SceneHit;
}

export interface ChartTransition {
  previous: ChartNode | null;
  /** 0 shows the previous chart's values, 1 the current ones. */
  progress: number;
}

export interface ChartSceneInput {
  chart: ChartNode;
  width: number;
  /** Legend keys the reader has switched off. */
  hidden: ReadonlySet<string>;
  transition?: ChartTransition;
}

type CartesianChart = Extract<ChartNode, { kind: "bar" | "line" | "area" }>;
type RadialChart = Extract<ChartNode, { kind: "pie" | "donut" }>;
type ScatterChart = Extract<ChartNode, { kind: "scatter" }>;

const SETTLED: ChartTransition = { previous: null, progress: 1 };

function niceStepFactor(ratio: number): number {
  if (ratio >= 7.5) return 10;
  if (ratio >= 3.5) return 5;
  if (ratio >= 1.5) return 2;
  return 1;
}

/**
 * Round tick values that cover `min` to `max`. Returns null when the range is empty or too
 * extreme for a finite step, and the caller then divides the range evenly.
 */
export function niceTicks(min: number, max: number, intervals = TICK_INTERVALS): number[] | null {
  const span = max - min;
  if (!(span > 0) || !Number.isFinite(span)) return null;
  const rough = span / intervals;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = niceStepFactor(rough / magnitude) * magnitude;
  if (!(step > 0) || !Number.isFinite(step)) return null;
  const first = Math.floor(min / step);
  const last = Math.ceil(max / step);
  const ticks: number[] = [];
  for (let index = first; index <= last; index++) {
    // Clears binary noise such as 0.30000000000000004 without moving a real tick.
    ticks.push(Number((index * step).toPrecision(12)));
  }
  return ticks.every(Number.isFinite) ? ticks : null;
}

function trimmed(value: number, digits: number): string {
  return Number(value.toPrecision(digits)).toString();
}

const TICK_SUFFIXES = [
  [1e12, "T"],
  [1e9, "B"],
  [1e6, "M"],
  [1e4, "K"],
] as const;

export function formatTick(value: number): string {
  const size = Math.abs(value);
  if (size === 0) return "0";
  if (size >= 1e15 || size < 1e-4) {
    const [mantissa, exponent] = value.toExponential(2).split("e");
    return `${Number(mantissa)}e${Number(exponent)}`;
  }
  for (const [threshold, suffix] of TICK_SUFFIXES) {
    if (size >= threshold) return `${trimmed(value / threshold, 4)}${suffix}`;
  }
  return trimmed(value, 6);
}

export function formatPercent(fraction: number, value: number): string {
  if (value > 0 && fraction < 0.0001) return "<0.01%";
  return `${Number((fraction * 100).toFixed(2))}%`;
}

/** Labels `value * scale` even when that product is past what a number can hold. */
function formatScaled(value: number, scale: number): string {
  const product = value * scale;
  if (Number.isFinite(product)) return formatTick(product);
  const valueExponent = Math.floor(Math.log10(Math.abs(value)));
  const scaleExponent = Math.floor(Math.log10(scale));
  const mantissa = (value / 10 ** valueExponent) * (scale / 10 ** scaleExponent);
  const carry = Math.abs(mantissa) >= 10 ? 1 : 0;
  return `${trimmed(mantissa / 10 ** carry, 3)}e${valueExponent + scaleExponent + carry}`;
}

interface Axis {
  min: number;
  max: number;
  ticks: { at: number; label: string }[];
}

/**
 * Values are divided by `scale` before any arithmetic, so finite inputs at both numeric
 * extremes still plot. `low` and `high` are in those scaled units.
 */
function buildAxis(low: number, high: number, scale: number): Axis {
  const nice = niceTicks(low * scale, high * scale);
  if (nice) {
    const ticks = nice.map((tick) => ({ at: tick / scale, label: formatTick(tick) }));
    return { min: ticks[0].at, max: ticks[ticks.length - 1].at, ticks };
  }
  const span = high - low;
  const ticks = Array.from({ length: TICK_INTERVALS + 1 }, (_, index) => {
    const at = low + (span * index) / TICK_INTERVALS;
    return { at, label: formatScaled(Math.max(low, Math.min(high, at)), scale) };
  });
  return { min: low, max: high, ticks };
}

function largestMagnitude(values: readonly number[]): number {
  let largest = 0;
  for (const value of values) largest = Math.max(largest, Math.abs(value));
  return largest || 1;
}

function extent(values: readonly number[]): [number, number] {
  let low = Infinity;
  let high = -Infinity;
  for (const value of values) {
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  return [low, high];
}

/** A range with no height still needs an axis: widen it to include zero, or to one unit. */
function widened([low, high]: [number, number]): [number, number] {
  if (low !== high) return [low, high];
  if (low === 0) return [0, 1];
  return [Math.min(0, low), Math.max(0, high)];
}

function axisWidth(axis: Axis): number {
  const longest = Math.max(...axis.ticks.map(({ label }) => label.length));
  return Math.max(
    MIN_AXIS_WIDTH,
    Math.min(MAX_AXIS_WIDTH, longest * TICK_CHARACTER_WIDTH + PLOT_INSET + 4),
  );
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/**
 * Path through the points as a monotone cubic (Fritsch-Carlson): the curve never rises above or
 * falls below the neighbouring points, so a series of non-negative values stays on or above zero
 * and flat runs stay flat. The points must run in one x direction.
 */
function smoothPath(points: readonly Point[]): string {
  const count = points.length;
  const start = `M${points[0].x},${points[0].y}`;
  if (count < 2) return start;
  const dx = points.slice(1).map((point, i) => point.x - points[i].x);
  const slope = points.slice(1).map((point, i) => (point.y - points[i].y) / dx[i]);
  const tangent = points.map((_, i) => {
    if (i === 0) return slope[0];
    if (i === count - 1) return slope[count - 2];
    return slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  });
  for (let i = 0; i < count - 1; i++) {
    if (slope[i] === 0) {
      tangent[i] = 0;
      tangent[i + 1] = 0;
      continue;
    }
    const a = tangent[i] / slope[i];
    const b = tangent[i + 1] / slope[i];
    const size = a * a + b * b;
    if (size > 9) {
      const scale = 3 / Math.sqrt(size);
      tangent[i] = scale * a * slope[i];
      tangent[i + 1] = scale * b * slope[i];
    }
  }
  let path = start;
  for (let i = 0; i < count - 1; i++) {
    const from = points[i];
    const to = points[i + 1];
    const third = dx[i] / 3;
    path += `C${round(from.x + third)},${round(from.y + tangent[i] * third)} ${round(
      to.x - third,
    )},${round(to.y - tangent[i + 1] * third)} ${to.x},${to.y}`;
  }
  return path;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function unitSuffix(chart: ChartNode): string {
  return chart.unit ? ` ${chart.unit}` : "";
}

interface VisibleSeries {
  slot: number;
  name: string;
  values: number[];
}

/** Values in scaled units, eased from the previous chart's value for the same series and label. */
function displayedValues(
  chart: CartesianChart,
  series: VisibleSeries,
  scale: number,
  transition: ChartTransition,
): number[] {
  const { previous, progress } = transition;
  if (progress >= 1) return series.values.map((value) => value / scale);
  const before = previous && previous.kind !== "scatter" ? previous : null;
  const earlier = before?.series.find(({ name }) => name === series.name);
  return series.values.map((value, index) => {
    const from = earlier?.values[before!.labels.indexOf(chart.labels[index])] ?? 0;
    // Scale before blending: subtracting finite numeric extremes can overflow.
    const start = clamp(from / scale, -1, 1);
    return start * (1 - progress) + (value / scale) * progress;
  });
}

interface StackedValue {
  from: number;
  to: number;
}

/**
 * Bars stack positive and negative values on their own sides of zero. Areas accumulate in
 * order, since a band has no side to switch to.
 */
function stackSeries(values: number[][], diverging: boolean): StackedValue[][] {
  const points = values[0].length;
  const above = Array.from({ length: points }, () => 0);
  const below = Array.from({ length: points }, () => 0);
  return values.map((row) =>
    row.map((value, index) => {
      const side = diverging && value < 0 ? below : above;
      const from = side[index];
      side[index] = from + value;
      return { from, to: side[index] };
    }),
  );
}

function baselineSeries(values: number[][]): StackedValue[][] {
  return values.map((row) => row.map((value) => ({ from: 0, to: value })));
}

function barPath(box: Box, rounded: "top" | "bottom" | "none"): string {
  const { x, y, width, height } = box;
  const radius = rounded === "none" ? 0 : Math.min(4, width / 2, height);
  const right = round(x + width);
  const bottom = round(y + height);
  if (radius <= 0) return `M${x},${y}H${right}V${bottom}H${x}Z`;
  if (rounded === "top") {
    return `M${x},${bottom}V${round(y + radius)}Q${x},${y} ${round(x + radius)},${y}H${round(
      right - radius,
    )}Q${right},${y} ${right},${round(y + radius)}V${bottom}Z`;
  }
  return `M${x},${y}H${right}V${round(bottom - radius)}Q${right},${bottom} ${round(
    right - radius,
  )},${bottom}H${round(x + radius)}Q${x},${bottom} ${x},${round(bottom - radius)}Z`;
}

// Labels are spaced by a fixed stride so the gaps between them are equal and none touch, and the
// stride counts back from the last label so the end of the range is always named. The first label
// is named too: it takes the place of the earliest stride label, which sits less than a stride
// from it.
function pickAxisLabels(labels: readonly string[], left: number, step: number): SceneAxisLabel[] {
  const longest = Math.max(...labels.map((label) => label.length));
  const preferred = clamp(longest * 7 + 14, 40, 96);
  const capacity = Math.max(1, Math.floor((step * labels.length) / preferred));
  const last = labels.length - 1;
  const stride = Math.max(1, Math.ceil(labels.length / capacity));
  const picked: number[] = [];
  for (let index = last; index >= 0; index -= stride) picked.unshift(index);
  picked[0] = 0;
  const width = step * stride;
  return picked.map((index) => ({
    x: round(left + step * (index + 0.5)),
    width: round(width),
    text: labels[index],
  }));
}

function buildCartesianScene(
  chart: CartesianChart,
  width: number,
  hidden: ReadonlySet<string>,
  transition: ChartTransition,
): ChartScene {
  const visible: VisibleSeries[] = chart.series.flatMap(({ name, values }, slot) =>
    hidden.has(name) ? [] : [{ slot, name, values }],
  );
  const scale = largestMagnitude(visible.flatMap(({ values }) => values));
  const stacked = chart.kind !== "line" && chart.stacked === true && visible.length > 1;
  const layout = (values: number[][]) => {
    if (!stacked) return baselineSeries(values);
    return stackSeries(values, chart.kind === "bar");
  };
  const settled = layout(visible.map(({ values }) => values.map((value) => value / scale)));
  const shown = layout(visible.map((series) => displayedValues(chart, series, scale, transition)));
  const [low, high] = extent([0, ...settled.flat().flatMap(({ from, to }) => [from, to])]);
  const axis = buildAxis(...widened([low, high]), scale);

  const left = axisWidth(axis);
  const plot: Box = {
    x: left,
    y: PLOT_INSET,
    width: Math.max(0, width - left - PLOT_INSET),
    height: CARTESIAN_HEIGHT - PLOT_INSET * 2,
  };
  const bottom = plot.y + plot.height;
  const step = plot.width / chart.labels.length;
  const x = (index: number) => round(plot.x + step * (index + 0.5));
  const y = (value: number) =>
    round(
      bottom -
        ((clamp(value, axis.min, axis.max) - axis.min) / (axis.max - axis.min)) * plot.height,
    );

  const marks: SceneMark[] = [];
  if (chart.kind === "bar") {
    const columns = stacked ? 1 : visible.length;
    const slotWidth = Math.min((step * BAR_GROUP_SHARE) / columns, MAX_BAR_WIDTH);
    const gap = slotWidth > MARK_GAP * 3 ? MARK_GAP : 0;
    shown.forEach((row, seriesIndex) => {
      const column = stacked ? 0 : seriesIndex;
      row.forEach(({ from, to }, index) => {
        const start = y(from);
        const end = y(to);
        const trim = stacked && Math.abs(end - start) > MARK_GAP * 2 ? MARK_GAP : 0;
        const rising = end <= start;
        const box: Box = {
          x: round(x(index) + (column - columns / 2) * slotWidth + gap / 2),
          y: rising ? end + trim : start,
          width: round(slotWidth - gap),
          height: Math.abs(end - start) - trim,
        };
        if (box.height <= 0) return;
        const direction = rising ? "top" : "bottom";
        marks.push({
          type: "bar",
          path: barPath(box, direction),
          slot: visible[seriesIndex].slot,
          target: index,
        });
      });
    });
  } else {
    shown.forEach((row, seriesIndex) => {
      const { slot } = visible[seriesIndex];
      const top = row.map(({ to }, index) => ({ x: x(index), y: y(to) }));
      if (chart.kind === "area") {
        // Traced back from the right so the polygon closes along the band's lower edge.
        const floor = row.map((_, index) => {
          const position = row.length - 1 - index;
          return { x: x(position), y: y(row[position].from) };
        });
        marks.push({
          type: "area",
          path: `${smoothPath(top)}L${floor[0].x},${floor[0].y}${smoothPath(floor).replace(/^M[^C]*/, "")}Z`,
          slot,
        });
      }
      marks.push({ type: "line", path: smoothPath(top), slot });
      top.forEach((point, target) => {
        marks.push({ type: "point", ...point, slot, target, whenSelected: row.length > 1 });
      });
    });
  }

  const suffix = unitSuffix(chart);
  const targets = chart.labels.map((label, index): SceneTarget => {
    const readouts = visible.map(({ slot, name, values }) => ({
      slot,
      name,
      value: values[index].toString(),
    }));
    return {
      key: label,
      title: label,
      readouts,
      description: [label, ...readouts.map(({ name, value }) => `${name}: ${value}${suffix}`)].join(
        ". ",
      ),
      anchor: { x: x(index), y: plot.y },
      // Full-height columns keep zero values and thin lines selectable.
      box: { x: round(plot.x + step * index), y: plot.y, width: round(step), height: plot.height },
    };
  });

  return {
    width,
    height: CARTESIAN_HEIGHT,
    plot,
    yTicks: axis.ticks.map(({ at, label }) => ({ position: y(at), label, baseline: at === 0 })),
    xLabels: pickAxisLabels(chart.labels, plot.x, step),
    guide: chart.kind === "bar" ? "band" : "line",
    marks,
    targets,
    legend: chart.series.map(({ name }, slot) => ({ key: name, slot, hidden: hidden.has(name) })),
    hit: { type: "bands", left: plot.x, step },
  };
}

function buildScatterScene(
  chart: ScatterChart,
  width: number,
  hidden: ReadonlySet<string>,
): ChartScene {
  const visible = chart.series.flatMap(({ name, points }, slot) =>
    hidden.has(name) ? [] : [{ slot, name, points }],
  );
  const coordinates = (axis: 0 | 1) =>
    visible.flatMap(({ points }) => points.map((point) => point[axis]));
  const scaledAxis = (values: number[]) => {
    const scale = largestMagnitude(values);
    const [low, high] = widened(extent(values.map((value) => value / scale)));
    return { scale, axis: buildAxis(low, high, scale) };
  };
  const horizontal = scaledAxis(coordinates(0));
  const vertical = scaledAxis(coordinates(1));

  const left = axisWidth(vertical.axis);
  const plot: Box = {
    x: left,
    y: PLOT_INSET,
    width: Math.max(0, width - left - PLOT_INSET * 2),
    height: CARTESIAN_HEIGHT - PLOT_INSET - SCATTER_AXIS_HEIGHT,
  };
  const along = (value: number, { scale, axis }: typeof horizontal) =>
    (clamp(value / scale, axis.min, axis.max) - axis.min) / (axis.max - axis.min);
  const x = (value: number) => round(plot.x + along(value, horizontal) * plot.width);
  const y = (value: number) => round(plot.y + plot.height - along(value, vertical) * plot.height);

  const suffix = unitSuffix(chart);
  const xName = chart.xLabel ?? "x";
  const yName = chart.yLabel ?? "y";
  const marks: SceneMark[] = [];
  const targets: SceneTarget[] = [];
  for (const { slot, name, points } of visible) {
    points.forEach(([px, py], index) => {
      const anchor = { x: x(px), y: y(py) };
      marks.push({ type: "point", ...anchor, slot, target: targets.length, whenSelected: false });
      targets.push({
        key: `${name}\u0000${index}`,
        title: name,
        readouts: [
          { slot, name: xName, value: px.toString() },
          { slot, name: yName, value: py.toString() },
        ],
        description: `${name}. ${xName}: ${px}. ${yName}: ${py}${suffix}`,
        anchor,
        box: {
          x: anchor.x - POINT_HIT_RADIUS / 2,
          y: anchor.y - POINT_HIT_RADIUS / 2,
          width: POINT_HIT_RADIUS,
          height: POINT_HIT_RADIUS,
        },
      });
    });
  }

  const tickWidth = plot.width / Math.max(1, horizontal.axis.ticks.length - 1);
  return {
    width,
    height: CARTESIAN_HEIGHT,
    plot,
    yTicks: vertical.axis.ticks.map(({ at, label }) => ({
      position: round(
        plot.y +
          plot.height -
          ((at - vertical.axis.min) / (vertical.axis.max - vertical.axis.min)) * plot.height,
      ),
      label,
      baseline: at === 0,
    })),
    xLabels: horizontal.axis.ticks.map(({ at, label }) => ({
      x: round(
        plot.x +
          ((at - horizontal.axis.min) / (horizontal.axis.max - horizontal.axis.min)) * plot.width,
      ),
      width: round(tickWidth),
      text: label,
    })),
    guide: "none",
    marks,
    targets,
    legend: chart.series.map(({ name }, slot) => ({ key: name, slot, hidden: hidden.has(name) })),
    hit: { type: "points" },
  };
}

/** Scale before summing so several slices at the numeric limit still total a finite number. */
function sliceFractions(values: readonly number[]): number[] {
  const largest = Math.max(...values);
  if (!(largest > 0)) return values.map(() => 0);
  const scaled = values.map((value) => value / largest);
  const total = scaled.reduce((sum, value) => sum + value, 0);
  return scaled.map((value) => value / total);
}

function slicePath(center: number, outer: number, inner: number, start: number, end: number) {
  const middle = (start + end) / 2;
  const at = (angle: number, radius: number) =>
    `${round(center + Math.sin(angle) * radius)},${round(center - Math.cos(angle) * radius)}`;
  // Two arcs also draw a full circle, where one SVG arc has coincident ends.
  const rim = `M${at(start, outer)} A${outer},${outer} 0 0 1 ${at(middle, outer)} A${outer},${outer} 0 0 1 ${at(end, outer)}`;
  if (inner <= 0) return `${rim} L${center},${center} Z`;
  return `${rim} L${at(end, inner)} A${inner},${inner} 0 0 0 ${at(middle, inner)} A${inner},${inner} 0 0 0 ${at(start, inner)} Z`;
}

function buildRadialScene(
  chart: RadialChart,
  width: number,
  hidden: ReadonlySet<string>,
  transition: ChartTransition,
): ChartScene {
  const [series] = chart.series;
  const size = Math.min(width, RADIAL_SIZE);
  const center = size / 2;
  const outer = Math.max(0, center - PLOT_INSET);
  const inner = chart.kind === "donut" ? round(outer * DONUT_HOLE) : 0;
  const shownValue = (label: string, value: number) => (hidden.has(label) ? 0 : value);
  const fractions = sliceFractions(
    chart.labels.map((label, index) => shownValue(label, series.values[index])),
  );
  const before =
    transition.previous && isRadialChart(transition.previous) ? transition.previous : null;
  const earlier = before
    ? sliceFractions(
        before.labels.map((label, index) => shownValue(label, before.series[0].values[index])),
      )
    : [];

  const suffix = unitSuffix(chart);
  const marks: SceneMark[] = [];
  const targets: SceneTarget[] = [];
  const spans: ArcSpan[] = [];
  const legend: SceneLegendEntry[] = [];
  let start = 0;
  chart.labels.forEach((label, index) => {
    const slot = index % SERIES_SLOTS;
    const value = series.values[index].toString();
    if (hidden.has(label)) {
      legend.push({ key: label, slot, hidden: true, value });
      return;
    }
    const from = earlier[before?.labels.indexOf(label) ?? -1] ?? 0;
    const sweep =
      (from * (1 - transition.progress) + fractions[index] * transition.progress) * Math.PI * 2;
    const end = start + sweep;
    const share = formatPercent(fractions[index], series.values[index]);
    const middle = (start + end) / 2;
    const reach = (outer + inner) / 2;
    const anchor = {
      x: round(center + Math.sin(middle) * reach),
      y: round(center - Math.cos(middle) * reach),
    };
    if (sweep > 0) {
      marks.push({
        type: "arc",
        path: slicePath(center, outer, inner, start, end),
        slot,
        target: targets.length,
      });
      spans.push({ start, end, target: targets.length });
    }
    targets.push({
      key: label,
      title: label,
      readouts: [{ slot, name: series.name, value: `${value}${suffix}`, share }],
      description: `${label}. ${value}${suffix}. ${share}`,
      anchor,
      box: {
        x: anchor.x - POINT_HIT_RADIUS / 2,
        y: anchor.y - POINT_HIT_RADIUS / 2,
        width: POINT_HIT_RADIUS,
        height: POINT_HIT_RADIUS,
      },
    });
    legend.push({ key: label, slot, hidden: false, value, share });
    start = end;
  });

  return {
    width: size,
    height: size,
    plot: { x: 0, y: 0, width: size, height: size },
    yTicks: [],
    xLabels: [],
    guide: "none",
    marks,
    targets,
    legend,
    hit: { type: "arcs", center, inner, outer, spans },
  };
}

export function isRadialChart(chart: ChartNode): chart is RadialChart {
  return chart.kind === "pie" || chart.kind === "donut";
}

export function buildChartScene({
  chart,
  width,
  hidden,
  transition = SETTLED,
}: ChartSceneInput): ChartScene {
  if (chart.kind === "scatter") return buildScatterScene(chart, width, hidden);
  if (isRadialChart(chart)) return buildRadialScene(chart, width, hidden, transition);
  return buildCartesianScene(chart, width, hidden, transition);
}

/** The legend keys of a chart, the things a reader can switch off. */
export function legendKeys(chart: ChartNode): string[] {
  if (isRadialChart(chart)) return chart.labels;
  return chart.series.map(({ name }) => name);
}

/** The target under a point of the plot, or null when it is over nothing selectable. */
export function hitTestScene(scene: ChartScene, x: number, y: number): number | null {
  const { hit, targets } = scene;
  if (targets.length === 0) return null;
  if (hit.type === "bands") {
    if (y < 0 || y > scene.height || x < hit.left || !(hit.step > 0)) return null;
    const index = Math.floor((x - hit.left) / hit.step);
    return index < targets.length ? index : null;
  }
  if (hit.type === "points") {
    let nearest: number | null = null;
    let reach = POINT_HIT_RADIUS ** 2;
    targets.forEach(({ anchor }, index) => {
      const distance = (anchor.x - x) ** 2 + (anchor.y - y) ** 2;
      if (distance <= reach) {
        reach = distance;
        nearest = index;
      }
    });
    return nearest;
  }
  const dx = x - hit.center;
  const dy = y - hit.center;
  const distance = Math.hypot(dx, dy);
  if (distance > hit.outer || distance < hit.inner) return null;
  const angle = (Math.atan2(dx, -dy) + Math.PI * 2) % (Math.PI * 2);
  return hit.spans.find(({ start, end }) => angle >= start && angle < end)?.target ?? null;
}

/** A sparkline's points inside a box, drawn left to right. */
export function sparklinePoints(values: readonly number[], width: number, height: number): Point[] {
  const inset = 2;
  const scale = largestMagnitude(values);
  const [low, high] = extent(values.map((value) => value / scale));
  const span = high - low;
  return values.map((value, index) => ({
    x: round(inset + ((width - inset * 2) * index) / Math.max(1, values.length - 1)),
    y: round(
      span > 0
        ? height - inset - ((value / scale - low) / span) * (height - inset * 2)
        : height / 2,
    ),
  }));
}
