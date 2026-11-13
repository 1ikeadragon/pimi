import { useCallback, useMemo, type ReactNode } from "react";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useAssistantFileLinkActions } from "@/assistant-file-links";
import { splitRuns, type UserMessageTextProps } from "./runs";

function MessageLink({ url }: { url: string }) {
  const { open } = useAssistantFileLinkActions();
  const handlePress = useCallback(() => open({ href: url }, "preferred"), [open, url]);
  return (
    <Text style={styles.link} onPress={handlePress}>
      {url}
    </Text>
  );
}

/** User message text with http(s) URLs as links. */
export function UserMessageText({ message, style, dataSet }: UserMessageTextProps) {
  const children = useMemo<ReactNode[]>(
    () =>
      splitRuns(message).map((run) =>
        run.url ? <MessageLink key={run.start} url={run.url} /> : run.text,
      ),
    [message],
  );
  return (
    <Text selectable style={style} dataSet={dataSet}>
      {children}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  link: {
    color: theme.colors.accentBright,
  },
}));
