import { useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ViewNode, ViewTone } from "@pimi/protocol/chat-view";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import type { Theme } from "@/styles/theme";
import { ThemedSparkline } from "./painter";
import { sparklinePoints } from "./scene";

type NodeOf<Type extends ViewNode["type"]> = Extract<ViewNode, { type: Type }>;

const SPARKLINE_WIDTH = 96;
const SPARKLINE_HEIGHT = 28;

const BADGE_VARIANTS: Record<ViewTone, StatusBadgeVariant> = {
  neutral: "muted",
  positive: "success",
  negative: "error",
  warning: "warning",
};

function toneColor(theme: Theme, tone: ViewTone): string {
  const { colors } = theme;
  const byTone: Record<ViewTone, string> = {
    neutral: colors.foregroundMuted,
    positive: colors.statusSuccess,
    negative: colors.statusDanger,
    warning: colors.statusWarning,
  };
  return byTone[tone];
}

const SPARKLINE_COLORS: Record<ViewTone, (theme: Theme) => { color: string }> = {
  neutral: (theme) => ({ color: toneColor(theme, "neutral") }),
  positive: (theme) => ({ color: toneColor(theme, "positive") }),
  negative: (theme) => ({ color: toneColor(theme, "negative") }),
  warning: (theme) => ({ color: toneColor(theme, "warning") }),
};

function toneTextStyle(tone: ViewTone) {
  // Read at render: Unistyles styles must not be collected at module scope.
  const byTone = {
    neutral: styles.toneNeutral,
    positive: styles.tonePositive,
    negative: styles.toneNegative,
    warning: styles.toneWarning,
  };
  return byTone[tone];
}

export function MetricView({ node }: { node: NodeOf<"metric"> }) {
  const tone = node.tone ?? "neutral";
  const points = useMemo(
    () => (node.trend ? sparklinePoints(node.trend, SPARKLINE_WIDTH, SPARKLINE_HEIGHT) : null),
    [node.trend],
  );
  return (
    <View style={styles.metric} testID="chat-view-metric">
      <Text style={styles.caption}>{node.label}</Text>
      <View style={styles.metricFigures}>
        <View style={styles.metricValue}>
          <Text selectable style={styles.figure}>
            {node.value}
          </Text>
          {node.delta ? (
            <Text selectable style={[styles.delta, toneTextStyle(tone)]}>
              {node.delta}
            </Text>
          ) : null}
        </View>
        {points ? (
          <ThemedSparkline
            points={points}
            width={SPARKLINE_WIDTH}
            height={SPARKLINE_HEIGHT}
            uniProps={SPARKLINE_COLORS[tone]}
          />
        ) : null}
      </View>
      {node.hint ? <Text style={styles.caption}>{node.hint}</Text> : null}
    </View>
  );
}

export function ProgressView({ node }: { node: NodeOf<"progress"> }) {
  const tone = node.tone ?? "neutral";
  const fills = {
    neutral: styles.fillNeutral,
    positive: styles.fillPositive,
    negative: styles.fillNegative,
    warning: styles.fillWarning,
  };
  const accessibilityValue = useMemo(
    () => ({ min: 0, max: node.max, now: node.value }),
    [node.max, node.value],
  );
  const filled: `${number}%` = `${(node.value / node.max) * 100}%`;
  return (
    <View
      style={styles.progress}
      accessibilityRole="progressbar"
      accessibilityLabel={node.label}
      accessibilityValue={accessibilityValue}
    >
      <View style={styles.progressHeader}>
        <Text style={styles.caption}>{node.label}</Text>
        <Text style={styles.progressValue}>
          {node.value.toString()} / {node.max.toString()}
        </Text>
      </View>
      <View style={styles.track}>
        <View style={[styles.trackFill, fills[tone], inlineUnistylesStyle({ width: filled })]} />
      </View>
    </View>
  );
}

export function TextView({ node }: { node: NodeOf<"text"> }) {
  const emphasis = {
    normal: null,
    strong: styles.strong,
    subtle: styles.subtle,
  };
  return (
    <Text
      selectable
      style={[
        styles.body,
        emphasis[node.emphasis ?? "normal"],
        node.tone && node.tone !== "neutral" ? toneTextStyle(node.tone) : null,
      ]}
    >
      {node.content}
    </Text>
  );
}

export function BadgeView({ node }: { node: NodeOf<"badge"> }) {
  return (
    <View style={styles.badge}>
      <StatusBadge label={node.label} variant={BADGE_VARIANTS[node.tone ?? "neutral"]} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  metric: { gap: theme.spacing[1], minWidth: 0 },
  metricFigures: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  metricValue: {
    flexDirection: "row",
    alignItems: "baseline",
    flexWrap: "wrap",
    columnGap: theme.spacing[2],
    flexShrink: 1,
  },
  figure: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize["2xl"],
    fontWeight: theme.fontWeight.medium,
    fontVariant: ["tabular-nums"],
  },
  delta: { fontSize: theme.fontSize.sm, fontVariant: ["tabular-nums"] },
  caption: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  body: { color: theme.colors.foreground, fontSize: theme.fontSize.base, flexShrink: 1 },
  strong: { fontWeight: theme.fontWeight.medium },
  subtle: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  toneNeutral: { color: theme.colors.foregroundMuted },
  tonePositive: { color: theme.colors.statusSuccess },
  toneNegative: { color: theme.colors.statusDanger },
  toneWarning: { color: theme.colors.statusWarning },
  progress: { gap: theme.spacing[1.5], minWidth: 0 },
  progressHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  progressValue: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  track: {
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    overflow: "hidden",
  },
  trackFill: { height: 6, borderRadius: theme.borderRadius.full },
  fillNeutral: { backgroundColor: theme.colors.foregroundMuted },
  fillPositive: { backgroundColor: theme.colors.statusSuccess },
  fillNegative: { backgroundColor: theme.colors.statusDanger },
  fillWarning: { backgroundColor: theme.colors.statusWarning },
  badge: { flexDirection: "row" },
}));
