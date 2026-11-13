import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "@/i18n/use-translation";
import { PaneFind, usePaneFindTarget, type PaneFindHandle } from "@/pane-find";

/** The slice of Electron's `<webview>` tag that page search uses. */
export type FindableWebview = HTMLElement & {
  findInPage?: (text: string, options?: { forward?: boolean; findNext?: boolean }) => number;
  stopFindInPage?: (action: "clearSelection" | "keepSelection" | "activateSelection") => void;
};

interface FoundInPageEvent extends Event {
  result?: { activeMatchOrdinal: number; matches: number; finalUpdate: boolean };
}

interface BrowserFindState {
  open: boolean;
  query: string;
  /** Position of the active match; 0 before the first result arrives. */
  current: number;
  total: number;
  failed: boolean;
}

const CLOSED: BrowserFindState = { open: false, query: "", current: 0, total: 0, failed: false };

/**
 * Find in the page shown by the browser pane. The page lives in its own process, so the search is
 * Chromium's own (`webview.findInPage`), which paints the matches and the active one inside the
 * page. Electron offers match case only, so the widget carries no option toggles.
 *
 * Keys from a focused page reach this through the shortcut table (Cmd/Ctrl+F, Cmd/Ctrl+G, F3);
 * the pane forwards the main process's Escape report to `closeFind`.
 */
export function useBrowserFind(input: {
  webviewRef: RefObject<FindableWebview | null>;
  /** The pane is on screen and is the one the user is working in. */
  enabled: boolean;
}): { widget: ReactNode; closeFind(): void } {
  const { webviewRef, enabled } = input;
  const { t } = useTranslation();
  const widgetRef = useRef<PaneFindHandle>(null);
  const [state, setState] = useState<BrowserFindState>(CLOSED);
  const stateRef = useRef(state);
  stateRef.current = state;

  /** Runs one search. A new session when the query or page changed; otherwise steps to the next match. */
  const search = useCallback(
    (query: string, step: { newSession: true } | { forward: boolean }) => {
      const webview = webviewRef.current;
      if (!webview?.findInPage) return;
      if (query === "") {
        webview.stopFindInPage?.("clearSelection");
        setState((current) => ({ ...current, query, current: 0, total: 0, failed: false }));
        return;
      }
      try {
        webview.findInPage(
          query,
          "newSession" in step ? { findNext: true } : { forward: step.forward, findNext: false },
        );
        setState((current) => ({ ...current, query, failed: false }));
      } catch (error) {
        // Electron throws until the guest has loaded; say so in the widget instead of showing 0.
        console.warn("[browser-find] findInPage failed", error);
        setState((current) => ({ ...current, query, current: 0, total: 0, failed: true }));
      }
    },
    [webviewRef],
  );

  const { open } = state;
  useEffect(() => {
    const webview = webviewRef.current;
    if (!open || !webview) return;
    const handleFound = (event: Event) => {
      const result = (event as FoundInPageEvent).result;
      if (!result) return;
      setState((current) => ({
        ...current,
        current: result.activeMatchOrdinal,
        total: result.matches,
      }));
    };
    // A navigation replaces the document, and with it every match; search it afresh.
    const handleNavigated = () => {
      const { query } = stateRef.current;
      if (query) search(query, { newSession: true });
    };
    webview.addEventListener("found-in-page", handleFound);
    webview.addEventListener("did-navigate", handleNavigated);
    webview.addEventListener("did-navigate-in-page", handleNavigated);
    return () => {
      webview.removeEventListener("found-in-page", handleFound);
      webview.removeEventListener("did-navigate", handleNavigated);
      webview.removeEventListener("did-navigate-in-page", handleNavigated);
      // The guest outlives this pane, so its highlights must not.
      webview.stopFindInPage?.("clearSelection");
    };
  }, [open, search, webviewRef]);

  const openFind = useCallback(() => {
    setState((current) => ({ ...current, open: true }));
    widgetRef.current?.focus();
  }, []);
  const closeFind = useCallback(() => {
    if (!stateRef.current.open) return;
    setState((current) => ({ ...CLOSED, query: current.query }));
    webviewRef.current?.focus();
  }, [webviewRef]);
  const next = useCallback(() => search(stateRef.current.query, { forward: true }), [search]);
  const previous = useCallback(() => search(stateRef.current.query, { forward: false }), [search]);
  const setQuery = useCallback((query: string) => search(query, { newSession: true }), [search]);

  // Opening Find on a query left over from earlier searches it again, as the other panes do.
  useEffect(() => {
    if (open && stateRef.current.query) search(stateRef.current.query, { newSession: true });
  }, [open, search]);

  usePaneFindTarget(
    {
      open: openFind,
      // Next and previous act only while Find is open, so Cmd+G with Find closed stays unhandled.
      next: () => {
        if (!stateRef.current.open) return false;
        next();
      },
      previous: () => {
        if (!stateRef.current.open) return false;
        previous();
      },
    },
    enabled,
  );

  if (!state.open) return { widget: null, closeFind };
  let status = "";
  if (state.failed) status = t("paneFind.failed");
  else if (state.query) {
    if (state.total === 0) status = t("paneFind.noMatches");
    else if (state.current > 0)
      status = t("paneFind.position", { current: state.current, total: state.total });
    else status = t("paneFind.total", { total: state.total });
  }
  return {
    closeFind,
    widget: (
      <View style={styles.overlay} pointerEvents="box-none">
        <PaneFind
          ref={widgetRef}
          query={state.query}
          status={status}
          canNavigate={state.total > 0}
          onQueryChange={setQuery}
          onNext={next}
          onPrevious={previous}
          onClose={closeFind}
        />
      </View>
    ),
  };
}

const styles = StyleSheet.create((theme) => ({
  overlay: {
    position: "absolute",
    top: theme.spacing[2],
    left: theme.spacing[2],
    right: theme.spacing[3],
    alignItems: "flex-end",
    zIndex: 10,
  },
}));
