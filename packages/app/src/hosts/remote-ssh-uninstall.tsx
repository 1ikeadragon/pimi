import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ActivityIndicator } from "react-native";
import { Check, Trash2 } from "lucide-react-native";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useToast } from "@/contexts/toast-context";
import {
  cancelRemoteSshSetup,
  checkRemoteSshUninstall,
  listenToRemoteSshUninstallProgress,
  uninstallRemoteSsh,
  type RemoteSshKept,
  type RemoteSshUninstallCheck,
  type RemoteSshUninstallResult,
  type RemoteSshUninstallStep,
  type RemoteSshUninstalled,
} from "@/desktop/daemon/desktop-daemon";
import { isElectronRuntime } from "@/desktop/host";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import {
  useHostMutations,
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
} from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import type { HostProfile, RemoteSshHostConnection } from "@/types/host-connection";

type Phase =
  | { name: "closed" }
  | { name: "checking" }
  | { name: "unreachable"; message: string }
  | { name: "confirm"; check: RemoteSshUninstallCheck }
  | { name: "running"; step: RemoteSshUninstallStep }
  | { name: "failed"; message: string };

const FLEX_1_STYLE = { flex: 1 } as const;
const ThemedCheck = withUnistyles(Check, (theme) => ({ color: theme.colors.accentForeground }));
const ThemedSpinner = withUnistyles(ActivityIndicator, (theme) => ({
  color: theme.colors.accent,
}));
const ThemedTrash = withUnistyles(Trash2, (theme) => ({ color: theme.colors.destructive }));

function formatKb(kb: number | null): string {
  if (kb === null) return "?";
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(kb / 1024))} MB`;
}

type Work =
  | { kind: "none" }
  | { kind: "unknown" }
  | { kind: "known"; agents: number; terminals: number };

function workOf(check: RemoteSshUninstallCheck): Work {
  if (check.daemonVersion === null || check.foreignDaemon) return { kind: "none" };
  if (check.busyAgents === null || check.terminals === null) return { kind: "unknown" };
  if (check.busyAgents + check.terminals === 0) return { kind: "none" };
  return { kind: "known", agents: check.busyAgents, terminals: check.terminals };
}

function findRemoteSsh(host: HostProfile): RemoteSshHostConnection | null {
  const found = host.connections.find((connection) => connection.type === "remoteSsh");
  return found?.type === "remoteSsh" ? found : null;
}

/**
 * Danger-zone card for a host the desktop reaches over ssh: stops the daemon Pimi installed on
 * that machine, deletes the runtime, and removes the host from Pimi. Pimi data on the machine
 * stays unless the user ticks the second box.
 */
export function RemoteSshUninstallCard({
  host,
  onRemoved,
}: {
  host: HostProfile;
  onRemoved?: () => void;
}) {
  const connection = findRemoteSsh(host);
  if (!isElectronRuntime() || !connection) return null;
  return <UninstallCard host={host} connection={connection} onRemoved={onRemoved} />;
}

function UninstallCard({
  host,
  connection,
  onRemoved,
}: {
  host: HostProfile;
  connection: RemoteSshHostConnection;
  onRemoved?: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { removeHost } = useHostMutations();
  const client = useHostRuntimeClient(host.serverId);
  const isConnected = useHostRuntimeIsConnected(host.serverId);
  const { config, patchConfig } = useDaemonConfig(host.serverId);
  const [phase, setPhase] = useState<Phase>({ name: "closed" });
  const [deleteData, setDeleteData] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [isRemovingOnly, setIsRemovingOnly] = useState(false);
  const requestIdRef = useRef<string | null>(null);

  const target = useMemo(
    () => ({
      host: connection.host,
      ...(connection.sshPort !== undefined ? { sshPort: connection.sshPort } : {}),
      ...(connection.daemonPort !== undefined ? { daemonPort: connection.daemonPort } : {}),
    }),
    [connection.daemonPort, connection.host, connection.sshPort],
  );
  const name = connection.host;
  const trashIcon = useMemo(() => <ThemedTrash size={16} />, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void listenToRemoteSshUninstallProgress((progress) => {
      if (progress.requestId !== requestIdRef.current) return;
      setPhase((previous) =>
        previous.name === "running" ? { name: "running", step: progress.step } : previous,
      );
    }).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
      return;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const newRequestId = useCallback(() => {
    const id = `ssh-uninstall-${globalThis.crypto.randomUUID()}`;
    requestIdRef.current = id;
    return id;
  }, []);

  const handleOpen = useCallback(() => {
    setDeleteData(false);
    setAcknowledged(false);
    setPhase({ name: "checking" });
    const requestId = newRequestId();
    void checkRemoteSshUninstall({ requestId, target }).then((outcome) => {
      if (requestIdRef.current !== requestId) return;
      if (outcome.ok) setPhase({ name: "confirm", check: outcome.check });
      else setPhase({ name: "unreachable", message: outcome.message });
      return;
    });
  }, [newRequestId, target]);

  const handleClose = useCallback(() => {
    if (phase.name === "running" || isRemovingOnly) return;
    const requestId = requestIdRef.current;
    if (phase.name === "checking" && requestId) void cancelRemoteSshSetup(requestId);
    requestIdRef.current = null;
    setPhase({ name: "closed" });
  }, [isRemovingOnly, phase.name]);

  const handleCancelRun = useCallback(() => {
    const requestId = requestIdRef.current;
    if (requestId) void cancelRemoteSshSetup(requestId);
  }, []);

  const handleRemoveOnly = useCallback(() => {
    setIsRemovingOnly(true);
    removeHost(host.serverId)
      .then(() => {
        setPhase({ name: "closed" });
        onRemoved?.();
        return;
      })
      .catch((error) => {
        console.error("[RemoteSshUninstall] Failed to remove host", error);
        setPhase({ name: "failed", message: t("settings.host.daemon.remove.errorMessage") });
      })
      .finally(() => setIsRemovingOnly(false));
  }, [host.serverId, onRemoved, removeHost, t]);

  const summarize = useCallback(
    (result: RemoteSshUninstallResult, notes: string[]) => {
      const removed = result.removed.map((item: RemoteSshUninstalled) =>
        t(`settings.host.remoteDaemon.uninstall.removed.${item}`),
      );
      const kept = result.kept.map((item: RemoteSshKept) =>
        t(`settings.host.remoteDaemon.uninstall.kept.${item}`),
      );
      const parts = [
        t("settings.host.remoteDaemon.uninstall.done", {
          host: name,
          removed:
            removed.length > 0
              ? removed.join(", ")
              : t("settings.host.remoteDaemon.uninstall.removed.nothing"),
        }),
      ];
      if (kept.length > 0) {
        parts.push(t("settings.host.remoteDaemon.uninstall.keptList", { kept: kept.join(", ") }));
      }
      if (result.serviceWarning) {
        parts.push(t("settings.host.remoteDaemon.uninstall.serviceWarning"));
      }
      return [...parts, ...notes].join(" ");
    },
    [name, t],
  );

  const handleConfirm = useCallback(async () => {
    if (phase.name !== "confirm") return;
    setPhase({ name: "running", step: "connecting" });
    const notes: string[] = [];
    // While the app is connected the daemon can undo what it wrote into agent configs. When it
    // cannot be reached, the host's own files stay as they are and the result says so.
    if (config?.enableTerminalAgentHooks === true) {
      try {
        await patchConfig({ enableTerminalAgentHooks: false });
      } catch (error) {
        console.error("[RemoteSshUninstall] Could not turn off terminal agent hooks", error);
        notes.push(t("settings.host.remoteDaemon.uninstall.hooksLeft"));
      }
    }
    if (deleteData) {
      let skillsGone = false;
      if (client && isConnected) {
        try {
          skillsGone = (await client.uninstallAgentSkills()).state === "not-installed";
        } catch (error) {
          console.error("[RemoteSshUninstall] Could not uninstall agent skills", error);
        }
      }
      if (!skillsGone) notes.push(t("settings.host.remoteDaemon.uninstall.skillsLeft"));
    }
    const requestId = newRequestId();
    const outcome = await uninstallRemoteSsh({ requestId, target, deleteData });
    if (!outcome.ok) {
      if (outcome.code === "CANCELLED") {
        setPhase({ name: "closed" });
        return;
      }
      setPhase({ name: "failed", message: outcome.message });
      return;
    }
    const summary = summarize(outcome.result, notes);
    try {
      await removeHost(host.serverId);
    } catch (error) {
      console.error("[RemoteSshUninstall] Failed to remove host after uninstall", error);
      setPhase({ name: "failed", message: t("settings.host.daemon.remove.errorMessage") });
      return;
    }
    toast.show(summary, { durationMs: 12_000, testID: "remote-ssh-uninstall-result" });
    setPhase({ name: "closed" });
    onRemoved?.();
  }, [
    client,
    config?.enableTerminalAgentHooks,
    deleteData,
    host.serverId,
    isConnected,
    newRequestId,
    onRemoved,
    patchConfig,
    phase.name,
    removeHost,
    summarize,
    t,
    target,
    toast,
  ]);
  const handleConfirmPress = useCallback(() => void handleConfirm(), [handleConfirm]);

  const handleToggleData = useCallback(() => setDeleteData((value) => !value), []);
  const handleToggleAck = useCallback(() => setAcknowledged((value) => !value), []);

  const header = useMemo<SheetHeader>(
    () => ({ title: t("settings.host.remoteDaemon.uninstall.sheetTitle", { host: name }) }),
    [name, t],
  );

  const work = phase.name === "confirm" ? workOf(phase.check) : { kind: "none" as const };
  const needsAck = work.kind !== "none";
  const canConfirm = !needsAck || acknowledged;

  return (
    <View style={settingsStyles.card}>
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>
            {t("settings.host.remoteDaemon.uninstall.title")}
          </Text>
          <Text style={settingsStyles.rowHint}>
            {t("settings.host.remoteDaemon.uninstall.hint", { host: name })}
          </Text>
        </View>
        <Button
          variant="outline"
          leftIcon={trashIcon}
          onPress={handleOpen}
          testID="remote-ssh-uninstall-button"
        >
          {t("settings.host.remoteDaemon.uninstall.action")}
        </Button>
      </View>

      {phase.name !== "closed" ? (
        <AdaptiveModalSheet
          header={header}
          visible
          onClose={handleClose}
          testID="remote-ssh-uninstall-modal"
        >
          {phase.name === "checking" ? (
            <View style={styles.progressRow}>
              <ThemedSpinner size="small" />
              <Text style={styles.text}>
                {t("settings.host.remoteDaemon.uninstall.checking", { host: name })}
              </Text>
            </View>
          ) : null}

          {phase.name === "unreachable" ? (
            <>
              <Alert
                variant="error"
                title={t("settings.host.remoteDaemon.uninstall.unreachableTitle", { host: name })}
                description={phase.message}
                testID="remote-ssh-uninstall-unreachable"
              />
              <Text style={styles.text}>
                {t("settings.host.remoteDaemon.uninstall.unreachableHint")}
              </Text>
              <FooterActions
                onClose={handleClose}
                onRemoveOnly={handleRemoveOnly}
                isRemovingOnly={isRemovingOnly}
              />
            </>
          ) : null}

          {phase.name === "confirm" ? (
            <>
              <Text style={styles.text}>
                {t("settings.host.remoteDaemon.uninstall.willRemove")}
              </Text>
              <View style={styles.list}>
                {phase.check.daemonVersion !== null && !phase.check.foreignDaemon ? (
                  <Text style={styles.item}>
                    {t("settings.host.remoteDaemon.uninstall.itemStop")}
                  </Text>
                ) : null}
                {phase.check.systemdUnit ? (
                  <Text style={styles.item}>
                    {t("settings.host.remoteDaemon.uninstall.itemService")}
                  </Text>
                ) : null}
                <Text style={styles.item}>
                  {t("settings.host.remoteDaemon.uninstall.itemRuntime", {
                    size: formatKb(phase.check.runtimeKb),
                  })}
                </Text>
                <Text style={styles.item}>
                  {t("settings.host.remoteDaemon.uninstall.itemHost")}
                </Text>
              </View>
              {phase.check.foreignDaemon ? (
                <Alert
                  variant="info"
                  description={t("settings.host.remoteDaemon.uninstall.foreignDaemon")}
                />
              ) : null}
              {work.kind !== "none" ? (
                <Alert
                  variant="warning"
                  description={
                    work.kind === "known"
                      ? t("settings.host.remoteDaemon.uninstall.workKnown", {
                          agents: work.agents,
                          terminals: work.terminals,
                        })
                      : t("settings.host.remoteDaemon.uninstall.workUnknown")
                  }
                  testID="remote-ssh-uninstall-work-warning"
                />
              ) : null}
              {work.kind !== "none" ? (
                <CheckRow
                  checked={acknowledged}
                  onPress={handleToggleAck}
                  label={t("settings.host.remoteDaemon.uninstall.workAck")}
                  testID="remote-ssh-uninstall-ack"
                />
              ) : null}
              <Text style={styles.text}>
                {t("settings.host.remoteDaemon.uninstall.keepData", {
                  size: formatKb(phase.check.dataKb),
                })}
              </Text>
              <CheckRow
                checked={deleteData}
                onPress={handleToggleData}
                label={t("settings.host.remoteDaemon.uninstall.deleteData")}
                testID="remote-ssh-uninstall-delete-data"
              />
              {deleteData ? (
                <Alert
                  variant="error"
                  description={
                    (phase.check.worktrees > 0
                      ? t("settings.host.remoteDaemon.uninstall.deleteDataWorktrees", {
                          size: formatKb(phase.check.dataKb),
                          worktrees: phase.check.worktrees,
                        })
                      : t("settings.host.remoteDaemon.uninstall.deleteDataNoWorktrees", {
                          size: formatKb(phase.check.dataKb),
                        })) +
                    " " +
                    t("settings.host.remoteDaemon.uninstall.deleteDataPhones")
                  }
                  testID="remote-ssh-uninstall-data-warning"
                />
              ) : null}
              <View style={styles.actions}>
                <Button
                  variant="secondary"
                  style={FLEX_1_STYLE}
                  onPress={handleClose}
                  testID="remote-ssh-uninstall-cancel"
                >
                  {t("common.actions.cancel")}
                </Button>
                <Button
                  variant="destructive"
                  style={FLEX_1_STYLE}
                  disabled={!canConfirm}
                  onPress={handleConfirmPress}
                  testID="remote-ssh-uninstall-confirm"
                >
                  {t("settings.host.remoteDaemon.uninstall.confirm")}
                </Button>
              </View>
            </>
          ) : null}

          {phase.name === "running" ? (
            <>
              <View style={styles.progressRow} testID="remote-ssh-uninstall-progress">
                <ThemedSpinner size="small" />
                <Text style={styles.text}>
                  {t(`settings.host.remoteDaemon.uninstall.steps.${phase.step}`, { host: name })}
                </Text>
              </View>
              <View style={styles.actions}>
                <Button
                  variant="secondary"
                  style={FLEX_1_STYLE}
                  onPress={handleCancelRun}
                  testID="remote-ssh-uninstall-cancel-run"
                >
                  {t("common.actions.cancel")}
                </Button>
              </View>
            </>
          ) : null}

          {phase.name === "failed" ? (
            <>
              <Alert
                variant="error"
                title={t("settings.host.remoteDaemon.uninstall.failedTitle")}
                description={phase.message}
                testID="remote-ssh-uninstall-failed"
              />
              <Text style={styles.text}>
                {t("settings.host.remoteDaemon.uninstall.failedHint")}
              </Text>
              <FooterActions
                onClose={handleClose}
                onRemoveOnly={handleRemoveOnly}
                isRemovingOnly={isRemovingOnly}
              />
            </>
          ) : null}
        </AdaptiveModalSheet>
      ) : null}
    </View>
  );
}

function FooterActions({
  onClose,
  onRemoveOnly,
  isRemovingOnly,
}: {
  onClose: () => void;
  onRemoveOnly: () => void;
  isRemovingOnly: boolean;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.actions}>
      <Button
        variant="secondary"
        style={FLEX_1_STYLE}
        onPress={onClose}
        disabled={isRemovingOnly}
        testID="remote-ssh-uninstall-close"
      >
        {t("common.actions.cancel")}
      </Button>
      <Button
        variant="destructive"
        style={FLEX_1_STYLE}
        onPress={onRemoveOnly}
        disabled={isRemovingOnly}
        testID="remote-ssh-uninstall-remove-only"
      >
        {t("settings.host.remoteDaemon.uninstall.removeOnly")}
      </Button>
    </View>
  );
}

function CheckRow({
  checked,
  onPress,
  label,
  testID,
}: {
  checked: boolean;
  onPress: () => void;
  label: string;
  testID: string;
}) {
  const state = useMemo(() => ({ checked }), [checked]);
  const boxStyle = useMemo(
    () => [styles.checkbox, checked ? styles.checkboxChecked : null],
    [checked],
  );
  return (
    <PressHighlight
      style={styles.checkboxRow}
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={state}
      aria-checked={checked}
      testID={testID}
    >
      <View style={boxStyle}>{checked ? <ThemedCheck size={14} /> : null}</View>
      <Text style={styles.checkLabel}>{label}</Text>
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  list: { gap: theme.spacing[1] },
  item: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  progressRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[3] },
  actions: { flexDirection: "row", gap: theme.spacing[2], marginTop: theme.spacing[2] },
  checkboxRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[3] },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxChecked: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
  checkLabel: { flex: 1, color: theme.colors.foreground, fontSize: theme.fontSize.base },
}));
