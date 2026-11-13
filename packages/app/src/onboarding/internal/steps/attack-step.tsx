import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AttackAccess, useAttackAccess } from "@/attack/attack-mode-access";
import { Button } from "@/components/ui/button";

/**
 * Enable or not now. Enabling asks macOS for Accessibility and Screen Recording together, right
 * here, instead of one at a time the first time an Attack run needs them. Nothing blocks Finish.
 */
export function AttackStep() {
  const { t } = useTranslation();
  const access = useAttackAccess();
  const { request } = access;
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const enable = useCallback(() => {
    setEnabled(true);
    setBusy(true);
    void request().finally(() => setBusy(false));
  }, [request]);
  const decline = useCallback(() => setEnabled(false), []);
  return (
    <View style={styles.root}>
      <View style={styles.choices}>
        <Button
          variant={enabled ? "default" : "outline"}
          onPress={enable}
          loading={busy}
          testID="onboarding-attack-enable"
        >
          {t("onboarding.setup.steps.attack.enable")}
        </Button>
        <Button
          variant={enabled ? "outline" : "default"}
          onPress={decline}
          testID="onboarding-attack-decline"
        >
          {t("onboarding.setup.steps.attack.notNow")}
        </Button>
      </View>
      {enabled ? <AttackAccess attack={access} /> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { gap: theme.spacing[4] },
  choices: { flexDirection: "row", gap: theme.spacing[2] },
}));
