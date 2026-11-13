import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "@/i18n/use-translation";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Terminal } from "lucide-react-native";
import { parseSshTransportUri } from "@pimi/protocol/ssh-transport";
import type { HostProfile } from "@/types/host-connection";
import { useHostMutations, useHosts } from "@/runtime/host-runtime";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { DaemonConnectionTestError } from "@/utils/test-daemon-connection";
import { Alert } from "@/components/ui/alert";
import { Switch } from "@/components/ui/switch";
import { openExternalUrl } from "@/utils/open-external-url";
import { RemoteSshProgressList } from "./remote-ssh-progress";
import { useRemoteSshSetup } from "./remote-ssh-setup";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";

const DEFAULT_DAEMON_PORT = 6767;
const FLEX_ONE_STYLE = { flex: 1 } as const;
const ThemedTerminal = withUnistyles(Terminal);

const styles = StyleSheet.create((theme) => {
  return {
    optionRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing[3],
    },
    optionText: { flex: 1, gap: theme.spacing[1] },
    optionTitle: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
    link: { color: theme.colors.accent, fontSize: theme.fontSize.sm },
    errorDetail: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
    actions: {
      flexDirection: "row",
      gap: theme.spacing[3],
      marginTop: theme.spacing[2],
    },
  };
});

export interface AddRemoteSshHostModalProps {
  visible: boolean;
  onClose: () => void;
  onCancel?: () => void;
  onSaved?: (result: {
    profile: HostProfile;
    serverId: string;
    hostname: string | null;
    isNewHost: boolean;
  }) => void;
}

const DOCS_URL = "https://github.com/1ikeadragon/pimi/blob/main/docs/remote-ssh.md";

/** Accepts `user@host`, `host`, or a full ssh:// URI. */
function parseTargetInput(raw: string): ReturnType<typeof parseSshTransportUri> {
  const value = raw.trim();
  return parseSshTransportUri(value.includes("://") ? value : `ssh://${value}`);
}

export function AddRemoteSshHostModal({
  visible,
  onClose,
  onCancel,
  onSaved,
}: AddRemoteSshHostModalProps) {
  const { t } = useTranslation();
  const hosts = useHosts();
  const { probeAndUpsertRemoteSshConnection } = useHostMutations();
  const setup = useRemoteSshSetup();
  const targetRef = useRef("");
  const inputRef = useRef<EditingTextInputHandle>(null);
  const [useSystemd, setUseSystemd] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [errorDetail, setErrorDetail] = useState("");
  const header = useMemo<SheetHeader>(() => ({ title: t("remoteDev.title") }), [t]);

  const clear = useCallback(() => {
    targetRef.current = "";
    inputRef.current?.replaceText("");
    setErrorMessage("");
    setErrorDetail("");
    setup.reset();
  }, [setup]);

  const handleClose = useCallback(() => {
    if (isSaving) return;
    clear();
    onClose();
  }, [clear, isSaving, onClose]);

  const handleCancel = useCallback(() => {
    if (isSaving) {
      setup.cancel();
      return;
    }
    clear();
    (onCancel ?? onClose)();
  }, [clear, isSaving, onCancel, onClose, setup]);

  const handleSave = useCallback(async () => {
    if (isSaving) return;
    const rawTarget = targetRef.current.trim();
    if (!rawTarget) {
      setErrorMessage(t("pairing.remoteSsh.errors.targetRequired"));
      return;
    }

    let target: ReturnType<typeof parseSshTransportUri>;
    try {
      target = parseTargetInput(rawTarget);
    } catch {
      setErrorMessage(t("remoteDev.invalidTarget"));
      return;
    }

    setIsSaving(true);
    setErrorMessage("");
    setErrorDetail("");
    try {
      const outcome = await setup.run({
        host: target.host,
        ...(target.sshPort !== undefined ? { sshPort: target.sshPort } : {}),
        ...(target.daemonPort !== DEFAULT_DAEMON_PORT ? { daemonPort: target.daemonPort } : {}),
        service: useSystemd ? "systemd" : "nohup",
        upgrade: "now",
      });
      if (!outcome.ok) {
        setErrorMessage(outcome.message);
        setErrorDetail(outcome.detail ?? "");
        return;
      }
      const result = await probeAndUpsertRemoteSshConnection({
        ...target,
        label: undefined,
      });
      clear();
      onSaved?.({
        ...result,
        isNewHost: !hosts.some((profile) => profile.serverId === result.serverId),
      });
      onClose();
    } catch (error) {
      setErrorMessage(
        error instanceof DaemonConnectionTestError
          ? t("pairing.remoteSsh.errors.failedToConnect", { detail: error.message })
          : t("common.errors.unableToSave"),
      );
    } finally {
      setIsSaving(false);
    }
  }, [
    clear,
    hosts,
    isSaving,
    onClose,
    onSaved,
    probeAndUpsertRemoteSshConnection,
    setup,
    t,
    useSystemd,
  ]);
  const handleTargetChange = useCallback((value: string) => {
    targetRef.current = value;
  }, []);
  const handleSubmit = useCallback(() => void handleSave(), [handleSave]);
  const handleOpenDocs = useCallback(() => void openExternalUrl(DOCS_URL), []);

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={handleClose}
      testID="add-remote-ssh-host-modal"
    >
      <Field
        label={t("remoteDev.hostLabel")}
        error={setup.state.visited ? undefined : errorMessage}
        testID="remote-ssh-target"
      >
        <FormTextInput
          ref={inputRef}
          testID="remote-ssh-target-input"
          accessibilityLabel={t("remoteDev.hostLabel")}
          initialValue=""
          onChangeText={handleTargetChange}
          placeholder={t("remoteDev.hostPlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isSaving}
          returnKeyType="done"
          onSubmitEditing={handleSubmit}
        />
      </Field>
      {errorDetail ? (
        <Text style={styles.errorDetail} selectable testID="remote-ssh-error-detail">
          {errorDetail}
        </Text>
      ) : null}
      <View style={styles.optionRow}>
        <View style={styles.optionText}>
          <Text style={styles.optionTitle}>{t("remoteDev.systemdTitle")}</Text>
        </View>
        <Switch
          value={useSystemd}
          onValueChange={setUseSystemd}
          disabled={isSaving}
          accessibilityLabel={t("remoteDev.systemdTitle")}
          testID="remote-ssh-systemd-switch"
        />
      </View>
      {setup.state.visited ? <RemoteSshProgressList state={setup.state} /> : null}
      {errorMessage && setup.state.visited ? (
        <Alert variant="error" title={t("remoteDev.setupStopped")} description={errorMessage} />
      ) : null}
      <Text style={styles.link} onPress={handleOpenDocs} accessibilityRole="link">
        {t("remoteDev.docsLink")}
      </Text>
      <View style={styles.actions}>
        <Button style={FLEX_ONE_STYLE} variant="secondary" onPress={handleCancel}>
          {t("pairing.remoteSsh.actions.cancel")}
        </Button>
        <Button
          style={FLEX_ONE_STYLE}
          onPress={handleSubmit}
          disabled={isSaving}
          leftIcon={ThemedTerminal}
          testID="remote-ssh-submit"
        >
          {isSaving
            ? t("pairing.remoteSsh.actions.connecting")
            : t("pairing.remoteSsh.actions.connect")}
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}
