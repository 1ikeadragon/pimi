import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { CheckoutBlameResult } from "@pimi/protocol/messages";
import { Button } from "@/components/ui/button";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { usePimiWorkbenchMode } from "@/desktop/use-pimi-workbench";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceDirectory, useWorkspaceFields } from "@/stores/session-store-hooks";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import type { FileEditorStatus } from "./model";

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
}: {
  path: string;
  content: string;
  status: FileEditorStatus;
  line: number;
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
  const query = useMemo(
    () => ({ client, cwd, path, content, line, head, retry, status }),
    [client, cwd, path, content, line, head, retry, status],
  );
  const [answer, setAnswer] = useState<{ query: object; result: CheckoutBlameResult } | null>(null);
  const hash = useRef<{ content: string; value: Promise<string> } | null>(null);
  const pending = useRef<Promise<void> | null>(null);
  const enabled = mode === "editor" && visible && isWorkspaceFocused && status === "clean";

  useEffect(() => {
    if (!enabled || !client || !cwd) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      // Serialize requests: rapid line changes never create concurrent Git work.
      const previous = pending.current;
      const work = (async () => {
        await previous;
        if (abort.signal.aborted) return;
        if (hash.current?.content !== content) {
          hash.current = {
            content,
            value: hashContent(content),
          };
        }
        const contentHash = await hash.current.value;
        if (abort.signal.aborted) return;
        const result = await client.getLineBlame({
          cwd,
          path,
          line,
          contentHash,
          signal: abort.signal,
        });
        if (!abort.signal.aborted) setAnswer({ query, result });
      })().catch(() => {
        if (!abort.signal.aborted) setAnswer({ query, result: { status: "unavailable" } });
      });
      pending.current = work;
      void work.finally(() => {
        if (pending.current === work) pending.current = null;
      });
    }, 350);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [enabled, client, cwd, path, content, line, query]);

  const handleRetry = useCallback(() => setRetry((value) => value + 1), []);
  if (mode !== "editor") return null;
  const result = answer?.query === query ? answer.result : null;
  const label = blameLabel(status, Boolean(client && cwd), result);
  return (
    <View style={styles.footer} testID="file-editor-blame">
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

const styles = StyleSheet.create((theme) => ({
  footer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 25,
    paddingHorizontal: 12,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  text: { flexShrink: 1, color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
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
  if (!result) return "Loading Git blame…";
  if (result.status !== "committed") return labels[result.status];
  return `${result.author} · ${new Date(result.authoredAt).toLocaleDateString()} · ${result.sha.slice(0, 8)} · ${result.summary}`;
}
