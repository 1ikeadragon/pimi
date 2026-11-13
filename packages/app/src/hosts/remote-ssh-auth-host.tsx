import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Eye, EyeOff } from "lucide-react-native";
import { AdaptiveModalSheet, AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { isElectronRuntime } from "@/desktop/host";
import {
  answerRemoteSshAuth,
  listenToRemoteSshAuthRequests,
  listPendingRemoteSshAuth,
  type RemoteSshAuthRequest,
} from "@/desktop/daemon/desktop-daemon";

// ssh reads at most 1023 bytes from its askpass program.
const SECRET_BYTE_LIMIT = 1000;
const FLEX_ONE_STYLE = { flex: 1 } as const;
const textEncoder = new TextEncoder();

/**
 * Mounted once by the app shell. When ssh asks for a password, passphrase or code, the desktop
 * sends the prompt here and ssh waits for the answer. The prompt text comes from the remote
 * machine, so it is shown as plain text only.
 */
export function RemoteSshAuthHost() {
  if (!isElectronRuntime()) return null;
  return <RemoteSshAuthPrompt />;
}

function RemoteSshAuthPrompt() {
  const { t } = useTranslation();
  const [queue, setQueue] = useState<RemoteSshAuthRequest[]>([]);
  const [isVisible, setIsVisible] = useState(false);
  const [isTooLong, setIsTooLong] = useState(false);
  const [answerError, setAnswerError] = useState("");
  const secretRef = useRef("");
  const current = queue[0] ?? null;

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    const add = (request: RemoteSshAuthRequest) =>
      setQueue((previous) =>
        previous.some((item) => item.promptId === request.promptId)
          ? previous
          : [...previous, request],
      );
    const subscribe = async () => {
      const stop = await listenToRemoteSshAuthRequests({
        onRequest: add,
        onDismiss: (promptId) =>
          setQueue((previous) => previous.filter((item) => item.promptId !== promptId)),
      });
      if (cancelled) {
        stop();
        return;
      }
      unlisten = stop;
      for (const request of await listPendingRemoteSshAuth()) add(request);
    };
    void subscribe();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const promptId = current?.promptId ?? null;
  useEffect(() => {
    secretRef.current = "";
    setIsVisible(false);
    setIsTooLong(false);
    setAnswerError("");
  }, [promptId]);

  const handleChange = useCallback((value: string) => {
    secretRef.current = value;
    setIsTooLong(textEncoder.encode(value).length > SECRET_BYTE_LIMIT);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!current || textEncoder.encode(secretRef.current).length > SECRET_BYTE_LIMIT) return;
    const secret = secretRef.current;
    secretRef.current = "";
    setQueue((previous) => previous.filter((item) => item.promptId !== current.promptId));
    try {
      await answerRemoteSshAuth(current.promptId, { secret });
    } catch (error) {
      setAnswerError(error instanceof Error ? error.message : String(error));
    }
  }, [current]);
  const handleSubmitPress = useCallback(() => void handleSubmit(), [handleSubmit]);

  const handleCancel = useCallback(async () => {
    if (!current) return;
    secretRef.current = "";
    setQueue((previous) => previous.filter((item) => item.promptId !== current.promptId));
    await answerRemoteSshAuth(current.promptId, { cancel: true });
  }, [current]);
  const handleCancelPress = useCallback(() => void handleCancel(), [handleCancel]);

  const handleToggleVisible = useCallback(() => setIsVisible((previous) => !previous), []);

  const header = useMemo(
    () => ({ title: t("remoteDev.auth.title", { host: current?.host ?? "" }) }),
    [current?.host, t],
  );
  if (!current) return null;
  const VisibilityIcon = isVisible ? ThemedEyeOff : ThemedEye;
  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={handleCancelPress}
      testID="remote-ssh-auth-modal"
    >
      <Text style={styles.prompt} selectable testID="remote-ssh-auth-prompt">
        {current.prompt}
      </Text>
      {current.retry ? <Alert variant="error" description={t("remoteDev.auth.retry")} /> : null}
      <View style={styles.inputRow}>
        <View style={styles.inputWrap}>
          <ThemedAdaptiveTextInput
            testID="remote-ssh-auth-input"
            accessibilityLabel={t("remoteDev.auth.inputLabel")}
            initialValue=""
            resetKey={current.promptId}
            onChangeText={handleChange}
            style={styles.input}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry={!isVisible}
            returnKeyType="done"
            onSubmitEditing={handleSubmitPress}
          />
        </View>
        <PressHighlight
          style={styles.iconButton}
          onPress={handleToggleVisible}
          accessibilityRole="button"
          accessibilityLabel={
            isVisible
              ? t("pairing.remoteSsh.passwordVisibility.hide")
              : t("pairing.remoteSsh.passwordVisibility.show")
          }
          testID="remote-ssh-auth-visibility-toggle"
        >
          <VisibilityIcon size={18} />
        </PressHighlight>
      </View>
      {answerError ? <Alert variant="error" description={answerError} /> : null}
      <View style={styles.actions}>
        <Button
          style={FLEX_ONE_STYLE}
          variant="secondary"
          onPress={handleCancelPress}
          testID="remote-ssh-auth-cancel"
        >
          {t("remoteDev.auth.cancel")}
        </Button>
        <Button
          style={FLEX_ONE_STYLE}
          onPress={handleSubmitPress}
          disabled={isTooLong}
          testID="remote-ssh-auth-submit"
        >
          {t("remoteDev.auth.submit")}
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}

const ThemedEye = withUnistyles(Eye, (theme) => ({ color: theme.colors.foregroundMuted }));
const ThemedEyeOff = withUnistyles(EyeOff, (theme) => ({ color: theme.colors.foregroundMuted }));
const ThemedAdaptiveTextInput = withUnistyles(AdaptiveTextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));

const styles = StyleSheet.create((theme) => ({
  prompt: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  inputRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  inputWrap: { flex: 1, minWidth: 0 },
  input: {
    width: "100%",
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    color: theme.colors.foreground,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  iconButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  actions: { flexDirection: "row", gap: theme.spacing[3], marginTop: theme.spacing[2] },
}));
