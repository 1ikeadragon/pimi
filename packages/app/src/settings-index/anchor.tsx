import { useEffect, useRef, useState, type ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import { SETTING_HIGHLIGHT_MS, useSettingsFocusStore } from "./focus";

/** Rows currently mounted with a `settingId`, for the dev check that the index matches the page. */
const mountedAnchors = new Map<string, number>();

export function getMountedSettingIds(): ReadonlySet<string> {
  return new Set(mountedAnchors.keys());
}

function useSettingAnchor(id: string | undefined) {
  const ref = useRef<View>(null);
  const [highlighted, setHighlighted] = useState(false);
  const request = useSettingsFocusStore((state) => state.request);
  const settle = useSettingsFocusStore((state) => state.settle);

  useEffect(() => {
    if (!id) return;
    mountedAnchors.set(id, (mountedAnchors.get(id) ?? 0) + 1);
    return () => {
      const count = (mountedAnchors.get(id) ?? 1) - 1;
      if (count <= 0) mountedAnchors.delete(id);
      else mountedAnchors.set(id, count);
    };
  }, [id]);

  const requestSeq = id && request?.id === id ? request.seq : null;
  useEffect(() => {
    if (requestSeq === null) return;
    // The page has just mounted or re-rendered; let layout settle before measuring.
    const scrollTimer = setTimeout(() => {
      if (isWeb) {
        (ref.current as unknown as HTMLElement | null)?.scrollIntoView?.({
          block: "center",
          behavior: "smooth",
        });
      }
      setHighlighted(true);
    }, 60);
    const settleTimer = setTimeout(() => {
      setHighlighted(false);
      settle(requestSeq);
    }, SETTING_HIGHLIGHT_MS);
    return () => {
      clearTimeout(scrollTimer);
      clearTimeout(settleTimer);
    };
  }, [requestSeq, settle]);

  return { ref, highlighted };
}

/**
 * The root of one settings row. With `id`, search can scroll to it and highlight it; without, it
 * is a plain View. Pass the row's own style, so the anchor adds no wrapper to the layout.
 */
export function SettingAnchor({
  id,
  style,
  testID,
  children,
}: {
  id?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  children?: ReactNode;
}) {
  const { ref, highlighted } = useSettingAnchor(id);
  return (
    <View
      ref={ref}
      collapsable={false}
      style={highlighted ? [style, styles.highlighted] : style}
      testID={testID}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  highlighted: {
    backgroundColor: theme.colors.surface3,
  },
}));
