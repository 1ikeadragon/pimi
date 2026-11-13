import { forwardRef, useCallback } from "react";
import type { NativeSyntheticEvent, TextInputSelectionChangeEventData } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import type { ComposerEditorProps } from "./types";

const ThemedInput = withUnistyles(EditingTextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));

/** On native the composer is a plain text input; chips show as circled numerals in its text. */
export const ComposerEditor = forwardRef<EditingTextInputHandle, ComposerEditorProps>(
  function ComposerEditorNative(props, ref) {
    const {
      onSelectionChange,
      onKeyPress: _onKeyPress,
      onRenderedLinesChange: _onRenderedLinesChange,
      chips: _chips,
      onElementChange: _onElementChange,
      ...input
    } = props;
    const handleSelection = useCallback(
      (event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
        const start = event.nativeEvent.selection?.start ?? 0;
        onSelectionChange?.({ start, end: event.nativeEvent.selection?.end ?? start });
      },
      [onSelectionChange],
    );
    return <ThemedInput ref={ref} {...input} multiline onSelectionChange={handleSelection} />;
  },
);
