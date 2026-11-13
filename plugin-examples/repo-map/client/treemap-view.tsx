import { memo, useCallback, useMemo } from "react";
import Svg, { G, Rect, Text as SvgText } from "react-native-svg";
import type { PluginTheme } from "@pimi/plugin";
import type { Placed } from "../shared/treemap";
import { mix } from "./colors";

interface Props {
  boxes: readonly Placed[];
  width: number;
  height: number;
  theme: PluginTheme;
  /** Unix seconds bounding the recency ramp. */
  oldest: number;
  newest: number;
  focus: string | null;
  onPressFile(path: string): void;
}

/**
 * Draws the boxes. Memoized, so panning and zooming move a wrapping view and never re-render this.
 * Folders are outlines with a label; files are filled by how recently a commit touched them.
 */
export const TreemapView = memo(function TreemapView({
  boxes,
  width,
  height,
  theme,
  oldest,
  newest,
  focus,
  onPressFile,
}: Props) {
  const { accent, surface2, surface0, border, foreground, foregroundMuted } = theme.colors;
  const span = Math.max(newest - oldest, 1);
  const fills = useMemo(
    () =>
      boxes.map(({ node }) => {
        const at = node.file?.lastCommitAt;
        if (!node.file) return "none";
        return at ? mix(surface2, accent, 0.25 + 0.75 * ((at - oldest) / span)) : surface2;
      }),
    [boxes, surface2, accent, oldest, span],
  );
  return (
    <Svg width={width} height={height}>
      <Rect x={0} y={0} width={width} height={height} fill={surface0} />
      {boxes.map((box, index) => (
        <Box
          key={box.node.path}
          box={box}
          fill={fills[index]}
          focused={focus !== null && box.node.path === focus}
          stroke={border}
          textColor={box.node.file ? foreground : foregroundMuted}
          focusColor={foreground}
          onPressFile={onPressFile}
        />
      ))}
    </Svg>
  );
});

interface BoxProps {
  box: Placed;
  fill: string;
  focused: boolean;
  stroke: string;
  focusColor: string;
  textColor: string;
  onPressFile(path: string): void;
}

const Box = memo(function Box({
  box,
  fill,
  focused,
  stroke,
  focusColor,
  textColor,
  onPressFile,
}: BoxProps) {
  const { node, rect, depth } = box;
  const isFile = node.file !== null;
  const press = useCallback(() => onPressFile(node.path), [onPressFile, node.path]);
  const labelFits = rect.w > 56 && rect.h > (isFile ? 20 : 14);
  let strokeWidth = depth <= 1 ? 1.5 : 0.75;
  if (focused) strokeWidth = 2;
  return (
    <G onPress={isFile ? press : undefined} testID={`repo-map-box-${node.path}`}>
      <Rect
        x={rect.x}
        y={rect.y}
        width={rect.w}
        height={rect.h}
        fill={fill}
        stroke={focused ? focusColor : stroke}
        strokeWidth={strokeWidth}
      />
      {labelFits ? (
        <SvgText x={rect.x + 4} y={rect.y + 12} fontSize={10} fill={textColor}>
          {clip(node.name, rect.w)}
        </SvgText>
      ) : null}
    </G>
  );
});

function clip(text: string, width: number): string {
  const max = Math.max(Math.floor((width - 8) / 6), 3);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
