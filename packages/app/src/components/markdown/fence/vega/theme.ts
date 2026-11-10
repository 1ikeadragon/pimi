import type { Config } from "vega-lite";
import type { Theme } from "@/styles/theme";

/** What a chart takes from the app theme. One object per theme, so a chart redraws only on change. */
export interface VegaTheme {
  config: Config;
}

const themes = new WeakMap<Theme, VegaTheme>();
const LABEL_SIZE = 11;

/**
 * The app theme as a Vega-Lite config. A spec carries no colors or fonts of its own, so every
 * theme and palette draws the same chart in its own tokens. For `withUnistyles`.
 */
export function vegaTheme(theme: Theme): { theme: VegaTheme } {
  let value = themes.get(theme);
  if (!value) {
    const { colors } = theme;
    const [primary] = colors.chartSeries;
    const font = theme.fontFamily.ui;
    const text = { font, fontSize: LABEL_SIZE };
    value = {
      config: {
        background: "transparent",
        font,
        padding: 2,
        view: { stroke: "transparent", continuousHeight: 240 },
        // Every mark answers a pointer or a press with the fields it encodes.
        mark: { tooltip: { content: "encoding" }, color: primary },
        arc: { stroke: colors.surface1, strokeWidth: 1 },
        area: { fillOpacity: 0.35, line: true },
        bar: { cornerRadiusEnd: 2 },
        line: { strokeWidth: 2 },
        point: { filled: true, size: 48 },
        rule: { color: colors.foregroundMuted },
        text: { ...text, color: colors.foreground },
        boxplot: { median: { color: colors.surface1 } },
        range: {
          category: [...colors.chartSeries],
          ordinal: [...colors.chartSeries],
          ramp: [colors.surface2, primary],
          heatmap: [colors.surface2, primary],
          diverging: [colors.chartSeries[1], colors.surface2, primary],
        },
        axis: {
          domainColor: colors.border,
          tickColor: colors.border,
          gridColor: colors.border,
          labelColor: colors.foregroundMuted,
          titleColor: colors.foregroundMuted,
          labelFont: font,
          titleFont: font,
          labelFontSize: LABEL_SIZE,
          titleFontSize: LABEL_SIZE,
          titleFontWeight: "normal",
          labelOverlap: true,
          labelLimit: 120,
        },
        axisX: { grid: false, labelAngle: 0 },
        // Vega's default of about ten ticks crowds a chat column.
        axisQuantitative: { tickCount: 6 },
        legend: {
          labelColor: colors.foregroundMuted,
          titleColor: colors.foregroundMuted,
          labelFont: font,
          titleFont: font,
          labelFontSize: LABEL_SIZE,
          titleFontSize: LABEL_SIZE,
          titleFontWeight: "normal",
          symbolType: "circle",
          labelLimit: 140,
        },
        header: {
          labelColor: colors.foregroundMuted,
          titleColor: colors.foregroundMuted,
          labelFont: font,
          titleFont: font,
          labelFontSize: LABEL_SIZE,
          titleFontSize: LABEL_SIZE,
          titleFontWeight: "normal",
        },
        title: { color: colors.foreground, font, fontSize: 13, fontWeight: "normal" },
      },
    };
    themes.set(theme, value);
  }
  return { theme: value };
}
