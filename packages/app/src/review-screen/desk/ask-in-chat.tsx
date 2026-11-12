// Pimi. Apache-2.0.
// "Ask in chat": the user's line annotations on the change request become one `review` composer
// attachment on a new draft of a workspace of the same repository, then that workspace opens the
// draft with the attachment in its composer. Nothing is sent; sending clears the drafts (composer/attachments/workspace.tsx).
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  buildDraftWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { buildReviewAttachmentSnapshot, getReviewDraftComments } from "@/review";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { generateDraftId } from "@/stores/draft-keys";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import type { ParsedDiffFile } from "@pimi/protocol/messages";
import type { ChangeRequestSource } from "../types";
import { useDeskCopy } from "./copy";

const NO_WORKSPACES: ReadonlyMap<string, WorkspaceDescriptor> = new Map();

function normalizeRemote(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/\.git$/, "")
    .replace(/^[a-z+]+:\/\//, "")
    .replace(/^[^@/]+@/, "")
    .replace(":", "/");
}

/** Workspaces whose git remote is this change request's repository; the PR's own checkout first. */
export function matchingWorkspaces(
  workspaces: ReadonlyMap<string, WorkspaceDescriptor>,
  source: ChangeRequestSource,
): WorkspaceDescriptor[] {
  const repo = `${source.forgeHost}/${source.owner}/${source.name}`.toLowerCase();
  const matches: WorkspaceDescriptor[] = [];
  for (const workspace of workspaces.values()) {
    if (workspace.archivingAt) continue;
    const remote = workspace.gitRuntime?.remoteUrl;
    if (remote && normalizeRemote(remote) === repo) matches.push(workspace);
  }
  const isThisPr = (workspace: WorkspaceDescriptor) =>
    workspace.githubRuntime?.pullRequest?.number === source.number;
  return matches.sort((a, b) => Number(isThisPr(b)) - Number(isThisPr(a)));
}

export function AskInChat({
  source,
  reviewDraftKey,
  draftCount,
  loadedFiles,
  baseRef,
}: {
  source: ChangeRequestSource;
  reviewDraftKey: string;
  draftCount: number;
  loadedFiles: ReadonlyMap<string, ParsedDiffFile>;
  baseRef: string | null;
}) {
  const copy = useDeskCopy();
  const workspaces = useSessionStore(
    (state) => state.sessions[source.serverId]?.workspaces ?? NO_WORKSPACES,
  );
  const candidates = useMemo(() => matchingWorkspaces(workspaces, source), [workspaces, source]);
  const [error, setError] = useState<string | null>(null);

  const attach = useCallback(
    (workspace: WorkspaceDescriptor) => {
      const snapshot = buildReviewAttachmentSnapshot({
        reviewDraftKey,
        cwd: workspace.workspaceDirectory,
        mode: "all",
        baseRef,
        comments: getReviewDraftComments(reviewDraftKey) ?? [],
        diffFiles: [...loadedFiles.values()],
      });
      if (!snapshot) {
        setError(copy.askUnavailable);
        return;
      }
      setError(null);
      // A new draft tab carries the attachment: the workspace's own scope is rewritten by its
      // Changes pane whenever that is mounted, which would drop it.
      const draftId = generateDraftId();
      useWorkspaceAttachmentsStore.getState().setWorkspaceAttachments({
        scopeKey: buildDraftWorkspaceAttachmentScopeKey(draftId),
        attachments: [snapshot],
      });
      navigateToWorkspace({
        serverId: source.serverId,
        workspaceId: workspace.id,
        target: { kind: "draft", draftId },
      });
    },
    [baseRef, copy.askUnavailable, loadedFiles, reviewDraftKey, source.serverId],
  );

  if (draftCount === 0) return null;
  return (
    <View style={styles.bar} testID="review-desk-ask-bar">
      <Text style={styles.count}>{copy.annotations(draftCount)}</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <DropdownMenu>
        <DropdownMenuTrigger
          accessibilityRole="button"
          accessibilityLabel={copy.askInChat}
          style={styles.trigger}
          testID="review-desk-ask-trigger"
        >
          <Text style={styles.triggerText}>{copy.askInChat}</Text>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" minWidth={260} side="top" testID="review-desk-ask-menu">
          {candidates.length === 0 ? (
            <DropdownMenuLabel>
              {copy.noWorkspace(`${source.owner}/${source.name}`)}
            </DropdownMenuLabel>
          ) : (
            candidates.map((workspace) => (
              <AskTarget key={workspace.id} workspace={workspace} onPick={attach} />
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

function AskTarget({
  workspace,
  onPick,
}: {
  workspace: WorkspaceDescriptor;
  onPick: (workspace: WorkspaceDescriptor) => void;
}) {
  const handleSelect = useCallback(() => onPick(workspace), [onPick, workspace]);
  return (
    <DropdownMenuItem onSelect={handleSelect} testID={`review-desk-ask-${workspace.id}`}>
      {`${workspace.projectDisplayName} / ${workspace.name}`}
    </DropdownMenuItem>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  count: { flex: 1, fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  error: { fontSize: theme.fontSize.sm, color: theme.colors.destructive },
  trigger: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.accent,
  },
  triggerText: { fontSize: theme.fontSize.sm, color: theme.colors.accentForeground },
}));
