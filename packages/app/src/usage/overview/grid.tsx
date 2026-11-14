import { Children, useCallback, useMemo, useState, type ReactNode } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";

/**
 * Equal-width columns that follow the measured width: as many as fit at `minColumn`, at most
 * `maxColumns`, one below that. Children keep their order, and each row stretches its items to
 * the tallest one. The column count only changes with the container width, never with content,
 * so switching a tab inside a card does not move cards between columns.
 */
export function UsageGrid({
  children,
  minColumn,
  maxColumns,
  gap,
  testID,
}: {
  children: ReactNode;
  minColumn: number;
  maxColumns: number;
  gap: number;
  testID?: string;
}) {
  const [width, setWidth] = useState(0);
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => setWidth(Math.floor(event.nativeEvent.layout.width)),
    [],
  );
  const columns = Math.max(1, Math.min(maxColumns, Math.floor((width + gap) / (minColumn + gap))));
  const itemWidth = width === 0 ? "100%" : Math.floor((width - (columns - 1) * gap) / columns);
  const gridStyle = useMemo(() => [styles.grid, { gap }], [gap]);
  const itemStyle = useMemo(() => ({ width: itemWidth }) as const, [itemWidth]);
  return (
    <View style={gridStyle} onLayout={onLayout} testID={testID}>
      {Children.toArray(children).map((child) => (
        <View key={keyOf(child)} style={itemStyle}>
          {child}
        </View>
      ))}
    </View>
  );
}

function keyOf(child: ReactNode): string | number {
  return typeof child === "object" && child !== null && "key" in child && child.key !== null
    ? child.key
    : 0;
}

const styles = StyleSheet.create(() => ({
  grid: { flexDirection: "row", flexWrap: "wrap", alignItems: "stretch" },
}));
