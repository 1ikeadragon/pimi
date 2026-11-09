import { useCallback, useState } from "react";
import { View, StyleSheet } from "react-native";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { ResizeHandle } from "@/components/resize-handle";
import {
  resolveExplorerSidebarDockSizes,
  resolveExplorerSidebarWidth,
} from "@/components/explorer-sidebar-layout";
import type { ExplorerGeometryInput, ExplorerGeometry } from "./geometry-types";
export function useExplorerGeometry({
  width,
  containerWidth,
  onResize,
  overlay,
  side,
}: ExplorerGeometryInput): ExplorerGeometry {
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  const requestedWidth = previewWidth ?? width;
  const left = side === "left";
  const widthIndex = left ? 0 : 1;
  const dockSizes = resolveExplorerSidebarDockSizes({ requestedWidth, containerWidth });
  const sizes = left ? dockSizes.toReversed() : dockSizes;
  const preview = useCallback(
    (_id: string, next: number[]) => {
      setPreviewWidth(
        resolveExplorerSidebarWidth({
          requestedWidth: next[widthIndex] * containerWidth,
          containerWidth,
        }),
      );
    },
    [containerWidth, widthIndex],
  );
  const commit = useCallback(
    (_id: string, next: number[]) => {
      setPreviewWidth(null);
      onResize(
        resolveExplorerSidebarWidth({
          requestedWidth: next[widthIndex] * containerWidth,
          containerWidth,
        }),
      );
    },
    [containerWidth, onResize, widthIndex],
  );
  return {
    frameStyle: inlineUnistylesStyle({ width: overlay ? undefined : requestedWidth }),
    panelStyle: undefined,
    resizeHandle: (
      <View style={[styles.resize, left ? styles.right : styles.left]}>
        <ResizeHandle
          testID="workspace-explorer-sidebar-resize-handle"
          direction="horizontal"
          hitAreaAlignment={left ? "center" : "end"}
          groupId="explorer-sidebar"
          index={0}
          sizes={sizes}
          containerSize={containerWidth}
          onPreviewResizeSplit={preview}
          onResizeSplit={commit}
        />
      </View>
    ),
  };
}
const styles = StyleSheet.create({
  resize: { position: "absolute", top: 0, bottom: 0, zIndex: 2, flexDirection: "row" },
  left: { left: 0 },
  right: { right: 0 },
});
