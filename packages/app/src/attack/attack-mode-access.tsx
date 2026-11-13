import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "@/i18n/use-translation";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { getDesktopHost } from "@/desktop/host";
import { hasDesktopTargetBridge, useDesktopPermissions } from "./use-desktop-target";

export interface AttackAccessController {
  /** True when this client can show the desktop target's OS permissions (macOS desktop app). */
  macAccess: boolean;
  accessibility: boolean;
  screen: boolean;
  /** Asks macOS for Accessibility and Screen Recording at once; Windows has nothing to ask. */
  request: () => Promise<void>;
  openSettings: (pane: "accessibility" | "screen") => void;
}

/**
 * The one place the Attack permission request lives. Setup and Settings both use it, so the
 * request and the live status behave the same in each. Nothing gates on a grant: a permission
 * revoked later is still handled by the prompt inside Attack.
 */
export function useAttackAccess(): AttackAccessController {
  const { permissions, windows, request, openSettings } = useDesktopPermissions();
  const known = permissions !== null && permissions.supported;
  const macAccess = hasDesktopTargetBridge() && !windows && known;
  return {
    macAccess,
    accessibility: known && permissions.accessibility,
    screen: known && permissions.screen === "granted",
    request,
    openSettings,
  };
}

/** Quits and starts Pimi again, the only way macOS applies a new Screen Recording grant. */
function reopenPimi() {
  void getDesktopHost()?.desktopTarget?.relaunch();
}

/** Live Accessibility and Screen Recording status, with the way to fix each. macOS only. */
export function AttackAccess({ attack }: { attack: AttackAccessController }) {
  const { t } = useTranslation();
  const { macAccess, accessibility, screen, openSettings } = attack;
  // Once Screen Recording was seen missing, a later grant still needs a reopen to take effect.
  const [sawScreenMissing, setSawScreenMissing] = useState(false);
  useEffect(() => {
    if (macAccess && !screen) setSawScreenMissing(true);
  }, [macAccess, screen]);
  const openAccessibility = useCallback(() => openSettings("accessibility"), [openSettings]);
  const openScreen = useCallback(() => openSettings("screen"), [openSettings]);
  if (!macAccess) return null;
  return (
    <View style={styles.root} testID="attack-access">
      <AccessRow
        testID="attack-access-accessibility"
        label={t("attack.access.accessibility")}
        granted={accessibility}
        onOpen={openAccessibility}
      />
      <AccessRow
        testID="attack-access-screen"
        label={t("attack.access.screen")}
        granted={screen}
        onOpen={openScreen}
      />
      {sawScreenMissing || !screen ? (
        <View style={styles.reopen}>
          <Text style={styles.note}>{t("attack.access.reopenNote")}</Text>
          <Button variant="outline" size="sm" onPress={reopenPimi} testID="attack-access-reopen">
            {t("attack.access.reopen")}
          </Button>
        </View>
      ) : null}
    </View>
  );
}

function AccessRow({
  label,
  granted,
  onOpen,
  testID,
}: {
  label: string;
  granted: boolean;
  onOpen: () => void;
  testID: string;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.row} testID={testID}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.rowEnd}>
        <StatusBadge
          size="xs"
          variant={granted ? "success" : "warning"}
          label={granted ? t("attack.access.granted") : t("attack.access.missing")}
        />
        {granted ? null : (
          <Button variant="outline" size="sm" onPress={onOpen}>
            {t("attack.access.openSettings")}
          </Button>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { gap: theme.spacing[2] },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  rowEnd: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  label: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  reopen: { gap: theme.spacing[2], alignItems: "flex-start" },
  note: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
