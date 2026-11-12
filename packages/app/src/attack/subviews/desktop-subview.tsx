import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { AttackSubviewProps } from "./types";

// Placeholder: this subview's stream replaces the body, keeping the props contract.
export function DesktopSubview(_props: AttackSubviewProps) {
  const { t } = useTranslation();
  return (
    <View style={styles.root} testID="attack-subview-desktop">
      <Text style={styles.text}>{t("attack.subviews.desktop.empty")}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.spacing[6] },
  text: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base, textAlign: "center" },
}));
