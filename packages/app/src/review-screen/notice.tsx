// Pimi. PolyForm-Noncommercial-1.0.0.
// A centered one-line state for a page body: loading, failed (with retry), or empty.
import { ActivityIndicator, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "@/i18n/use-translation";
import { Button } from "@/components/ui/button";

export function Notice({
  text,
  busy,
  onRetry,
  testID = "review-notice",
}: {
  text: string;
  busy?: boolean;
  onRetry?: () => void;
  testID?: string;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.notice} testID={testID}>
      {busy ? <ActivityIndicator /> : null}
      <Text style={styles.text}>{text}</Text>
      {onRetry ? (
        <Button size="sm" variant="outline" onPress={onRetry}>
          {t("common.actions.retry")}
        </Button>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  notice: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[6],
  },
  text: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
}));
