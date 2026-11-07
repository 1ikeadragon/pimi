import { Button } from "@/components/ui/button";
import { getDesktopHost } from "@/desktop/host";
import { PimiTaskProposalResult, type PimiTaskProposal } from "@getpaseo/protocol/pimi-task";
import { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readPimiTaskProposal(output: unknown): PimiTaskProposal | null {
  const result = PimiTaskProposalResult.safeParse(
    isRecord(output) ? (output.structuredContent ?? output) : output,
  );
  if (result.success) return result.data.pimiTaskProposal;

  // Some providers only relay the MCP text content, without structuredContent.
  const content = isRecord(output) ? output.content : output;
  const block = Array.isArray(content) && content.length === 1 ? content[0] : content;
  const serialized = isRecord(block) && block.type === "text" ? block.text : block;
  if (typeof serialized !== "string" || serialized.length > 64_000) return null;
  try {
    const parsed = PimiTaskProposalResult.safeParse(JSON.parse(serialized));
    return parsed.success ? parsed.data.pimiTaskProposal : null;
  } catch {
    return null;
  }
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
        Suggested task{count > 0 ? ` · ${count} ${count === 1 ? "experiment" : "experiments"}` : ""}
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
  action: { alignSelf: "flex-start" },
}));
