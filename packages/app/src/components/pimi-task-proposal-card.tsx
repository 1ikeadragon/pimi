import { Button } from "@/components/ui/button";
import { checkoutReviewSource, openPimiReview } from "@/navigation/pimi-review";
import { useTranslation } from "@/i18n/use-translation";
import { pushPimiTask } from "@/navigation/pimi-tasks";
import { PimiReviewSuggestionResult, type PimiReviewSuggestion } from "@pimi/protocol/pimi-task";
import { TaskStatusSchema } from "@pimi/protocol/task/types";
import { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { z, type ZodType } from "zod";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readPimiToolOutput<T>(output: unknown, schema: ZodType<T>): T | null {
  // Claude relays the MCP result one level down, as `{ output: <result> }`.
  if (isRecord(output) && isRecord(output.output)) {
    const nested = readPimiToolOutput(output.output, schema);
    if (nested) return nested;
  }
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

/** What `create_pimi_task` returns: the task it made (or found) and whether it is new. */
const PimiCreatedTaskResult = z.object({
  task: z.object({ id: z.string(), title: z.string(), status: TaskStatusSchema.optional() }),
  created: z.boolean(),
});
export type PimiCreatedTask = z.infer<typeof PimiCreatedTaskResult>;

export function readPimiCreatedTask(output: unknown): PimiCreatedTask | null {
  return readPimiToolOutput(output, PimiCreatedTaskResult);
}

export function PimiCreatedTaskCard({
  result,
  serverId,
}: {
  result: PimiCreatedTask;
  serverId: string;
}) {
  const { t } = useTranslation();
  const { id, title } = result.task;
  const open = useCallback(() => pushPimiTask(serverId, id), [id, serverId]);
  return (
    <View style={styles.card} testID="pimi-task-created">
      <Text style={styles.meta}>
        {result.created ? t("tasks.card.added") : t("tasks.card.tracked")}
      </Text>
      <Text accessibilityRole="header" style={styles.title}>
        {title}
      </Text>
      <Button onPress={open} size="sm" style={styles.action}>
        {t("tasks.card.open")}
      </Button>
    </View>
  );
}

export function readPimiReviewSuggestion(output: unknown): PimiReviewSuggestion | null {
  return readPimiToolOutput(output, PimiReviewSuggestionResult)?.pimiReviewSuggestion ?? null;
}

export function PimiReviewSuggestionCard({ suggestion }: { suggestion: PimiReviewSuggestion }) {
  const openReview = useCallback(
    () =>
      openPimiReview(
        checkoutReviewSource({ serverId: suggestion.source.serverId, cwd: suggestion.path }),
      ),
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
