// Pimi. Apache-2.0.
// Shell-owned back/forward history for the Review screen. Slots never import this; they receive a
// `ReviewNavigation`.
import { useCallback, useMemo, useState } from "react";
import type { ReviewNavigation, ReviewViewState } from "./types";

const HISTORY_LIMIT = 40;

interface HistoryState {
  entries: ReviewViewState[];
  index: number;
}

export function useReviewHistory(initial: ReviewViewState): {
  current: ReviewViewState;
  navigation: ReviewNavigation;
} {
  const [history, setHistory] = useState<HistoryState>({ entries: [initial], index: 0 });

  const push = useCallback((next: Partial<ReviewViewState>) => {
    setHistory((state) => {
      const merged = { ...state.entries[state.index], ...next };
      if (JSON.stringify(merged) === JSON.stringify(state.entries[state.index])) return state;
      const entries = [...state.entries.slice(0, state.index + 1), merged].slice(-HISTORY_LIMIT);
      return { entries, index: entries.length - 1 };
    });
  }, []);
  const goBack = useCallback(
    () => setHistory((state) => ({ ...state, index: Math.max(0, state.index - 1) })),
    [],
  );
  const goForward = useCallback(
    () =>
      setHistory((state) => ({
        ...state,
        index: Math.min(state.entries.length - 1, state.index + 1),
      })),
    [],
  );

  const navigation = useMemo<ReviewNavigation>(
    () => ({
      canGoBack: history.index > 0,
      canGoForward: history.index < history.entries.length - 1,
      goBack,
      goForward,
      push,
    }),
    [history.index, history.entries.length, goBack, goForward, push],
  );
  return { current: history.entries[history.index], navigation };
}
