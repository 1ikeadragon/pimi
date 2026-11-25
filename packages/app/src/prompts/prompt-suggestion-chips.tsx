import { useCallback, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { PromptSuggestion } from "@pimi/protocol/prompt/types";
import { Button } from "@/components/ui/button";
import type { ComposerTextSource } from "@/composer/text-source";
import { useTranslation } from "@/i18n/use-translation";
import { usePromptSuggestions } from "./use-prompt-suggestions";

// How many phrases sit under the composer. A layout choice: three outline pills fit one row at the
// composer's column width without wrapping; the Library lists the rest.
const MAX_SUGGESTION_CHIPS = 3;

interface PromptSuggestionChipsProps {
  serverId: string;
  projectId: string | null;
  textSource: ComposerTextSource;
  hasAttachments: boolean;
  /** A terminal launch has no chat to start, so there is nothing to suggest. */
  isTerminalLaunch: boolean;
  /** The composer covers the screen, leaving no room under it. */
  isComposerFullscreen: boolean;
  /** Puts the phrase in the composer and focuses it. Never sends. */
  onPick: (text: string) => void;
}

/**
 * The phrases this project's chats open with, shown while the composer is empty. Tapping one
 * fills the composer so the person can edit before sending.
 */
export function PromptSuggestionChips({
  serverId,
  projectId,
  textSource,
  hasAttachments,
  isTerminalLaunch,
  isComposerFullscreen,
  onPick,
}: PromptSuggestionChipsProps) {
  const { t } = useTranslation();
  const isEmpty = useSyncExternalStore(
    textSource.subscribe,
    () => textSource.getSnapshot().trim().length === 0,
    () => textSource.getSnapshot().trim().length === 0,
  );
  const suggestions = usePromptSuggestions({
    serverId,
    projectId,
    position: "first",
    limit: MAX_SUGGESTION_CHIPS,
    enabled: !isTerminalLaunch,
  });
  const refetch = suggestions.refetch;
  const retry = useCallback(() => void refetch(), [refetch]);

  const isHidden = !isEmpty || hasAttachments || isTerminalLaunch || isComposerFullscreen;
  if (isHidden || !projectId) return null;
  if (suggestions.isError) {
    return (
      <View style={styles.row} testID="prompt-suggestion-error">
        <Text style={styles.error} accessibilityRole="alert">
          {t("prompts.suggestions.loadFailed")}
        </Text>
        <Button size="sm" variant="ghost" onPress={retry}>
          {t("common.actions.retry")}
        </Button>
      </View>
    );
  }
  if (!suggestions.data || suggestions.data.length === 0) return null;
  return (
    <View style={styles.row} testID="prompt-suggestion-chips">
      {suggestions.data.map((suggestion) => (
        <SuggestionChip key={suggestion.key} suggestion={suggestion} onPick={onPick} />
      ))}
    </View>
  );
}

function SuggestionChip({
  suggestion,
  onPick,
}: {
  suggestion: PromptSuggestion;
  onPick: (text: string) => void;
}) {
  const pick = useCallback(() => onPick(suggestion.text), [onPick, suggestion.text]);
  return (
    <Button
      variant="outline"
      numberOfLines={1}
      onPress={pick}
      style={styles.chip}
      testID="prompt-suggestion-chip"
    >
      {suggestion.text}
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The composer sits spacing[4] in from the dock, so the chips share its edge.
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[4],
  },
  chip: {
    borderRadius: theme.borderRadius.full,
    maxWidth: "100%",
    flexShrink: 1,
  },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
}));
