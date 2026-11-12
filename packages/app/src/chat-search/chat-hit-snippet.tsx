import { useMemo, type ReactElement } from "react";
import type { StyleProp, TextStyle } from "react-native";
import type { MatchRange } from "@pimi/protocol/search/text-match";
import type { ChatSearchHit } from "@pimi/protocol/chat-search";
import { HighlightedText } from "@/components/ui/highlighted-text";

/** A hit's snippet with the matched words marked. */
export function ChatHitSnippet({
  hit,
  style,
  numberOfLines,
  testID,
}: {
  hit: Pick<ChatSearchHit, "snippet">;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  testID?: string;
}): ReactElement {
  const ranges = useMemo<MatchRange[]>(
    () => hit.snippet.ranges.map(([start, end]) => ({ start, length: end - start })),
    [hit.snippet.ranges],
  );
  return (
    <HighlightedText
      text={hit.snippet.text}
      ranges={ranges}
      style={style}
      numberOfLines={numberOfLines}
      testID={testID}
    />
  );
}
