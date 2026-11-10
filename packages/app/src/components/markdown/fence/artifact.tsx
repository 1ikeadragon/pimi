import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { PanelTopOpen } from "lucide-react-native";
import type { ChatArtifact } from "@pimi/protocol/chat-artifact";
import { useAssistantFileLinkEnvironment } from "@/assistant-file-links";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { Button } from "@/components/ui/button";
import { FileHtmlPreview } from "@/file-panels/html-preview";
import { decodeUtf8 } from "@/utils/decode-utf8";

// Full-size artifacts can still use the workspace file panel.
const MAX_INLINE_ARTIFACT_BYTES = 1024 * 1024;

export function ChatArtifactCard({ artifact }: { artifact: ChatArtifact }) {
  const active = useRetainedPanelActive();
  const environment = useAssistantFileLinkEnvironment();
  // Reopening a retained chat should require a fresh click to run the document.
  if (!active) return null;
  return (
    <ArtifactPreview
      key={JSON.stringify([environment.serverId, environment.workspaceRoot, artifact.path])}
      artifact={artifact}
    />
  );
}

type PreviewState = { status: "idle" | "loading" | "error" } | { status: "ready"; html: string };

function ArtifactPreview({ artifact }: { artifact: ChatArtifact }) {
  const { title, path } = artifact;
  const { client, workspaceRoot, onOpenWorkspaceFile } = useAssistantFileLinkEnvironment();
  const [state, setState] = useState<PreviewState>({ status: "idle" });
  const loading = state.status === "loading";
  const showPreview = useCallback(async () => {
    if (state.status === "ready") {
      setState({ status: "idle" });
      return;
    }
    if (loading || !client?.readFile || !workspaceRoot) return;
    setState({ status: "loading" });
    try {
      const file = await client.readFile(workspaceRoot, path, undefined, MAX_INLINE_ARTIFACT_BYTES);
      if (file.kind !== "text" || file.bytes.byteLength > MAX_INLINE_ARTIFACT_BYTES) {
        setState({ status: "error" });
        return;
      }
      setState({ status: "ready", html: decodeUtf8(file.bytes) });
    } catch {
      setState({ status: "error" });
    }
  }, [client, loading, path, state.status, workspaceRoot]);
  const openInTab = useCallback(
    () => onOpenWorkspaceFile?.({ raw: path, path }, "main"),
    [onOpenWorkspaceFile, path],
  );

  return (
    <View style={styles.card} testID="chat-artifact">
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <View style={styles.actions}>
          <Button
            variant="ghost"
            size="sm"
            disabled={!client?.readFile || !workspaceRoot || loading}
            loading={loading}
            onPress={showPreview}
          >
            {state.status === "ready" ? "Hide preview" : "Preview here"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={PanelTopOpen}
            accessibilityLabel="Open artifact in tab"
            disabled={!onOpenWorkspaceFile}
            onPress={openInTab}
          >
            Open in tab
          </Button>
        </View>
      </View>
      {state.status === "error" ? (
        <Text accessibilityRole="alert" style={styles.error}>
          Couldn’t load this HTML preview. Try again or open it in a tab.
        </Text>
      ) : null}
      {state.status === "ready" ? (
        <View style={styles.preview}>
          <FileHtmlPreview html={state.html} title={title} testID="chat-artifact-preview" />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    justifyContent: "space-between",
    padding: theme.spacing[2],
    paddingLeft: theme.spacing[3],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    flexShrink: 1,
  },
  actions: { alignItems: "center", flexDirection: "row", gap: theme.spacing[1] },
  error: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[3],
  },
  preview: { height: 360, borderTopWidth: 1, borderTopColor: theme.colors.border },
}));
