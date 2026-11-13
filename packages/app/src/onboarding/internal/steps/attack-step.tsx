import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AttackAccess, useAttackAccess } from "@/attack/attack-mode-access";
import { Switch } from "@/components/ui/switch";
import { AttackClash } from "./attack-clash";

/**
 * One switch. Turning it on asks macOS for Accessibility and Screen Recording together, right here,
 * instead of one at a time the first time an Attack run needs them. Nothing blocks Finish.
 */
export function AttackStep() {
  const { t } = useTranslation();
  const access = useAttackAccess();
  const { request } = access;
  const [enabled, setEnabled] = useState(false);
  const toggle = useCallback(
    (next: boolean) => {
      setEnabled(next);
      if (next) void request();
    },
    [request],
  );
  const label = t("onboarding.setup.steps.attack.enable");
  return (
    <View style={styles.root}>
      <View style={styles.row}>
        <AttackClash active={enabled} />
        <Text style={styles.label}>{label}</Text>
        <Switch
          value={enabled}
          onValueChange={toggle}
          accessibilityLabel={label}
          testID="onboarding-attack-switch"
        />
      </View>
      {enabled ? <AttackAccess attack={access} /> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { gap: theme.spacing[4] },
  row: { flexDirection: "row", alignItems: "center", gap: theme.spacing[3] },
  label: {
    flex: 1,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
}));
