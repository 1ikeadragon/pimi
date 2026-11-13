import type { ReactNode } from "react";
import type { StyleProp, TextStyle } from "react-native";
import type { NativePastedFile } from "@/composer/native-pasted-image";

/** The slice of a key event the composer reads; the web editor builds it from the DOM event. */
export interface ComposerKeyEvent {
  nativeEvent: {
    key: string;
    shiftKey?: boolean;
    metaKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
    isComposing?: boolean;
    keyCode?: number;
  };
  preventDefault(): void;
}

/** What the editor needs to draw chips and carry them through the clipboard. */
export interface ComposerEditorChips {
  render(slot: number): ReactNode;
  /** What a chip reads as when copied out of the app. */
  plainText(slot: number): string;
  /** The copied text with the annotations behind its chips, as a string the clipboard can carry. */
  copy(text: string): string;
  /** Recreates copied chips as new annotations; returns the copied text holding their new chips. */
  paste(payload: string): string | null;
}

export interface ComposerEditorProps {
  initialValue: string;
  onChangeText(text: string): void;
  onSelectionChange?(selection: { start: number; end: number }): void;
  onKeyPress?(event: ComposerKeyEvent): void;
  onFocus?(): void;
  onBlur?(): void;
  placeholder: string;
  accessibilityLabel: string;
  editable: boolean;
  autoFocus: boolean;
  style: StyleProp<TextStyle>;
  /** Native only: whether the input scrolls itself. */
  scrollEnabled: boolean;
  onPasteImages?: (files: readonly NativePastedFile[]) => void;
  onPasteError?: (message: string) => void;
  /** Web only: reports how many lines the content wraps to. */
  onRenderedLinesChange?: (lines: number) => void;
  /** Web only: the element that takes focus and key events, for listeners the composer adds. */
  onElementChange?: (element: HTMLElement | null) => void;
  chips?: ComposerEditorChips;
}
