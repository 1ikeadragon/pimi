import { type RefObject, useEffect } from "react";
import type { View } from "react-native";
import type { EditingTextInputHandle } from "@/components/ui/text-input";

// Anything in the composer box that takes its own clicks: toolbar buttons, menus, attachment chips.
const OWN_CLICK_TARGETS =
  'button, a[href], input, textarea, select, [role="button"], [role="link"], [role="checkbox"], [role="switch"], [role="menuitem"], [role="tab"], [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/**
 * A press anywhere on the composer box that no control claims focuses the editor with the caret at
 * the end. CodeMirror only handles presses on its content line; below it is `.cm-scroller`, which
 * CodeMirror gives `tabIndex = -1`, so a press there focused the scroller instead of the text. The
 * next keystroke then went nowhere and made the scroller match `:focus-visible`, which drew the
 * app's focus ring around the text area. The padding and toolbar gaps focused nothing at all.
 */
export function useComposerSurfaceFocus(
  wrapperRef: RefObject<View | null>,
  editorRef: RefObject<EditingTextInputHandle | null>,
  editorElement: HTMLElement | null,
): void {
  useEffect(() => {
    // On web a View's ref is its element.
    const wrapper: unknown = wrapperRef.current;
    if (!(wrapper instanceof HTMLElement) || !editorElement) return;
    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0 || event.defaultPrevented) return;
      const target = event.target;
      if (!(target instanceof Element) || editorElement.contains(target)) return;
      if (editorElement.contentEditable !== "true") return;
      const control = target.closest(OWN_CLICK_TARGETS);
      if (control && wrapper.contains(control)) return;
      // A press on the editor's own scrollbar scrolls it.
      if (
        target.classList.contains("cm-scroller") &&
        (event.offsetX >= target.clientWidth || event.offsetY >= target.clientHeight)
      ) {
        return;
      }
      const editor = editorRef.current;
      if (!editor) return;
      event.preventDefault();
      editor.focus();
      const end = editor.getText().length;
      editor.setSelection({ start: end, end });
    };
    wrapper.addEventListener("mousedown", onMouseDown);
    return () => wrapper.removeEventListener("mousedown", onMouseDown);
  }, [wrapperRef, editorRef, editorElement]);
}
