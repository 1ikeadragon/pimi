import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { PairDeviceSection } from "@/desktop/components/pair-device-section";
import { LocalPairingSection } from "@/desktop/components/local-pairing-section";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";

export interface PairDeviceModalProps {
  serverId: string;
  visible: boolean;
  onClose: () => void;
  testID?: string;
}

const SNAP_POINTS: string[] = ["72%", "92%"];
const SELECTED = { selected: true };
const NOT_SELECTED = { selected: false };

export function PairDeviceModal({ serverId, visible, onClose, testID }: PairDeviceModalProps) {
  const { t } = useTranslation();
  const local = useIsLocalDaemon(serverId);
  const [mode, setMode] = useState<"wifi" | "remote">("wifi");
  const showWifi = useCallback(() => setMode("wifi"), []);
  const showRemote = useCallback(() => setMode("remote"), []);
  const header = useMemo<SheetHeader>(
    () => ({ title: t("settings.host.pairDevices.rowTitle") }),
    [t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      snapPoints={SNAP_POINTS}
      desktopMaxWidth={480}
      testID={testID}
    >
      {visible ? (
        <View style={styles.body}>
          {local ? (
            <View style={styles.options}>
              <Button
                size="sm"
                variant={mode === "wifi" ? "secondary" : "ghost"}
                accessibilityState={mode === "wifi" ? SELECTED : NOT_SELECTED}
                onPress={showWifi}
              >
                {t("pairing.local.wifi")}
              </Button>
              <Button
                size="sm"
                variant={mode === "remote" ? "secondary" : "ghost"}
                accessibilityState={mode === "remote" ? SELECTED : NOT_SELECTED}
                onPress={showRemote}
              >
                {t("pairing.local.remote")}
              </Button>
            </View>
          ) : null}
          {local && mode === "wifi" ? (
            <LocalPairingSection key={serverId} />
          ) : (
            <PairDeviceSection serverId={serverId} onClose={onClose} />
          )}
        </View>
      ) : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing[4] },
  options: { flexDirection: "row", gap: theme.spacing[1] },
}));
