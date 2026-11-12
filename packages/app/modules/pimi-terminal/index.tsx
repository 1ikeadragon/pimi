import { requireNativeView } from "expo";
import { useCallback, useMemo } from "react";
import type { StyleProp, ViewStyle } from "react-native";

import type { PimiTerminalCellMetrics, PimiTerminalFrame, PimiTerminalTheme } from "./contract";
import { encodeTerminalCustomGlyphs, type PimiTerminalCustomGlyph } from "./custom-glyphs";
import { encodeTerminalFrame, type NativePimiTerminalFrame } from "./frame-encoding";

export * from "./contract";

export interface PimiTerminalViewProps {
  frame: PimiTerminalFrame;
  theme: PimiTerminalTheme;
  fontFamily: string;
  /** Font size in points after the system font scale is applied. */
  fontSize: number;
  onCellMetrics?: (metrics: PimiTerminalCellMetrics) => void;
  style?: StyleProp<ViewStyle>;
}

interface NativePimiTerminalViewProps extends Omit<
  PimiTerminalViewProps,
  "frame" | "onCellMetrics"
> {
  frame: NativePimiTerminalFrame;
  customGlyphs: PimiTerminalCustomGlyph[];
  onCellMetrics?: (event: { nativeEvent: PimiTerminalCellMetrics }) => void;
}

const NativePimiTerminalView = requireNativeView<NativePimiTerminalViewProps>("PimiTerminal");
const CUSTOM_GLYPHS = encodeTerminalCustomGlyphs();

export function PimiTerminalView({ frame, onCellMetrics, ...props }: PimiTerminalViewProps) {
  const nativeFrame = useMemo(() => encodeTerminalFrame(frame), [frame]);
  const handleCellMetrics = useCallback(
    (event: { nativeEvent: PimiTerminalCellMetrics }) => onCellMetrics?.(event.nativeEvent),
    [onCellMetrics],
  );
  return (
    <NativePimiTerminalView
      {...props}
      frame={nativeFrame}
      customGlyphs={CUSTOM_GLYPHS}
      onCellMetrics={handleCellMetrics}
    />
  );
}
