// Pimi. PolyForm-Noncommercial-1.0.0.
// Local state of the Files tab, split out of the component: display preferences, viewed marks,
// the tree filter and the j / k / v keys.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { resolveDiffLayout } from "@/git/diff-pane";
import { useChangesPreferences } from "@/hooks/use-changes-preferences";
import { useAppSettings } from "@/hooks/use-settings";
import type { ParsedDiffFile } from "@pimi/protocol/messages";
import { useViewedStore } from "./viewed-store";

export function useDeskDisplay() {
  const isCompact = useIsCompactFormFactor();
  const { settings } = useAppSettings();
  const { preferences, updatePreferences } = useChangesPreferences();
  const canSplit = isWeb && !isCompact;
  const layout = resolveDiffLayout(preferences.layout, canSplit);
  const displayPreferences = useMemo(
    () => ({
      layout,
      wrapLines: preferences.wrapLines,
      codeFontSize: settings.codeFontSize,
      monoFontFamily: settings.monoFontFamily,
    }),
    [layout, preferences.wrapLines, settings.codeFontSize, settings.monoFontFamily],
  );
  const toggleLayout = useCallback(() => {
    void updatePreferences({ layout: preferences.layout === "unified" ? "split" : "unified" });
  }, [preferences.layout, updatePreferences]);
  return { isCompact, canSplit, layout: preferences.layout, displayPreferences, toggleLayout };
}

/**
 * Viewed marks of one review. A mark is the file's `viewedKeyFor` value at the time it was set, so
 * a file that changed since reads as unviewed while every other file keeps its mark. The key is
 * computed only for files that have a mark, and on toggle.
 */
export function useDeskViewed(
  reviewKey: string,
  paths: readonly string[],
  viewedKeyFor: (path: string) => string | null,
) {
  const marks = useViewedStore((state) => state.marks[reviewKey]);
  const toggleMark = useViewedStore((state) => state.toggle);
  const viewedPaths = useMemo(() => {
    const out = new Set<string>();
    if (!marks) return out;
    for (const path of paths) {
      const mark = marks[path];
      if (mark !== undefined && mark === viewedKeyFor(path)) out.add(path);
    }
    return out;
  }, [marks, paths, viewedKeyFor]);
  const toggleViewed = useCallback(
    (path: string) => toggleMark(reviewKey, path, viewedKeyFor(path) ?? ""),
    [reviewKey, toggleMark, viewedKeyFor],
  );
  return { viewedPaths, toggleViewed };
}

export function useDeskFilter(input: {
  stubs: readonly ParsedDiffFile[];
  viewedPaths: ReadonlySet<string>;
  unresolvedByPath: ReadonlyMap<string, number>;
}) {
  const { stubs, viewedPaths, unresolvedByPath } = input;
  const [filter, setFilter] = useState("");
  const [unviewedOnly, setUnviewedOnly] = useState(false);
  const [threadsOnly, setThreadsOnly] = useState(false);
  const toggleUnviewed = useCallback(() => setUnviewedOnly((current) => !current), []);
  const toggleThreads = useCallback(() => setThreadsOnly((current) => !current), []);
  const treeFiles = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return stubs.filter(
      (file) =>
        (needle === "" || file.path.toLowerCase().includes(needle)) &&
        (!unviewedOnly || !viewedPaths.has(file.path)) &&
        (!threadsOnly || (unresolvedByPath.get(file.path) ?? 0) > 0),
    );
  }, [filter, stubs, threadsOnly, unresolvedByPath, unviewedOnly, viewedPaths]);
  return { filter, setFilter, unviewedOnly, threadsOnly, toggleUnviewed, toggleThreads, treeFiles };
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(
    el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable),
  );
}

/** j / k step through files, v toggles the viewed mark; ignored while typing. Web only. */
export function useDeskKeyboard(input: {
  paths: readonly string[];
  activePath: string;
  onMove: (path: string) => void;
  onToggleViewed: (path: string) => void;
}) {
  const { paths, activePath, onMove, onToggleViewed } = input;
  useEffect(() => {
    if (!isWeb) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;
      const index = paths.indexOf(activePath);
      if (event.key === "j" || event.key === "k") {
        const next = paths[index + (event.key === "j" ? 1 : -1)];
        if (next) onMove(next);
      } else if (event.key === "v" && activePath) {
        onToggleViewed(activePath);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activePath, onMove, onToggleViewed, paths]);
}
