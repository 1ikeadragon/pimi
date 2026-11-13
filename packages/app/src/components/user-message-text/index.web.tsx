import { useCallback, useMemo, type MouseEvent, type ReactNode } from "react";
import { Text } from "react-native";
import { useAssistantFileLinkActions } from "@/assistant-file-links";
import { openExternalUrl } from "@/utils/open-external-url";
import { SentAnnotationPill } from "@/annotations/sent-pill";
import { splitRuns, type UserMessageTextProps } from "./runs";

const LINK_STYLE = { color: "inherit", textDecoration: "underline" } as const;

// A real anchor, so the context menu offers "Open Link in Browser" and "Copy Link Address".
function MessageLink({ url }: { url: string }) {
  const { open } = useAssistantFileLinkActions();
  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      if (event.metaKey || event.ctrlKey) {
        void openExternalUrl(url);
        return;
      }
      open({ href: url }, "preferred");
    },
    [open, url],
  );
  const handleAuxClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (event.button !== 1) return;
      event.preventDefault();
      void openExternalUrl(url);
    },
    [url],
  );
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      style={LINK_STYLE}
      onClick={handleClick}
      onAuxClick={handleAuxClick}
    >
      {url}
    </a>
  );
}

/**
 * User message text with http(s) URLs as links. The outer Text stays the single text container so
 * its textContent is the message verbatim, which chat-selection annotations anchor on.
 */
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
