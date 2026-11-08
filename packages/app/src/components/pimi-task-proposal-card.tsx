import { Button } from "@/components/ui/button";
import { getDesktopHost } from "@/desktop/host";
import { openPimiTasks } from "@/navigation/pimi-tasks";
import { isPimiAndroid } from "@/utils/pimi-mobile";
import {
  PimiReviewSuggestionResult,
  PimiTaskCreatedResult,
  PimiTaskProposalResult,
  type PimiReviewSuggestion,
  type PimiTaskProposal,
} from "@pimi/protocol/pimi-task";
import { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ZodType } from "zod";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readPimiToolOutput<T>(output: unknown, schema: ZodType<T>): T | null {
  const result = schema.safeParse(isRecord(output) ? (output.structuredContent ?? output) : output);
  if (result.success) return result.data;

  // Some providers only relay the MCP text content, without structuredContent.
  const content = isRecord(output) ? output.content : output;
  const block = Array.isArray(content) && content.length === 1 ? content[0] : content;
  const serialized = isRecord(block) && block.type === "text" ? block.text : block;
  if (typeof serialized !== "string" || serialized.length > 64_000) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(serialized));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function readPimiTaskProposal(output: unknown): PimiTaskProposal | null {
  return readPimiToolOutput(output, PimiTaskProposalResult)?.pimiTaskProposal ?? null;
}

export function readPimiCreatedTask(output: unknown): PimiTaskCreatedResult | null {
  return readPimiToolOutput(output, PimiTaskCreatedResult);
}

export function PimiCreatedTaskCard({ result }: { result: PimiTaskCreatedResult }) {
  const { id, title } = result.task;
  const { serverId } = result.source;
  const open = useCallback(() => {
    if (isPimiAndroid()) openPimiTasks(serverId, id);
    else getDesktopHost()?.showPimiWorkspace?.({ view: "task", id });
  }, [id, serverId]);
  return (
    <View style={styles.card} testID="pimi-task-created">
      <Text style={styles.meta}>{result.created ? "Task added" : "Task already tracked"}</Text>
      <Text accessibilityRole="header" style={styles.title}>
        {title}
      </Text>
      <Button onPress={open} size="sm" style={styles.action}>
        Open task
      </Button>
    </View>
  );
}

export function readPimiReviewSuggestion(output: unknown): PimiReviewSuggestion | null {
  return readPimiToolOutput(output, PimiReviewSuggestionResult)?.pimiReviewSuggestion ?? null;
}

export function PimiTaskProposalCard({ proposal }: { proposal: PimiTaskProposal }) {
  const count = proposal.experiments?.length ?? 0;
  const reviewDraft = useCallback(
    () => getDesktopHost()?.showPimiWorkspace?.({ view: "task-draft", proposal }),
    [proposal],
  );
  return (
    <View style={styles.card} testID="pimi-task-proposal">
      <Text style={styles.meta}>
        Suggested task{count > 0 ? ` · ${count} ${count === 1 ? "work item" : "work items"}` : ""}
      </Text>
      <Text accessibilityRole="header" style={styles.title}>
        {proposal.title}
      </Text>
      <Text style={styles.brief} numberOfLines={3}>
        {proposal.brief}
      </Text>
      <Button onPress={reviewDraft} size="sm" style={styles.action}>
        Review task draft
      </Button>
    </View>
  );
}

export function PimiReviewSuggestionCard({ suggestion }: { suggestion: PimiReviewSuggestion }) {
  const openReview = useCallback(
    () =>
      getDesktopHost()?.showPimiWorkspace?.({
        view: "review",
        path: suggestion.path,
        serverId: suggestion.source.serverId,
      }),
    [suggestion],
  );
  return (
    <View style={styles.card} testID="pimi-review-suggestion">
      <Text accessibilityRole="header" style={styles.title}>
        Suggested review
      </Text>
      {suggestion.summary && <Text style={styles.brief}>{suggestion.summary}</Text>}
      <Button onPress={openReview} size="sm" style={styles.action}>
        Open Review
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    marginVertical: theme.spacing[2],
    padding: theme.spacing[3],
    borderWidth: 1,
    borderRadius: theme.spacing[2],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    gap: theme.spacing[2],
  },
  meta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.base, fontWeight: "600" },
  brief: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base, lineHeight: 20 },
  action: { alignSelf: "flex-end" },
}));
