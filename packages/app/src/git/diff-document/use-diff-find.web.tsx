import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { ParsedDiffFile } from "@pimi/protocol/messages";
import {
  PaneFind,
  usePaneFindTarget,
  type PaneFindHandle,
  type PaneFindOption,
  type PaneFindOptions,
} from "@/pane-find";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useOptionalPaneFocus } from "@/panels/pane-context";
import {
  buildDiffFindHighlights,
  diffFindMatchKey,
  diffFindMatchRowIndex,
  diffFindMatchSelection,
  findInDiff,
  NO_DIFF_FIND_MATCHES,
  type DiffFindHighlights,
  type DiffFindMatch,
  type DiffFindOptions,
  type DiffFindResult,
} from "./find";
import { selectionRectangles } from "./hit-testing";
import { FILE_HEADER_HEIGHT } from "./model";
import type { DiffDocumentModel } from "./types";

const CLOSED_OPTIONS: DiffFindOptions = {
  query: "",
  caseSensitive: false,
  wholeWord: false,
  regex: false,
};
const WIDGET_GAP = 8;

interface DiffFindInput {
  files: readonly ParsedDiffFile[];
  layout: "unified" | "split";
  collapsedFilePaths: ReadonlySet<string>;
  model: DiffDocumentModel;
  modelRef: RefObject<DiffDocumentModel | null>;
  scrollRef: RefObject<HTMLDivElement | null>;
  rootRef: RefObject<HTMLDivElement | null>;
  scrollTopRef: RefObject<number>;
  horizontalOffsetsRef: RefObject<Map<string, number>>;
  viewportHeight: number;
  /** The painter reads highlights from here, so a change only needs a repaint, not a render. */
  highlightsRef: MutableRefObject<DiffFindHighlights | null>;
  /** One line of selected source text to seed the query with, or null. */
  readSeed(): string | null;
  schedulePaint(): void;
}

/**
 * Find for the diff canvas. The canvas has no DOM text for the browser to search, so this searches
 * the diff's source lines (`findInDiff`), paints the matches through the canvas painter, and
 * scrolls the active one into view. Everything the user sees of Find besides the highlights is the
 * shared `PaneFind` widget, registered through `usePaneFindTarget` like every other pane.
 */
export function useDiffFind(input: DiffFindInput): {
  widget: ReactNode;
  /** Closes Find when it is open; false when there was nothing to close. */
  closeFind(): boolean;
} {
  const { t } = useTranslation();
  const paneFocus = useOptionalPaneFocus();
  const retainedActive = useRetainedPanelActive();
  const widgetRef = useRef<PaneFindHandle>(null);
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<DiffFindOptions>(CLOSED_OPTIONS);
  const [widgetHeight, setWidgetHeight] = useState(0);
  const [active, setActive] = useState<{ result: DiffFindResult; index: number }>({
    result: NO_DIFF_FIND_MATCHES,
    index: -1,
  });
  const activeKeyRef = useRef<string | null>(null);
  const pendingRevealRef = useRef<DiffFindMatch | null>(null);
  const inputRef = useRef(input);
  inputRef.current = input;

  const { files, layout, collapsedFilePaths } = input;
  const result = useMemo(
    () =>
      open ? findInDiff({ files, layout, collapsedFilePaths, options }) : NO_DIFF_FIND_MATCHES,
    [open, files, layout, collapsedFilePaths, options],
  );
  const { matches } = result;
  const activeIndex = active.result === result ? active.index : -1;

  const select = useCallback((index: number, nextResult: DiffFindResult) => {
    const match = nextResult.matches[index];
    activeKeyRef.current = match ? diffFindMatchKey(match) : null;
    pendingRevealRef.current = match ?? null;
    setActive({ result: nextResult, index });
  }, []);

  // A new result set keeps the match Find was on when it still exists. Otherwise Find lands on the
  // first match at or below the top of the viewport, and wraps to the first match when none is.
  useLayoutEffect(() => {
    if (result.matches.length === 0) {
      activeKeyRef.current = null;
      pendingRevealRef.current = null;
      setActive({ result, index: -1 });
      return;
    }
    const previousKey = activeKeyRef.current;
    const kept = previousKey
      ? result.matches.findIndex((match) => diffFindMatchKey(match) === previousKey)
      : -1;
    if (kept >= 0) {
      setActive({ result, index: kept });
      return;
    }
    const { modelRef, scrollTopRef } = inputRef.current;
    const model = modelRef.current;
    const viewportTop = scrollTopRef.current ?? 0;
    const firstBelow = model
      ? result.matches.findIndex((match) => {
          const rowIndex = diffFindMatchRowIndex(model, match);
          const row = rowIndex === null ? undefined : model.rows[rowIndex];
          return row !== undefined && row.top >= viewportTop;
        })
      : -1;
    select(Math.max(0, firstBelow), result);
  }, [result, select]);

  const highlights = useMemo(
    () =>
      open && matches.length > 0
        ? buildDiffFindHighlights(input.model, matches, activeIndex)
        : null,
    [open, matches, activeIndex, input.model],
  );
  const { highlightsRef, schedulePaint } = input;
  useLayoutEffect(() => {
    highlightsRef.current = highlights;
    schedulePaint();
  }, [highlights, highlightsRef, schedulePaint]);

  // Scrolls the match into view. Rows outside the scroll window have no measured text, so this
  // runs again for every new model until the match's cell is measured and on screen.
  const { model, viewportHeight, scrollRef, rootRef, horizontalOffsetsRef } = input;
  useLayoutEffect(() => {
    const match = pendingRevealRef.current;
    const scroll = scrollRef.current;
    if (!match || !scroll || viewportHeight <= 0) return;
    const rowIndex = diffFindMatchRowIndex(model, match);
    const row = rowIndex === null ? undefined : model.rows[rowIndex];
    if (row?.kind !== "line") {
      pendingRevealRef.current = null;
      return;
    }
    const inset = FILE_HEADER_HEIGHT + (widgetHeight > 0 ? widgetHeight + WIDGET_GAP : 0);
    const scrollTop = scroll.scrollTop;
    const rowBottom = row.top + row.height - row.reviewHeight;
    if (row.top < scrollTop + inset || rowBottom > scrollTop + viewportHeight) {
      scroll.scrollTop = Math.max(0, row.top - viewportHeight / 3);
      return;
    }
    const cell = row.cells[match.cellIndex];
    if (!cell || cell.fragments.length === 0) return;
    pendingRevealRef.current = null;
    if (!model.wrapLines) {
      revealHorizontally({
        model,
        match,
        offsets: horizontalOffsetsRef,
        root: rootRef,
        schedulePaint,
      });
    }
  }, [
    model,
    active,
    viewportHeight,
    widgetHeight,
    scrollRef,
    rootRef,
    horizontalOffsetsRef,
    schedulePaint,
  ]);

  const move = useCallback(
    (direction: 1 | -1) => {
      if (result.matches.length === 0) return;
      const count = result.matches.length;
      let from = activeIndex;
      if (activeIndex < 0) from = direction === 1 ? -1 : 0;
      select((from + direction + count) % count, result);
    },
    [activeIndex, result, select],
  );
  const next = useCallback(() => move(1), [move]);
  const previous = useCallback(() => move(-1), [move]);

  const openFind = useCallback(() => {
    const seed = inputRef.current.readSeed();
    setOpen(true);
    if (seed) setOptions((current) => ({ ...current, query: seed }));
    widgetRef.current?.focus();
  }, []);
  const closeFind = useCallback(() => {
    if (!open) return false;
    setOpen(false);
    activeKeyRef.current = null;
    pendingRevealRef.current = null;
    inputRef.current.scrollRef.current?.focus();
    return true;
  }, [open]);
  const toggle = useCallback((option: PaneFindOption) => {
    setOptions((current) => {
      if (option === "case") return { ...current, caseSensitive: !current.caseSensitive };
      if (option === "word") return { ...current, wholeWord: !current.wholeWord };
      return { ...current, regex: !current.regex };
    });
  }, []);
  const setQuery = useCallback(
    (query: string) => setOptions((current) => ({ ...current, query })),
    [],
  );

  // The Review screen shows a diff outside any pane, where the diff is the only Find target.
  const enabled = retainedActive && (paneFocus?.isInteractive ?? true);
  usePaneFindTarget(
    {
      open: openFind,
      // Next and previous act only while Find is open, so Cmd+G with Find closed stays unhandled.
      next: () => {
        if (!open) return false;
        next();
      },
      previous: () => {
        if (!open) return false;
        previous();
      },
      toggleCase: () => {
        if (!open) return false;
        toggle("case");
      },
      toggleWord: () => {
        if (!open) return false;
        toggle("word");
      },
      toggleRegex: () => {
        if (!open) return false;
        toggle("regex");
      },
    },
    enabled,
  );

  const paneOptions = useMemo<PaneFindOptions>(
    () => ({
      caseSensitive: options.caseSensitive,
      wholeWord: options.wholeWord,
      regex: options.regex,
      onToggle: toggle,
    }),
    [options.caseSensitive, options.regex, options.wholeWord, toggle],
  );
  const measureWidget = useCallback(
    (event: LayoutChangeEvent) => setWidgetHeight(event.nativeEvent.layout.height),
    [],
  );

  if (!open) return { widget: null, closeFind };
  const total = `${matches.length}${result.limited ? "+" : ""}`;
  let status = "";
  if (options.query) {
    if (result.invalid) status = t("paneFind.invalidRegex");
    else if (matches.length === 0) status = t("paneFind.noMatches");
    else if (activeIndex >= 0) status = t("paneFind.position", { current: activeIndex + 1, total });
    else status = t("paneFind.total", { total });
  }
  return {
    closeFind,
    widget: (
      <View style={styles.overlay} pointerEvents="box-none">
        <View onLayout={measureWidget} style={styles.widget}>
          <PaneFind
            ref={widgetRef}
            query={options.query}
            status={status}
            canNavigate={matches.length > 0}
            onQueryChange={setQuery}
            onNext={next}
            onPrevious={previous}
            onClose={closeFind}
            options={paneOptions}
          />
        </View>
      </View>
    ),
  };
}

/**
 * Slides the file's horizontal scroller so the match's columns are on screen. The scroller exists
 * while its file is near the viewport and reports the clamped offset through its own scroll event,
 * which repaints.
 */
function revealHorizontally(input: {
  model: DiffDocumentModel;
  match: DiffFindMatch;
  offsets: RefObject<Map<string, number>>;
  root: RefObject<HTMLDivElement | null>;
  schedulePaint(): void;
}): void {
  const { model, match } = input;
  const selection = diffFindMatchSelection(model, match);
  const rectangle = selection ? selectionRectangles({ model, selection })[0] : undefined;
  const file = model.files[match.fileIndex];
  if (!rectangle || !file) return;
  const offset = input.offsets.current?.get(file.path) ?? 0;
  const contentX = rectangle.x - rectangle.clipX;
  if (contentX >= offset && contentX + rectangle.width <= offset + rectangle.clipWidth) return;
  const nextOffset = Math.max(0, contentX - rectangle.clipWidth / 3);
  input.offsets.current?.set(file.path, nextOffset);
  const scroller = input.root.current?.querySelector<HTMLElement>(
    `[data-testid="diff-file-${match.fileIndex}-horizontal-scroll"]`,
  );
  if (scroller) scroller.scrollLeft = nextOffset;
  else input.schedulePaint();
}

const styles = StyleSheet.create((theme) => ({
  // Above the scroll layer, so the widget takes the pointer instead of the canvas.
  overlay: {
    position: "absolute",
    top: theme.spacing[2],
    left: theme.spacing[2],
    right: theme.spacing[3],
    alignItems: "flex-end",
    zIndex: 6,
  },
  widget: { maxWidth: "100%" },
}));
