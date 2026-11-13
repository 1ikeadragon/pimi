import { useEffect } from "react";
import { useTranslation } from "@/i18n/use-translation";
import { isDev } from "@/constants/platform";
import { isElectronRuntime } from "@/desktop/host";
import { useHardwareKeyboardPresent } from "@/keyboard";
import { getMountedSettingIds } from "./anchor";
import { collectPageFieldEntries } from "./index";
import type { SettingsLocation } from "./types";

/** Long enough for the page's data to load and its rows to mount. */
const SETTLE_MS = 2500;

/**
 * Dev only: a page's declarations and its `settingId` rows are two halves of one fact. Once the
 * page has settled, report a declared field with no row and a row with no declaration, since
 * either one makes a search result open a page that cannot show the field.
 */
export function useDevSettingsIndexCheck(location: SettingsLocation | null): void {
  const { t } = useTranslation();
  const isDesktopApp = isElectronRuntime();
  const hardwareKeyboardPresent = useHardwareKeyboardPresent();
  const kind = location?.kind;
  const section = location?.section;
  useEffect(() => {
    if (!isDev || !kind || !section) return;
    const timer = setTimeout(() => {
      const declared = new Set(
        collectPageFieldEntries({ kind, section } as SettingsLocation, {
          t,
          isDesktopApp,
          hardwareKeyboardPresent,
        }).map((entry) => entry.id),
      );
      const mounted = getMountedSettingIds();
      const withoutRow = [...declared].filter((id) => !mounted.has(id));
      const withoutDeclaration = [...mounted].filter((id) => !declared.has(id));
      if (withoutRow.length === 0 && withoutDeclaration.length === 0) return;
      console.error(
        `[settings-index] ${kind}/${section}: declared without a row: ${withoutRow.join(", ") || "none"}; row without a declaration: ${withoutDeclaration.join(", ") || "none"}`,
      );
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [hardwareKeyboardPresent, isDesktopApp, kind, section, t]);
}
