import { useCallback, useEffect, useState } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { ChatVega } from "@pimi/protocol/chat-vega";
import { useOpenChatVisualInTab } from "../open-in-tab";
import { FailedView, PendingCaption, PendingView, VisualCard } from "../view";
import { VegaCanvas } from "./canvas";
import { vegaTheme } from "./theme";

type Runtime = typeof import("./runtime");

let loading: Promise<Runtime> | null = null;

/** Vega is fetched the first time a chart is shown, then shared by every chart after it. */
function loadRuntime(): Promise<Runtime> {
  loading ??= import("./runtime").catch((error: unknown) => {
    // A failed fetch must not be remembered, or no chart could ever load in this session.
    loading = null;
    throw error;
  });
  return loading;
}

const ThemedCanvas = withUnistyles(VegaCanvas);

/**
 * The chart itself, laid out for the width it is given: the chat column in a card, the whole pane
 * in a tab. `onFailed` is called when the spec cannot be drawn.
 */
export function VegaPlot({ spec, onFailed }: { spec: ChatVega["spec"]; onFailed: () => void }) {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    let current = true;
    loadRuntime()
      .then((module) => {
        if (current) setRuntime(module);
        return;
      })
      .catch(() => {
        if (current) onFailed();
      });
    return () => {
      current = false;
    };
  }, [onFailed]);
  const measure = useCallback(({ nativeEvent }: LayoutChangeEvent) => {
    const measured = Math.floor(nativeEvent.layout.width);
    // A hidden retained panel reports zero; keep the last real width.
    if (measured > 0) setWidth(measured);
  }, []);
  return (
    <View style={styles.plot} onLayout={measure}>
      {runtime && width > 0 ? (
        <ThemedCanvas
          runtime={runtime}
          spec={spec}
          width={width}
          onFailed={onFailed}
          uniProps={vegaTheme}
        />
      ) : (
        <PendingCaption />
      )}
    </View>
  );
}

const VEGA_TAB_TITLE = "Chart";

function VegaCard({ vega, source }: { vega: ChatVega; source: string }) {
  const [failed, setFailed] = useState(false);
  // The reply is split again on every streamed token, which parses a fresh, equal spec. The card
  // is keyed by its source, so the first one stands for all of them and the chart is drawn once.
  const [visual] = useState(() => ({ kind: "vega" as const, vega }));
  const fail = useCallback(() => setFailed(true), []);
  const openInTab = useOpenChatVisualInTab(visual, vega.title ?? VEGA_TAB_TITLE);

  if (failed) return <FailedView source={source} />;
  return (
    <VisualCard
      title={vega.title}
      subtitle={vega.subtitle}
      testID="chat-vega"
      onOpenInTab={openInTab}
    >
      <VegaPlot spec={visual.vega.spec} onFailed={fail} />
    </VisualCard>
  );
}

/**
 * A `pimi-vega` block. `vega` is null while the block is still streaming and not yet valid, and
 * for a block that ended invalid, which `failed` marks.
 */
export function VegaFence({
  vega,
  source,
  failed = false,
}: {
  vega: ChatVega | null;
  source: string;
  failed?: boolean;
}) {
  if (!vega) return failed ? <FailedView source={source} /> : <PendingView source={source} />;
  // A new spec starts over, so an earlier failure cannot hide a corrected chart.
  return <VegaCard key={source} vega={vega} source={source} />;
}

const styles = StyleSheet.create(() => ({
  plot: { width: "100%", minHeight: 24 },
}));
