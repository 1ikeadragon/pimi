import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import { SvgXml } from "react-native-svg";
import { StyleSheet } from "react-native-unistyles";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { SceneInteraction, useInspection, type InteractionTarget } from "../view/interaction";
import type { VegaChartInput, VegaSvg } from "./runtime";
import type { VegaTheme } from "./theme";
import { VegaTooltipRows } from "./tooltip";

type Runtime = typeof import("./runtime");

const noop = () => {};

/**
 * Native has no DOM for Vega to draw into, so the chart is rendered to an SVG string and shown
 * with react-native-svg. Pressing a mark shows its values, hit-tested against the same scene.
 */
export function VegaCanvas({
  runtime,
  spec,
  width,
  theme,
  onFailed,
}: {
  runtime: Runtime;
  spec: VegaChartInput["spec"];
  width: number;
  theme: VegaTheme;
  onFailed: () => void;
}) {
  const [chart, setChart] = useState<VegaSvg | null>(null);
  useEffect(() => {
    let current = true;
    runtime
      .renderVegaSvg({ spec, config: theme.config, width })
      .then((result) => {
        if (current) setChart(result);
        return;
      })
      .catch(() => {
        if (current) onFailed();
      });
    return () => {
      current = false;
    };
  }, [runtime, spec, theme, width, onFailed]);

  const targets = useMemo<InteractionTarget[]>(
    () =>
      (chart?.regions ?? []).map(({ box, rows }, index) => ({
        key: String(index),
        description: rows
          .map(({ label, value }) => (label ? `${label}: ${value}` : value))
          .join(", "),
        anchor: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
        box,
      })),
    [chart],
  );
  const { inspected, inspect } = useInspection(targets);
  // The smallest mark under the press wins, so a point on top of an area is still reachable.
  const hitTest = useCallback(
    (x: number, y: number) => {
      let hit: number | null = null;
      let hitArea = Infinity;
      targets.forEach(({ box }, index) => {
        const inside =
          x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
        const area = box.width * box.height;
        if (inside && area < hitArea) {
          hit = index;
          hitArea = area;
        }
      });
      return hit;
    },
    [targets],
  );
  const renderPopover = useCallback(
    (index: number) => {
      const rows = chart?.regions[index]?.rows;
      return rows ? <VegaTooltipRows rows={rows} /> : null;
    },
    [chart],
  );
  const bounds = useMemo(
    () => ({ width: chart?.width ?? width, height: chart?.height ?? 0 }),
    [chart, width],
  );

  if (!chart) return null;
  return (
    <ScrollView
      horizontal
      scrollEnabled={chart.width > width}
      showsHorizontalScrollIndicator={chart.width > width}
      testID="chat-vega-canvas"
    >
      <View style={[styles.scene, inlineUnistylesStyle(bounds)]}>
        <SvgXml xml={chart.svg} width={chart.width} height={chart.height} />
        <SceneInteraction
          targets={targets}
          bounds={bounds}
          hitTest={hitTest}
          inspected={inspected}
          onSelect={noop}
          onInspect={inspect}
          renderPopover={renderPopover}
          testIDPrefix="chat-vega-mark"
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create(() => ({
  scene: { position: "relative" },
}));
