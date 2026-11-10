import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";
import { SidebarCalloutDescriptionText } from "@/components/sidebar-callout";
import { useSidebarCallouts } from "@/contexts/sidebar-callout-context";
import { useFetchQuery } from "@/data/query";
import {
  confirmAndRestartDesktopDaemonOnAppVersion,
  getDesktopDaemonStatus,
  shouldUseDesktopDaemon,
} from "@/desktop/daemon/desktop-daemon";
import { resolveDaemonVersionCallout } from "@/desktop/daemon/version-callout";
import { useDesktopSettings } from "@/desktop/settings/desktop-settings";
import { useStableEvent } from "@/hooks/use-stable-event";
import { getDaemonStartService } from "@/runtime/daemon-start-service";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { resolveAppVersion } from "@/utils/app-version";

const LOCAL_DAEMON_QUERY_KEY = ["desktop-daemon-version-callout"] as const;

function useIsDaemonStarting(): boolean {
  const service = getDaemonStartService({ store: getHostRuntimeStore() });
  return useSyncExternalStore(
    (listener) => service.subscribe(listener),
    () => service.isRunning(),
    () => service.isRunning(),
  );
}

export function DaemonVersionCalloutSource() {
  const callouts = useSidebarCallouts();
  const queryClient = useQueryClient();
  const isDesktopApp = shouldUseDesktopDaemon();
  const { settings } = useDesktopSettings();
  const isDaemonStarting = useIsDaemonStarting();
  const [isRestarting, setIsRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const [isDismissed, setIsDismissed] = useState(false);
  const appVersion = resolveAppVersion();

  // Startup can replace the daemon, so its status is read once startup has settled.
  // Each read launches the CLI, so it is not repeated on focus; the connected daemon's reported
  // version covers restarts done elsewhere.
  const localDaemon = useFetchQuery({
    queryKey: LOCAL_DAEMON_QUERY_KEY,
    queryFn: getDesktopDaemonStatus,
    dataShape: "value",
    staleTimeMs: 5 * 60_000,
    enabled: isDesktopApp && !isDaemonStarting,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  useEffect(() => {
    if (isDaemonStarting) return;
    void queryClient.invalidateQueries({ queryKey: LOCAL_DAEMON_QUERY_KEY });
  }, [isDaemonStarting, queryClient]);

  const daemon = localDaemon.isFetching ? null : (localDaemon.data ?? null);
  const serverId = daemon?.serverId ?? "";
  const connectedDaemonVersion = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.version ?? null,
  );

  const restart = useStableEvent(() => {
    if (!appVersion) return;
    setIsRestarting(true);
    setRestartError(null);
    void confirmAndRestartDesktopDaemonOnAppVersion(appVersion)
      .catch((error: unknown) => {
        setRestartError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setIsRestarting(false);
        void queryClient.invalidateQueries({ queryKey: LOCAL_DAEMON_QUERY_KEY });
      });
  });
  const dismiss = useStableEvent(() => {
    setIsDismissed(true);
    setRestartError(null);
  });

  const manageBuiltInDaemon = settings.daemon.manageBuiltInDaemon;
  const daemonStatus = daemon?.status ?? null;
  const daemonVersion = daemon?.version ?? null;
  const desktopManaged = daemon?.desktopManaged === true;

  useEffect(() => {
    const descriptor = resolveDaemonVersionCallout({
      isDesktopApp,
      manageBuiltInDaemon,
      isDaemonStarting,
      appVersion,
      daemon: daemonStatus
        ? { status: daemonStatus, desktopManaged, version: daemonVersion }
        : null,
      connectedDaemonVersion,
      isRestarting,
      restartError,
      isDismissed,
    });
    if (!descriptor) return;

    return callouts.show({
      id: descriptor.id,
      priority: descriptor.priority,
      title: descriptor.title,
      description: (
        <>
          <SidebarCalloutDescriptionText>{descriptor.description}</SidebarCalloutDescriptionText>
          {descriptor.warning ? (
            <SidebarCalloutDescriptionText>{descriptor.warning}</SidebarCalloutDescriptionText>
          ) : null}
        </>
      ),
      variant: descriptor.variant,
      actions: [
        {
          label: descriptor.actionLabel,
          onPress: restart,
          variant: "primary",
          disabled: descriptor.actionDisabled,
        },
      ],
      onDismiss: dismiss,
      testID: descriptor.testID,
    });
  }, [
    appVersion,
    callouts,
    connectedDaemonVersion,
    daemonStatus,
    daemonVersion,
    desktopManaged,
    dismiss,
    isDaemonStarting,
    isDesktopApp,
    isDismissed,
    isRestarting,
    manageBuiltInDaemon,
    restart,
    restartError,
  ]);

  return null;
}
