import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useHardwareKeyboardPresent } from "@/keyboard";
import { isElectronRuntime } from "@/desktop/host";
import { useDefaultHostServerId } from "@/hooks/use-default-host-server-id";
import { collectSettingEntries } from "./index";
import type { SettingEntry } from "./types";

/**
 * The searchable settings for this runtime. Host-level pages are left out when no host exists,
 * since there is nothing to open them for.
 */
export function useSettingsIndex(): { entries: readonly SettingEntry[]; serverId: string | null } {
  const { t } = useTranslation();
  const hardwareKeyboardPresent = useHardwareKeyboardPresent();
  const isDesktopApp = isElectronRuntime();
  const serverId = useDefaultHostServerId();
  const entries = useMemo(() => {
    const all = collectSettingEntries({ t, isDesktopApp, hardwareKeyboardPresent });
    return serverId ? all : all.filter((entry) => entry.location.kind === "section");
  }, [hardwareKeyboardPresent, isDesktopApp, serverId, t]);
  return { entries, serverId };
}
