import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";
import type { NativeSyntheticEvent, TextInputSelectionChangeEventData } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { chipsToNumerals, numeralsToChips } from "@/composer/chips/model";
import type { ComposerEditorProps } from "./types";

const ThemedInput = withUnistyles(EditingTextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));

/**
 * On native the composer is a plain text input, which cannot host a view. A chip shows as a
 * circled numeral, the same length as the chip character, so offsets agree; the tray above holds
 * the chip with the matching numeral. Everything outside this file sees chip characters.
 */
export const ComposerEditor = forwardRef<EditingTextInputHandle, ComposerEditorProps>(
  function ComposerEditorNative(props, ref) {
    const {
      onSelectionChange,
      onChangeText,
      initialValue,
      onKeyPress: _onKeyPress,
      onRenderedLinesChange: _onRenderedLinesChange,
      onElementChange: _onElementChange,
      chips: _chips,
      ...input
    } = props;
    const inner = useRef<EditingTextInputHandle>(null);
    useImperativeHandle(
      ref,
      () => ({
        focus: () => inner.current?.focus(),
        blur: () => inner.current?.blur(),
        isFocused: () => inner.current?.isFocused() ?? false,
        getText: () => numeralsToChips(inner.current?.getText() ?? ""),
        replaceText: (text, selection) =>
          inner.current?.replaceText(chipsToNumerals(text), selection),
        setSelection: (selection) => inner.current?.setSelection(selection),
        reset: () => inner.current?.reset(),
        getNativeRef: () => inner.current?.getNativeRef(),
      }),
      [],
    );
    const handleChangeText = useCallback(
      (text: string) => onChangeText(numeralsToChips(text)),
      [onChangeText],
    );
    const handleSelection = useCallback(
      (event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
        const start = event.nativeEvent.selection?.start ?? 0;
        onSelectionChange?.({ start, end: event.nativeEvent.selection?.end ?? start });
      },
      [onSelectionChange],
    );
    return (
      <ThemedInput
        ref={inner}
        {...input}
        initialValue={chipsToNumerals(initialValue)}
        onChangeText={handleChangeText}
        multiline
        onSelectionChange={handleSelection}
      />
    );
  },
);
