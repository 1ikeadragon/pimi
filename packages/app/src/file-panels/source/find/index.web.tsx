import {
  useCallback,
  useMemo,
  useEffect,
  useRef,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { EditorView } from "@codemirror/view";
import { View, type View as ViewInstance } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "@/i18n/use-translation";
import {
  PaneFind,
  usePaneFindTarget,
  type PaneFindHandle,
  type PaneFindOptions,
} from "@/pane-find";
import { usePaneFocus } from "@/panels/pane-context";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useEditorCommands } from "../editor/use-editor-commands.web";
import { FileFindModel } from "./model.web";

export { FileFindModel } from "./model.web";

export function FileFind({
  model,
  editor,
}: {
  model: FileFindModel;
  editor: RefObject<EditorView | null>;
}) {
  const { t } = useTranslation();
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const widget = useRef<PaneFindHandle>(null);
  const { isInteractive } = usePaneFocus();
  const active = useRetainedPanelActive();
  // RN Web hands the underlying DOM element to a View ref; the model measures it.
  const setWidgetNode = useCallback(
    (node: ViewInstance | null) => model.setWidgetNode(node as unknown as HTMLElement | null),
    [model],
  );
  const enabled = isInteractive && active;
  // Replace opened from a closed Find: the widget mounts after the model reports open, so the
  // request waits for it.
  const pendingReplace = useRef(false);
  useEffect(() => {
    if (!state.open || !pendingReplace.current || !widget.current) return;
    pendingReplace.current = false;
    widget.current.openReplace();
  }, [state.open]);
  const toggle = (option: "case" | "word" | "regex") => {
    if (!model.getSnapshot().open) return false;
    model.toggleOption(option);
  };
  usePaneFindTarget(
    {
      open: () => {
        model.open(editor.current);
        widget.current?.focus();
      },
      // Next and previous act only while Find is open, so Cmd+G with Find closed stays unhandled.
      next: () => {
        if (!model.getSnapshot().open) return false;
        model.next();
      },
      previous: () => {
        if (!model.getSnapshot().open) return false;
        model.previous();
      },
      openReplace: () => {
        const view = editor.current;
        if (!view || view.state.readOnly) return false;
        model.open(view);
        if (widget.current) widget.current.openReplace();
        else pendingReplace.current = true;
      },
      toggleCase: () => toggle("case"),
      toggleWord: () => toggle("word"),
      toggleRegex: () => toggle("regex"),
    },
    enabled,
  );
  useEditorCommands(editor, enabled);

  const options = useMemo<PaneFindOptions>(
    () => ({
      caseSensitive: state.caseSensitive,
      wholeWord: state.wholeWord,
      regex: state.regex,
      onToggle: model.toggleOption,
    }),
    [model, state.caseSensitive, state.regex, state.wholeWord],
  );
  const replace = useMemo(
    () =>
      state.readOnly
        ? undefined
        : {
            value: state.replacement,
            onChange: model.setReplacement,
            onReplace: model.replace,
            onReplaceAll: model.replaceAll,
          },
    [model, state.readOnly, state.replacement],
  );
  if (!state.open) return null;
  const total = `${state.total}${state.limited ? "+" : ""}`;
  let status = "";
  if (state.query) {
    if (state.invalid) status = t("paneFind.invalidRegex");
    else if (state.total === 0) status = t("paneFind.noMatches");
    else if (state.current) status = t("paneFind.position", { current: state.current, total });
    else status = t("paneFind.total", { total });
  }
  return (
    <View
      style={[styles.overlay, state.placement === "top" ? styles.overlayTop : styles.overlayBottom]}
      pointerEvents="box-none"
    >
      <View ref={setWidgetNode} style={styles.widget}>
        <PaneFind
          ref={widget}
          query={state.query}
          status={status}
          canNavigate={state.total > 0}
          onQueryChange={model.setSearch}
          onNext={model.next}
          onPrevious={model.previous}
          onClose={model.close}
          options={options}
          replace={replace}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The widget floats over the content; the model flips the corner when it would
  // otherwise sit on top of the active match.
  overlay: {
    position: "absolute",
    left: theme.spacing[2],
    right: theme.spacing[2],
    alignItems: "flex-end",
    zIndex: 1,
  },
  // Bounds the widget to the pane; PaneFind's own maxWidth resolves against this.
  widget: { maxWidth: "100%" },
  overlayTop: { top: theme.spacing[2] },
  overlayBottom: { bottom: theme.spacing[2] },
}));
