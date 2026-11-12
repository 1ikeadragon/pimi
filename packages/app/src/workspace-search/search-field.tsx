import { forwardRef, useCallback, useState, type ReactNode } from "react";
import { View, type NativeSyntheticEvent, type TextInputKeyPressEventData } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";

const ThemedInput = withUnistyles(EditingTextInput, (theme: Theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
  selectionColor: theme.colors.foreground,
}));

/** One bordered input of the Search view; its toggles sit inside the box on the right. */
export const SearchField = forwardRef<
  EditingTextInputHandle,
  {
    label: string;
    initialValue: string;
    onChangeText(value: string): void;
    onKeyPress?(event: NativeSyntheticEvent<TextInputKeyPressEventData>): void;
    children?: ReactNode;
    invalid?: boolean;
  }
>(function SearchField({ label, initialValue, onChangeText, onKeyPress, children, invalid }, ref) {
  const [focused, setFocused] = useState(false);
  const onFocus = useCallback(() => setFocused(true), []);
  const onBlur = useCallback(() => setFocused(false), []);
  return (
    <View
      style={[styles.field, focused && styles.fieldFocused, invalid ? styles.fieldInvalid : null]}
    >
      <ThemedInput
        ref={ref}
        initialValue={initialValue}
        onChangeText={onChangeText}
        onKeyPress={onKeyPress}
        onFocus={onFocus}
        onBlur={onBlur}
        accessibilityLabel={label}
        placeholder={label}
        autoCapitalize="none"
        autoCorrect={false}
        blurOnSubmit={false}
        returnKeyType="search"
        style={styles.input}
      />
      {children ? <View style={styles.trailing}>{children}</View> : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  field: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    minHeight: 28,
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  fieldFocused: {
    backgroundColor: theme.colors.surface2,
  },
  fieldInvalid: {
    borderColor: theme.colors.destructive,
  },
  input: {
    flex: 1,
    minWidth: 0,
    padding: 0,
    height: 20,
    outlineWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
  },
}));
