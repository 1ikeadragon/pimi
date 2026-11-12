import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useHardwareKeyboardPresent } from "@/keyboard";
import { isElectronRuntime } from "@/desktop/host";
import { useHosts } from "@/runtime/host-runtime";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { useLastWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { orderHostsLocalFirst, resolveActiveHostServerId } from "@/types/host-connection";
import { collectSettingEntries } from "./index";
import type { SettingEntry } from "./types";

/** The host a host-level page opens for when the palette, not the Settings sidebar, asks. */
function useSettingsTargetHost(): string | null {
  const hosts = useHosts();
  const localServerId = useLocalDaemonServerId();
  const workspace = useLastWorkspaceSelection();
  const workspaceServerId = workspace?.serverId ?? null;
  return useMemo(
    () =>
      resolveActiveHostServerId({
        selectedServerId: workspaceServerId,
        localServerId,
        hosts,
        orderedHosts: orderHostsLocalFirst(hosts, localServerId),
      }),
    [hosts, localServerId, workspaceServerId],
  );
}

/**
 * The searchable settings for this runtime. Host-level pages are left out when no host exists,
 * since there is nothing to open them for.
 */
export function useSettingsIndex(): { entries: readonly SettingEntry[]; serverId: string | null } {
  const { t } = useTranslation();
  const hardwareKeyboardPresent = useHardwareKeyboardPresent();
  const isDesktopApp = isElectronRuntime();
  const serverId = useSettingsTargetHost();
  const entries = useMemo(() => {
    const all = collectSettingEntries({ t, isDesktopApp, hardwareKeyboardPresent });
    return serverId ? all : all.filter((entry) => entry.location.kind === "section");
  }, [hardwareKeyboardPresent, isDesktopApp, serverId, t]);
  return { entries, serverId };
}
