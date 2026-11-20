import type { RefObject } from "react";
import type { View } from "react-native";
import type { EditingTextInputHandle } from "@/components/ui/text-input";

/** Web only: a tap on native already reaches the TextInput, which fills the text surface. */
export function useComposerSurfaceFocus(
  _wrapperRef: RefObject<View | null>,
  _editorRef: RefObject<EditingTextInputHandle | null>,
  _editorElement: HTMLElement | null,
): void {}
