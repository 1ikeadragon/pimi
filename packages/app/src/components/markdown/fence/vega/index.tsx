import { useCallback, useEffect, useState } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { ChatVega } from "@pimi/protocol/chat-vega";
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

function VegaCard({ vega, source }: { vega: ChatVega; source: string }) {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [failed, setFailed] = useState(false);
  const [width, setWidth] = useState(0);
  // The reply is split again on every streamed token, which parses a fresh, equal spec. The card
  // is keyed by its source, so the first one stands for all of them and the chart is drawn once.
  const [spec] = useState(vega.spec);
  const fail = useCallback(() => setFailed(true), []);
  useEffect(() => {
    let current = true;
    loadRuntime()
      .then((module) => {
        if (current) setRuntime(module);
        return;
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, []);
  const measure = useCallback(({ nativeEvent }: LayoutChangeEvent) => {
    setWidth(Math.floor(nativeEvent.layout.width));
  }, []);

  if (failed) return <FailedView source={source} />;
  return (
    <VisualCard title={vega.title} subtitle={vega.subtitle} testID="chat-vega">
      <View style={styles.plot} onLayout={measure}>
        {runtime && width > 0 ? (
          <ThemedCanvas
            runtime={runtime}
            spec={spec}
            width={width}
            onFailed={fail}
            uniProps={vegaTheme}
          />
        ) : (
          <PendingCaption />
        )}
      </View>
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
