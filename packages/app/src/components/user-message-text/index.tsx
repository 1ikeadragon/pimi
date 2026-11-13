import { useCallback, useMemo, type ReactNode } from "react";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useAssistantFileLinkActions } from "@/assistant-file-links";
import { SentAnnotationPill } from "@/annotations/sent-pill";
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
export function UserMessageText({ message, annotations, style, dataSet }: UserMessageTextProps) {
  const children = useMemo<ReactNode[]>(
    () =>
      splitRuns(message, annotations).map((run) => {
        if (run.chip !== null) {
          const annotation = annotations.get(run.chip);
          return annotation ? (
            <SentAnnotationPill key={run.start} annotation={annotation} size="inline" />
          ) : (
            run.text
          );
        }
        return run.url ? <MessageLink key={run.start} url={run.url} /> : run.text;
      }),
    [message, annotations],
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
