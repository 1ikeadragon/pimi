import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { DaemonClient } from "@pimi/client/internal/daemon-client";
import type { CheckoutBlameResult } from "@pimi/protocol/messages";
import { Button } from "@/components/ui/button";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { usePimiWorkbenchMode } from "@/desktop/use-pimi-workbench";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceDirectory, useWorkspaceFields } from "@/stores/session-store-hooks";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import type { FileEditorStatus } from "./model";

const DEBOUNCE_MS = 150;

const labels = {
  uncommitted: "Uncommitted line",
  untracked: "Untracked file",
  not_git: "Not a Git repository",
  stale: "File changed · waiting for reload",
  unavailable: "Git blame unavailable",
  changed: "Working tree changed",
};

/** Read-only attribution; dirty buffers must never inherit a saved line's author. */
export function FileLineBlame({
  path,
  content,
  status,
  line,
  inline = false,
}: {
  path: string;
  content: string;
  status: FileEditorStatus;
  line: number;
  inline?: boolean;
}) {
  const { serverId, workspaceId } = usePaneContext();
  const { isWorkspaceFocused } = usePaneFocus();
  const visible = useRetainedPanelActive();
  const mode = usePimiWorkbenchMode(buildWorkspaceTabPersistenceKey({ serverId, workspaceId }));
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  const head = useWorkspaceFields(
    serverId,
    workspaceId,
    (workspace) => workspace.gitRuntime?.headSha,
  );
  const [retry, setRetry] = useState(0);
  const enabled = mode === "editor" && visible && isWorkspaceFocused && status === "clean";
  const result = useLineBlame({ enabled, client, cwd, path, content, line, head, retry });
  const handleRetry = useCallback(() => setRetry((value) => value + 1), []);
  if (mode !== "editor") return null;
  const label = blameLabel(status, Boolean(client && cwd), result);
  return (
    <View style={[styles.row, !inline && styles.footer]} testID="file-editor-blame">
      <Text style={styles.text} numberOfLines={1} accessibilityLabel={label}>
        {label}
      </Text>
      {status === "clean" && (result?.status === "unavailable" || result?.status === "stale") ? (
        <Button
          variant="ghost"
          size="sm"
          onPress={handleRetry}
          accessibilityLabel="Retry Git blame"
        >
          Retry
        </Button>
      ) : null}
    </View>
  );
}

interface LineBlameInput {
  enabled: boolean;
  client: DaemonClient | null;
  cwd: string | null;
  path: string;
  content: string;
  line: number;
  head: string | null | undefined;
  retry: number;
}

/**
 * Per-line results for the current file content and HEAD. Cursor moves read the cache
 * synchronously, so a revisited line renders instantly and nothing refetches until the content
 * or HEAD changes. An uncached line has no result until its fetch lands.
 */
function useLineBlame(input: LineBlameInput): CheckoutBlameResult | null {
  const { enabled, client, cwd, path, content, line, head, retry } = input;
  const cache = useRef<{
    scope: string;
    content: string;
    lines: Map<number, CheckoutBlameResult>;
  } | null>(null);
  const hash = useRef<{ content: string; value: Promise<string> } | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((value) => value + 1), []);
  const scope = `${cwd}\0${path}\0${head ?? ""}\0${retry}`;
  if (cache.current?.scope !== scope || cache.current.content !== content) {
    cache.current = { scope, content, lines: new Map() };
  }
  const cached = cache.current.lines.get(line) ?? null;
  const needsFetch = enabled && Boolean(client && cwd) && cached === null;

  useEffect(() => {
    if (!needsFetch || !client || !cwd) return;
    const abort = new AbortController();
    const target = cache.current;
    const store = (result: CheckoutBlameResult) => {
      if (abort.signal.aborted || !target) return;
      target.lines.set(line, result);
      refresh();
    };
    const timer = setTimeout(() => {
      // The server shares one whole-file blame per file, so concurrent requests are cheap.
      void (async () => {
        if (hash.current?.content !== content) {
          hash.current = { content, value: hashContent(content) };
        }
        const contentHash = await hash.current.value;
        if (abort.signal.aborted) return;
        store(await client.getLineBlame({ cwd, path, line, contentHash, signal: abort.signal }));
      })().catch(() => store({ status: "unavailable" }));
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [needsFetch, client, cwd, path, content, line, scope, refresh]);

  void tick;
  return cached;
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 1,
    minWidth: 0,
    gap: theme.spacing[2],
  },
  footer: {
    minHeight: 25,
    paddingHorizontal: 12,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  text: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));

async function hashContent(content: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function blameLabel(
  status: FileEditorStatus,
  connected: boolean,
  result: CheckoutBlameResult | null,
): string {
  if (status === "saving") return "Saving… · blame paused";
  if (status !== "clean") return "Unsaved changes · blame paused";
  if (!connected) return "Git blame unavailable";
  // Nothing (but a line-height placeholder) until this line is ready; no loading flash.
  if (!result) return "\u00A0";
  if (result.status !== "committed") return labels[result.status];
  return `${result.author} · ${new Date(
    result.authoredAt,
  ).toLocaleDateString()} · ${result.sha.slice(0, 8)} · ${result.summary}`;
}
