import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useDisclosureHold } from "@/agent-stream/disclosure";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n/use-translation";

/** Says how much of a capped reply is on screen and lets the user render the rest. */
export function AssistantMessageCappedNotice({
  shownCharacters,
  totalCharacters,
  onExpand,
}: {
  shownCharacters: number;
  totalCharacters: number;
  onExpand: () => void;
}) {
  const { t, i18n } = useTranslation();
  const hold = useDisclosureHold();
  const format = useMemo(
    () => new Intl.NumberFormat(i18n.resolvedLanguage),
    [i18n.resolvedLanguage],
  );
  const expand = useCallback(() => hold(onExpand), [hold, onExpand]);
  return (
    <View style={styles.row} testID="assistant-message-capped-notice">
      <Text style={styles.label}>
        {t("agentStream.messageCapped", {
          shown: format.format(shownCharacters),
          total: format.format(totalCharacters),
        })}
      </Text>
      <Button variant="ghost" size="sm" onPress={expand}>
        {t("agentStream.showFullMessage")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    marginTop: theme.spacing[3],
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: theme.spacing[2],
  },
  label: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.base,
    fontStyle: "italic",
    color: theme.colors.foregroundMuted,
  },
}));
