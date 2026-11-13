import type {
  PluginAnnotationAttachment,
  PluginAnnotationSource,
  PluginAttachmentRendererProps,
} from "@pimi/plugin/client";
import { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";

function basename(path: string): string {
  return path.split("/").pop() || path;
}

function describeSource(source: PluginAnnotationSource): string {
  if (source.kind === "chat") return source.role === "user" ? "Your message" : "Assistant";
  if (source.kind === "browser") return `<${source.tag}>`;
  // A range ending at column 1 stops on the line before.
  const lastLine =
    source.endColumn === 1 && source.endLine > source.startLine
      ? source.endLine - 1
      : source.endLine;
  const lines =
    lastLine === source.startLine ? `${source.startLine}` : `${source.startLine}-${lastLine}`;
  return `${basename(source.path)}:${lines}`;
}

function describeQuote(annotation: PluginAnnotationAttachment): string {
  const quote = annotation.quote.replace(/\s+/g, " ").trim();
  return quote.length > 32 ? `${quote.slice(0, 31)}…` : quote;
}

export function AnnotationChip({
  attachment,
  composer,
  disabled,
  openSource,
  placement,
  layout,
  theme,
}: PluginAttachmentRendererProps<PluginAnnotationAttachment>) {
  // Inline, the chip sits in a line of text and has to be no taller than it; in the tray it can
  // be a little larger.
  const height = placement === "inline" ? layout.lineHeight : 24;
  const styles = useMemo(
    () => ({
      chip: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        maxWidth: 260,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
        paddingLeft: 10,
        paddingRight: 4,
        height,
        gap: 6,
      },
      label: {
        flexShrink: 1,
        flexDirection: "row" as const,
        gap: 6,
        alignItems: "center" as const,
      },
      source: { color: theme.colors.accent, fontSize: 12, fontWeight: "600" as const },
      quote: { color: theme.colors.foregroundMuted, fontSize: 12, flexShrink: 1 },
      remove: {
        width: 16,
        height: 16,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      cross: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 14 },
    }),
    [theme, height],
  );
  const remove = useCallback(
    () => composer.attachments.remove(attachment.id),
    [composer, attachment.id],
  );
  return (
    <View testID="annotation-chip" style={styles.chip}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Go to annotated source"
        disabled={disabled}
        onPress={openSource}
        style={styles.label}
      >
        <Text style={styles.source}>{describeSource(attachment.source)}</Text>
        <Text numberOfLines={1} style={styles.quote}>
          {describeQuote(attachment)}
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Remove annotation"
        disabled={disabled}
        onPress={remove}
        style={styles.remove}
      >
        <Text style={styles.cross}>×</Text>
      </Pressable>
    </View>
  );
}
