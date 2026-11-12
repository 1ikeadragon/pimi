import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { isElectronRuntime } from "@/desktop/host";
import {
  listenToRemoteSshUpgradePending,
  type RemoteSshUpgradePending,
} from "@/desktop/daemon/desktop-daemon";
import { RemoteSshProgressList } from "./add-host/internal/remote-ssh-progress";
import { useRemoteSshSetup } from "./add-host/internal/remote-ssh-setup";

/**
 * Mounted once by the app shell. A saved remote machine whose daemon is another version and
 * has agents or terminals running is not upgraded silently: the user picks Upgrade now or Later.
 */
export function RemoteSshUpgradeHost() {
  if (!isElectronRuntime()) return null;
  return <RemoteSshUpgradePrompt />;
}

function RemoteSshUpgradePrompt() {
  const { t } = useTranslation();
  const setup = useRemoteSshSetup();
  const [queue, setQueue] = useState<RemoteSshUpgradePending[]>([]);
  const [isUpgrading, setIsUpgrading] = useState(false);
  const [error, setError] = useState("");
  const pending = queue[0] ?? null;

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    const subscribe = async () => {
      const stop = await listenToRemoteSshUpgradePending((next) =>
        setQueue((previous) => [...previous, next]),
      );
      if (cancelled) stop();
      else unlisten = stop;
    };
    void subscribe();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const dismiss = useCallback(() => {
    setQueue((previous) => previous.slice(1));
    setError("");
    setup.reset();
  }, [setup]);

  const handleLater = useCallback(() => {
    if (!isUpgrading) dismiss();
  }, [dismiss, isUpgrading]);

  const handleNow = useCallback(async () => {
    if (!pending || isUpgrading) return;
    setIsUpgrading(true);
    setError("");
    try {
      const outcome = await setup.run({
        host: pending.host,
        ...(pending.sshPort !== undefined ? { sshPort: pending.sshPort } : {}),
        ...(pending.daemonPort !== undefined ? { daemonPort: pending.daemonPort } : {}),
        upgrade: "now",
      });
      if (outcome.ok) dismiss();
      else setError(outcome.message);
    } finally {
      setIsUpgrading(false);
    }
  }, [dismiss, isUpgrading, pending, setup]);
  const handleNowPress = useCallback(() => void handleNow(), [handleNow]);

  const header = useMemo(
    () => ({ title: t("remoteDev.upgrade.title", { host: pending?.host ?? "" }) }),
    [pending?.host, t],
  );
  if (!pending) return null;
  const work = pending.unknown
    ? t("remoteDev.upgrade.workUnknown")
    : t("remoteDev.upgrade.workBusy", { agents: pending.busyAgents, terminals: pending.terminals });
  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={handleLater}
      testID="remote-ssh-upgrade-modal"
    >
      <Text style={styles.message}>
        {t("remoteDev.upgrade.message", {
          host: pending.host,
          running: pending.runningVersion,
          desktop: pending.desktopVersion,
          work,
        })}
      </Text>
      {setup.state.visited ? <RemoteSshProgressList state={setup.state} /> : null}
      {error ? (
        <Alert variant="error" title={t("remoteDev.upgrade.failed")} description={error} />
      ) : null}
      <View style={styles.actions}>
        <Button
          style={styles.flex}
          variant="secondary"
          onPress={handleLater}
          disabled={isUpgrading}
          testID="remote-ssh-upgrade-later"
        >
          {t("remoteDev.upgrade.later")}
        </Button>
        <Button
          style={styles.flex}
          onPress={handleNowPress}
          disabled={isUpgrading}
          testID="remote-ssh-upgrade-now"
        >
          {t("remoteDev.upgrade.now")}
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  message: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  actions: { flexDirection: "row", gap: theme.spacing[3], marginTop: theme.spacing[2] },
  flex: { flex: 1 },
}));
