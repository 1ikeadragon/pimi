import {
  forwardRef,
  type MutableRefObject,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { Annotation, EditorState, Prec, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  WidgetType,
  keymap,
  placeholder as placeholderExtension,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { CHIP_CHARACTERS, chipPositions, chipSlot, stripChips } from "@/composer/chips/model";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import type { ComposerEditorChips, ComposerEditorProps } from "./types";

const COPY_MIME = "application/x-pimi-composer";
/** Marks a change the owner made through the handle, which it already knows about. */
const programmatic = Annotation.define<boolean>();

function chipExtension(
  mount: (element: HTMLElement, slot: number) => void,
  unmount: (element: HTMLElement) => void,
): Extension {
  class ChipWidget extends WidgetType {
    constructor(readonly slot: number) {
      super();
    }
    eq(other: ChipWidget) {
      return other.slot === this.slot;
    }
    toDOM() {
      const element = document.createElement("span");
      element.className = "cm-chip";
      element.contentEditable = "false";
      mount(element, this.slot);
      return element;
    }
    destroy(element: HTMLElement) {
      unmount(element);
    }
    ignoreEvent() {
      return true;
    }
  }
  const matcher = new MatchDecorator({
    regexp: CHIP_CHARACTERS,
    decoration: (match) => Decoration.replace({ widget: new ChipWidget(chipSlot(match[0])) }),
  });
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = matcher.createDeco(view);
      }
      update(update: ViewUpdate) {
        this.decorations = matcher.updateDeco(update, this.decorations);
      }
    },
    {
      decorations: (value) => value.decorations,
      provide: (pluginField) =>
        EditorView.atomicRanges.of(
          (view) => view.plugin(pluginField)?.decorations ?? Decoration.none,
        ),
    },
  );
  return plugin;
}

const editorTheme = EditorView.theme({
  "&": {
    color: "inherit",
    backgroundColor: "transparent",
    fontSize: "inherit",
    fontFamily: "inherit",
    lineHeight: "inherit",
    maxHeight: "inherit",
    minHeight: "inherit",
    height: "100%",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "inherit",
    lineHeight: "inherit",
    overflow: "auto",
    scrollbarGutter: "stable",
  },
  ".cm-content": { padding: "0", caretColor: "currentColor", minHeight: "inherit" },
  ".cm-line": { padding: "0" },
  ".cm-placeholder": { color: "var(--colors-foreground-muted)" },
  ".cm-chip": { display: "inline-block", verticalAlign: "-4px", margin: "0 1px" },
});

function copyText(
  state: EditorState,
  chips: ComposerEditorChips | undefined,
): { plain: string; model: string; hasChips: boolean } {
  const selected = state.selection.ranges
    .filter((range) => !range.empty)
    .map((range) => state.sliceDoc(range.from, range.to))
    .join(state.lineBreak);
  const plain = selected.replace(CHIP_CHARACTERS, (char) => chips?.plainText(chipSlot(char)) ?? "");
  return { plain, model: selected, hasChips: chipPositions(selected).length > 0 };
}

type PropsRef = MutableRefObject<ComposerEditorProps>;

// Above the default keymap, so Enter reaches the composer before CodeMirror inserts a line.
function composerDomHandlers(propsRef: PropsRef): Extension {
  return EditorView.domEventHandlers({
    keydown(event) {
      const handler = propsRef.current.onKeyPress;
      if (!handler) return false;
      handler({
        nativeEvent: {
          key: event.key,
          shiftKey: event.shiftKey,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          isComposing: event.isComposing,
          keyCode: event.keyCode,
        },
        preventDefault: () => event.preventDefault(),
      });
      return event.defaultPrevented;
    },
    focus() {
      propsRef.current.onFocus?.();
      return false;
    },
    blur() {
      propsRef.current.onBlur?.();
      return false;
    },
    copy(event, view) {
      const { plain, model, hasChips } = copyText(view.state, propsRef.current.chips);
      if (!hasChips || !event.clipboardData) return false;
      event.clipboardData.setData("text/plain", plain);
      const payload = propsRef.current.chips?.copy(model);
      if (payload) event.clipboardData.setData(COPY_MIME, payload);
      event.preventDefault();
      return true;
    },
    cut(event, view) {
      const { plain, model, hasChips } = copyText(view.state, propsRef.current.chips);
      if (!hasChips || !event.clipboardData) return false;
      event.clipboardData.setData("text/plain", plain);
      const payload = propsRef.current.chips?.copy(model);
      if (payload) event.clipboardData.setData(COPY_MIME, payload);
      event.preventDefault();
      view.dispatch(view.state.replaceSelection(""), { userEvent: "delete.cut" });
      return true;
    },
    paste(event, view) {
      const data = event.clipboardData;
      if (!data) return false;
      // Files belong to the composer's attachment handling, not the text.
      if (data.files.length > 0) return true;
      const payload = data.getData(COPY_MIME);
      const inserted = payload ? propsRef.current.chips?.paste(payload) : null;
      const plain = data.getData("text/plain");
      const stripped = stripChips(plain);
      const text = inserted ?? (stripped === plain ? null : stripped);
      if (text === null) return false;
      event.preventDefault();
      view.dispatch(view.state.replaceSelection(text), {
        userEvent: "input.paste",
        scrollIntoView: true,
      });
      return true;
    },
    drop(event) {
      return (event.dataTransfer?.files.length ?? 0) > 0;
    },
  });
}

function composerUpdateReporter(propsRef: PropsRef): Extension {
  return EditorView.updateListener.of((update) => {
    const own = update.transactions.some((transaction) => transaction.annotation(programmatic));
    if (update.docChanged && !own) propsRef.current.onChangeText(update.state.doc.toString());
    if (update.selectionSet || update.docChanged) {
      const { from, to } = update.state.selection.main;
      propsRef.current.onSelectionChange?.({ start: from, end: to });
    }
    if (update.docChanged || update.geometryChanged) {
      const content = update.view.contentDOM;
      const lineHeight = parseFloat(getComputedStyle(content).lineHeight);
      if (lineHeight > 0) {
        propsRef.current.onRenderedLinesChange?.(
          Math.max(1, Math.round(content.offsetHeight / lineHeight)),
        );
      }
    }
  });
}

// A Text carries the composer's typography (and unistyles themes it); its default inline layout
// would wrap the editor's block, so it is laid out as a box.
const styles = StyleSheet.create({ host: { display: "flex", flexDirection: "column" } });

export const ComposerEditor = forwardRef<EditingTextInputHandle, ComposerEditorProps>(
  function ComposerEditorWeb(props, ref) {
    const { chips, editable, placeholder, accessibilityLabel, style } = props;
    const hostRef = useRef<Text>(null);
    const viewRef = useRef<EditorView | null>(null);
    const propsRef = useRef(props);
    propsRef.current = props;
    const [mounts, setMounts] = useState<Map<HTMLElement, number>>(() => new Map());
    const mountChip = useCallback((element: HTMLElement, slot: number) => {
      setMounts((current) => new Map(current).set(element, slot));
    }, []);
    const unmountChip = useCallback((element: HTMLElement) => {
      setMounts((current) => {
        if (!current.has(element)) return current;
        const next = new Map(current);
        next.delete(element);
        return next;
      });
    }, []);

    const createState = useCallback(
      (doc: string) =>
        EditorState.create({
          doc,
          selection: { anchor: doc.length },
          extensions: [
            history(),
            EditorView.lineWrapping,
            editorTheme,
            chipExtension(mountChip, unmountChip),
            placeholderExtension(propsRef.current.placeholder),
            keymap.of([...defaultKeymap, ...historyKeymap]),
            EditorView.contentAttributes.of({
              "data-composer-input": "",
              role: "textbox",
              "aria-multiline": "true",
              "aria-label": propsRef.current.accessibilityLabel,
              spellcheck: "true",
              autocorrect: "on",
              autocapitalize: "sentences",
            }),
            EditorView.editable.of(propsRef.current.editable),
            // Above the default keymap, so Enter reaches the composer before CodeMirror inserts a line.
            Prec.highest(composerDomHandlers(propsRef)),
            composerUpdateReporter(propsRef),
          ],
        }),
      [mountChip, unmountChip],
    );

    useEffect(() => {
      // On web a Text's ref is its element.
      const host: unknown = hostRef.current;
      if (!(host instanceof HTMLElement)) return;
      const view = new EditorView({
        state: createState(propsRef.current.initialValue),
        parent: host,
      });
      viewRef.current = view;
      propsRef.current.onElementChange?.(view.contentDOM);
      if (propsRef.current.autoFocus) view.focus();
      return () => {
        propsRef.current.onElementChange?.(null);
        view.destroy();
        viewRef.current = null;
        setMounts(new Map());
      };
    }, [createState]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.contentDOM.setAttribute("aria-label", accessibilityLabel);
      view.contentDOM.contentEditable = editable ? "true" : "false";
    }, [accessibilityLabel, editable, placeholder]);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => viewRef.current?.focus(),
        blur: () => viewRef.current?.contentDOM.blur(),
        isFocused: () => viewRef.current?.hasFocus ?? false,
        getText: () => viewRef.current?.state.doc.toString() ?? "",
        replaceText: (nextText, selection) => {
          const view = viewRef.current;
          if (!view) return;
          const current = view.state.doc.toString();
          let start = 0;
          while (
            start < current.length &&
            start < nextText.length &&
            current[start] === nextText[start]
          )
            start += 1;
          let endCurrent = current.length;
          let endNext = nextText.length;
          while (
            endCurrent > start &&
            endNext > start &&
            current[endCurrent - 1] === nextText[endNext - 1]
          ) {
            endCurrent -= 1;
            endNext -= 1;
          }
          const caret = selection ?? { start: nextText.length, end: nextText.length };
          view.dispatch({
            changes: { from: start, to: endCurrent, insert: nextText.slice(start, endNext) },
            selection: { anchor: caret.start, head: caret.end },
            annotations: programmatic.of(true),
          });
        },
        setSelection: (selection) => {
          const length = viewRef.current?.state.doc.length ?? 0;
          viewRef.current?.dispatch({
            selection: {
              anchor: Math.min(selection.start, length),
              head: Math.min(selection.end, length),
            },
          });
        },
        reset: () => {
          // A fresh state, so undo cannot bring back a message that was already sent.
          viewRef.current?.setState(createState(""));
        },
        getNativeRef: () => viewRef.current?.contentDOM ?? null,
        getSelection: () => {
          const { from, to } = viewRef.current?.state.selection.main ?? { from: 0, to: 0 };
          return { start: from, end: to };
        },
      }),
      [createState],
    );

    const portals = useMemo(() => {
      if (!chips) return null;
      return Array.from(mounts, ([element, slot], index) =>
        createPortal(chips.render(slot), element, `${slot}:${index}`),
      );
    }, [chips, mounts]);

    return (
      <>
        <Text ref={hostRef} style={[style, styles.host]} />
        {portals}
      </>
    );
  },
);
