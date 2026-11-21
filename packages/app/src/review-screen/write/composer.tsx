// Pimi. PolyForm-Noncommercial-1.0.0.
// A comment box for the conversation and for thread replies. Submitting clears it at once; if the
// daemon refuses (or the connection drops) the text comes back with one red sentence and a Retry.
// A retry of the same text reuses the first attempt's mutation id, so the daemon posts it once.
import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "@/i18n/use-translation";
import { Button } from "@/components/ui/button";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { isWeb } from "@/constants/platform";
import { isMacUserAgent } from "@/utils/mac-user-agent";
import { newMutationId, type WriteResult } from "./use-review-writes";

const SUBMIT_HINT = isMacUserAgent() ? "⌘↵" : "Ctrl+↵";

interface Failed {
  body: string;
  mutationId: string;
  message: string;
}

/** Cmd/Ctrl+Enter submits and Escape cancels, on the web input element. */
export function useComposerKeys(
  inputRef: React.RefObject<EditingTextInputHandle | null>,
  handlers: { onSubmit: () => void; onCancel?: () => void },
) {
  const { onSubmit, onCancel } = handlers;
  useEffect(() => {
    if (!isWeb) return;
    const element = inputRef.current?.getNativeRef();
    if (typeof HTMLElement === "undefined" || !(element instanceof HTMLElement)) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && onCancel) {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
        return;
      }
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        onSubmit();
      }
    };
    element.addEventListener("keydown", onKeyDown);
    return () => element.removeEventListener("keydown", onKeyDown);
  }, [inputRef, onCancel, onSubmit]);
}

export function ReviewComposer({
  placeholder,
  submitLabel,
  disabled,
  autoFocus,
  onSubmit,
  onCancel,
  testID,
}: {
  placeholder: string;
  submitLabel: string;
  disabled: boolean;
  autoFocus?: boolean;
  onSubmit: (body: string, mutationId: string) => Promise<WriteResult>;
  /** Present for a composer that can be dismissed (a reply box). */
  onCancel?: () => void;
  testID: string;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<EditingTextInputHandle | null>(null);
  const textRef = useRef("");
  const [hasText, setHasText] = useState(false);
  const [focused, setFocused] = useState(false);
  const [failed, setFailed] = useState<Failed | null>(null);
  const failedRef = useRef<Failed | null>(null);
  failedRef.current = failed;

  const onChangeText = useCallback((text: string) => {
    textRef.current = text;
    setHasText(text.trim().length > 0);
  }, []);

  const send = useCallback(
    async (body: string, mutationId: string) => {
      setFailed(null);
      inputRef.current?.reset();
      textRef.current = "";
      setHasText(false);
      const result = await onSubmit(body, mutationId);
      if (result.ok) return;
      const next = { body, mutationId, message: result.failure.message };
      setFailed(next);
      // Text is never lost: it returns unless the user has already started something new.
      if (textRef.current.trim() === "") {
        inputRef.current?.replaceText(body);
        textRef.current = body;
        setHasText(true);
      }
    },
    [onSubmit],
  );

  const submit = useCallback(() => {
    const body = textRef.current.trim();
    if (!body || disabled) return;
    const previous = failedRef.current;
    void send(body, previous && previous.body === body ? previous.mutationId : newMutationId());
  }, [disabled, send]);

  const retry = useCallback(() => {
    const previous = failedRef.current;
    if (!previous || disabled) return;
    void send(previous.body, previous.mutationId);
  }, [disabled, send]);

  useComposerKeys(inputRef, { onSubmit: submit, onCancel });
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const onFocus = useCallback(() => setFocused(true), []);
  const onBlur = useCallback(() => setFocused(false), []);

  return (
    <View style={[styles.box, focused && styles.boxFocused]} testID={testID}>
      <EditingTextInput
        ref={inputRef}
        multiline
        accessibilityLabel={placeholder}
        placeholder={placeholder}
        placeholderTextColor={styles.placeholder.color}
        onChangeText={onChangeText}
        onFocus={onFocus}
        onBlur={onBlur}
        style={styles.input}
        testID={`${testID}-input`}
      />
      <View style={styles.footer}>
        {failed ? (
          <View style={styles.errorRow}>
            <Text style={styles.error} numberOfLines={2} testID={`${testID}-error`}>
              {failed.message}
            </Text>
            <Button
              size="sm"
              variant="ghost"
              onPress={retry}
              disabled={disabled}
              testID={`${testID}-retry`}
            >
              {t("reviewScreen.write.retry")}
            </Button>
          </View>
        ) : (
          <Text style={styles.hint}>{SUBMIT_HINT}</Text>
        )}
        {onCancel ? (
          <Button size="sm" variant="ghost" onPress={onCancel} testID={`${testID}-cancel`}>
            {t("reviewScreen.write.cancel")}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="default"
          disabled={disabled || !hasText}
          onPress={submit}
          testID={`${testID}-submit`}
        >
          {submitLabel}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  box: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[2],
    gap: theme.spacing[2],
  },
  boxFocused: { borderColor: theme.colors.accent },
  placeholder: { color: theme.colors.foregroundMuted },
  input: {
    minHeight: 64,
    maxHeight: 240,
    color: theme.colors.foreground,
    backgroundColor: "transparent",
    borderWidth: 0,
    paddingHorizontal: theme.spacing[1],
    paddingVertical: 0,
    fontSize: theme.fontSize.base,
    lineHeight: 20,
    textAlignVertical: "top",
    ...(isWeb ? { outlineWidth: 0, outlineColor: "transparent" } : {}),
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[1],
  },
  hint: {
    flex: 1,
    paddingHorizontal: theme.spacing[1],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  errorRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    minWidth: 0,
  },
  error: { flexShrink: 1, color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
}));
