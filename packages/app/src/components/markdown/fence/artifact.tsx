import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronUp, PanelTopOpen } from "lucide-react-native";
import type { ChatArtifact } from "@pimi/protocol/chat-artifact";
import { useAssistantFileLinkEnvironment } from "@/assistant-file-links";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { isWeb } from "@/constants/platform";
import { FileHtmlPreview } from "@/file-panels/html-preview";
import { htmlPreviewTheme } from "@/file-panels/html-preview-theme";
import { decodeUtf8 } from "@/utils/decode-utf8";

// Full-size artifacts can still use the workspace file panel.
const MAX_INLINE_ARTIFACT_BYTES = 1024 * 1024;
// The frame follows its content between these bounds and scrolls inside past the maximum, so one
// visual can neither collapse to nothing nor take over the conversation.
const MIN_PREVIEW_HEIGHT = 140;
const MAX_PREVIEW_HEIGHT = 640;
const INITIAL_PREVIEW_HEIGHT = 280;

export function ChatArtifactCard({ artifact }: { artifact: ChatArtifact }) {
  const active = useRetainedPanelActive();
  const environment = useAssistantFileLinkEnvironment();
  // A chat kept alive in the background runs no documents; it loads again when it is shown.
  if (!active) return null;
  return (
    <ArtifactPreview
      key={JSON.stringify([environment.serverId, environment.workspaceRoot, artifact.path])}
      artifact={artifact}
    />
  );
}

type PreviewState = { status: "loading" } | { status: "error" } | { status: "ready"; html: string };

const UNREADABLE: PreviewState = { status: "error" };

/** True once the element has scrolled into view, so a long chat only runs the visuals it shows. */
function useHasBeenVisible(element: React.RefObject<View | null>): boolean {
  const [visible, setVisible] = useState(!isWeb);
  useEffect(() => {
    if (!isWeb || visible) return;
    const node = element.current as unknown as Element | null;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [element, visible]);
  return visible;
}

function ArtifactPreview({ artifact }: { artifact: ChatArtifact }) {
  const { title, path } = artifact;
  const { client, workspaceRoot, onOpenWorkspaceFile } = useAssistantFileLinkEnvironment();
  const card = useRef<View>(null);
  const visible = useHasBeenVisible(card);
  const [state, setState] = useState<PreviewState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [height, setHeight] = useState(INITIAL_PREVIEW_HEIGHT);
  const canRead = Boolean(client?.readFile && workspaceRoot);

  useEffect(() => {
    if (!visible || !client?.readFile || !workspaceRoot) return;
    let current = true;
    setState({ status: "loading" });
    client
      .readFile(workspaceRoot, path, undefined, MAX_INLINE_ARTIFACT_BYTES)
      .then((file) => {
        if (!current) return;
        if (file.kind !== "text" || file.bytes.byteLength > MAX_INLINE_ARTIFACT_BYTES) {
          setState({ status: "error" });
          return;
        }
        setState({ status: "ready", html: decodeUtf8(file.bytes) });
        return;
      })
      .catch(() => {
        if (current) setState({ status: "error" });
      });
    return () => {
      current = false;
    };
  }, [attempt, client, path, visible, workspaceRoot]);

  const retry = useCallback(() => setAttempt((count) => count + 1), []);
  const toggle = useCallback(() => setCollapsed((value) => !value), []);
  const openInTab = useCallback(
    () => onOpenWorkspaceFile?.({ raw: path, path }, "main"),
    [onOpenWorkspaceFile, path],
  );
  const fitContent = useCallback((contentHeight: number) => {
    setHeight(Math.min(MAX_PREVIEW_HEIGHT, Math.max(MIN_PREVIEW_HEIGHT, contentHeight)));
  }, []);
  const frameStyle = useMemo(() => [styles.preview, { height }], [height]);

  return (
    <View ref={card} style={styles.card} testID="chat-artifact">
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <View style={styles.actions}>
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
          <Button
            variant="ghost"
            size="sm"
            leftIcon={collapsed ? ChevronDown : ChevronUp}
            accessibilityLabel={collapsed ? "Show preview" : "Hide preview"}
            onPress={toggle}
          />
        </View>
      </View>
      {collapsed ? null : (
        <ArtifactBody
          state={canRead ? state : UNREADABLE}
          title={title}
          frameStyle={frameStyle}
          onContentHeight={fitContent}
          onRetry={canRead ? retry : undefined}
        />
      )}
    </View>
  );
}

function ArtifactBody({
  state,
  title,
  frameStyle,
  onContentHeight,
  onRetry,
}: {
  state: PreviewState;
  title: string;
  frameStyle: React.ComponentProps<typeof View>["style"];
  onContentHeight: (height: number) => void;
  onRetry?: () => void;
}) {
  if (state.status === "loading") {
    return (
      <View style={styles.placeholder} accessibilityRole="progressbar">
        <LoadingSpinner color={styles.message.color} />
      </View>
    );
  }
  if (state.status === "error") {
    return (
      <View style={styles.placeholder}>
        <Text accessibilityRole="alert" style={styles.message}>
          Couldn’t load this visual. Try again or open it in a tab.
        </Text>
        {onRetry ? (
          <Button variant="ghost" size="sm" onPress={onRetry}>
            Retry
          </Button>
        ) : null}
      </View>
    );
  }
  return (
    <View style={frameStyle}>
      <ThemedHtmlPreview
        html={state.html}
        title={title}
        testID="chat-artifact-preview"
        onContentHeight={onContentHeight}
        uniProps={htmlPreviewTheme}
      />
    </View>
  );
}

const ThemedHtmlPreview = withUnistyles(FileHtmlPreview);

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
    gap: theme.spacing[2],
    justifyContent: "space-between",
    paddingVertical: theme.spacing[1],
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[1],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    flexShrink: 1,
  },
  actions: { alignItems: "center", flexDirection: "row", gap: theme.spacing[1] },
  placeholder: {
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    minHeight: MIN_PREVIEW_HEIGHT,
    padding: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  preview: { borderTopWidth: 1, borderTopColor: theme.colors.border },
}));
