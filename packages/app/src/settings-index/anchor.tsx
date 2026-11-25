import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import { SETTING_HIGHLIGHT_MS, useSettingsFocusStore } from "./focus";
import type { SettingsLocation } from "./types";

/**
 * Rows currently mounted with a `settingId`, per Settings page, for the dev check that the index
 * matches the page. Pages can be mounted together (a stacked route keeps the one beneath), so each
 * row registers under the page that rendered it.
 */
const mountedAnchors = new Map<string, Map<string, number>>();

const SettingsPageKeyContext = createContext<string | null>(null);

/** Marks every row below it as belonging to one Settings page. `pageKey` is a primitive, so it costs no renders. */
export const SettingsPageKeyProvider = SettingsPageKeyContext.Provider;

/** The key a page's rows register under. */
export function settingsPageKey(location: SettingsLocation): string {
  return `${location.kind}/${location.section}`;
}

export function getMountedSettingIds(pageKey: string): ReadonlySet<string> {
  return new Set(mountedAnchors.get(pageKey)?.keys());
}

function registerAnchor(pageKey: string, id: string): () => void {
  const page = mountedAnchors.get(pageKey) ?? new Map<string, number>();
  mountedAnchors.set(pageKey, page);
  page.set(id, (page.get(id) ?? 0) + 1);
  return () => {
    const count = (page.get(id) ?? 1) - 1;
    if (count > 0) {
      page.set(id, count);
      return;
    }
    page.delete(id);
    if (page.size === 0) mountedAnchors.delete(pageKey);
  };
}

function useSettingAnchor(id: string | undefined) {
  const pageKey = useContext(SettingsPageKeyContext);
  const ref = useRef<View>(null);
  const [highlighted, setHighlighted] = useState(false);
  const request = useSettingsFocusStore((state) => state.request);
  const settle = useSettingsFocusStore((state) => state.settle);

  useEffect(() => {
    if (!id || !pageKey) return;
    return registerAnchor(pageKey, id);
  }, [id, pageKey]);

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
