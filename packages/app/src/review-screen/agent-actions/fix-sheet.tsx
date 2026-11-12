// Pimi. Apache-2.0.
// Stream S5 owns this file: "Fix this" / "Fix N selected". The sheet picks a workspace, builds the
// context attachments (thread text, file and line, check log tail, annotations) and a prompt, then
// opens that workspace's composer with both prefilled. It never sends, posts or pushes: the only
// writes are a local draft, local attachments, and navigation.
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { router } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { PressHighlight } from "@/components/ui/press-highlight";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  buildDraftWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import { getForgePresentation } from "@/git/forge";
import {
  buildPullRequestCheckContextAttachment,
  buildPullRequestThreadContextAttachment,
} from "@/git/pull-request-panel/context-attachment";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import {
  buildDraftStoreKey,
  buildNewWorkspaceDraftKey,
  generateDraftId,
} from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";
import { settingsStyles } from "@/styles/settings";
import type { ReviewFixSheetProps } from "../types";
import { useFetchReviewCheckDetails, useReviewTimeline } from "../use-review-timeline";
import { useReviewFixStore } from "./fix-request";
import { buildFixPrompt, describeThread } from "./prompt";

const MAX_TARGETS = 8;

function repoMatches(remoteUrl: string | null | undefined, owner: string, name: string): boolean {
  if (!remoteUrl) return false;
  const normalized = remoteUrl.toLowerCase().replace(/\.git$/, "");
  return (
    normalized.endsWith(`/${owner}/${name}`.toLowerCase()) ||
    normalized.endsWith(`:${owner}/${name}`.toLowerCase())
  );
}

export function ReviewFixSheet({ source, selection, visible, onClose }: ReviewFixSheetProps) {
  const request = useReviewFixStore((state) => state.request);
  const closeRequest = useReviewFixStore((state) => state.close);
  // A request from a row wins; otherwise the shell's own `visible` flag opens it for the selection.
  const active =
    request ??
    (visible ? { threadIds: [...selection.threads], checkKeys: [...selection.checks] } : null);
  const handleClose = useCallback(() => {
    closeRequest();
    onClose();
  }, [closeRequest, onClose]);
  if (!active) return null;
  return (
    <FixSheetBody
      key={`${active.threadIds.join(",")}|${active.checkKeys.join(",")}`}
      source={source}
      threadIds={active.threadIds}
      checkKeys={active.checkKeys}
      onClose={handleClose}
    />
  );
}

function FixSheetBody({
  source,
  threadIds,
  checkKeys,
  onClose,
}: {
  source: ReviewFixSheetProps["source"];
  threadIds: readonly string[];
  checkKeys: readonly string[];
  onClose: () => void;
}) {
  const timeline = useReviewTimeline(source);
  const fetchDetails = useFetchReviewCheckDetails(source);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { overview, ref } = timeline;

  const threads = useMemo(
    () => timeline.threads.filter((thread) => threadIds.includes(thread.id)),
    [timeline.threads, threadIds],
  );
  const checks = useMemo(
    () => timeline.checks.filter((check) => checkKeys.includes(check.key)),
    [timeline.checks, checkKeys],
  );

  const workspaces = useSessionStore((state) => state.sessions[source.serverId]?.workspaces);
  const targets = useMemo(() => {
    if (!ref || !workspaces) return [] as { workspace: WorkspaceDescriptor; onBranch: boolean }[];
    const branch = overview?.headRefName;
    return [...workspaces.values()]
      .filter((workspace) => repoMatches(workspace.gitRuntime?.remoteUrl, ref.owner, ref.name))
      .map((workspace) => ({
        workspace,
        onBranch: !!branch && workspace.gitRuntime?.currentBranch === branch,
      }))
      .sort((a, b) => Number(b.onBranch) - Number(a.onBranch))
      .slice(0, MAX_TARGETS);
  }, [overview?.headRefName, ref, workspaces]);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const targetId = pickedId ?? targets[0]?.workspace.id ?? null;

  const ready = !!overview && !!ref && (threads.length > 0 || checks.length > 0);

  // Builds the prompt and attachments, writes them into a fresh local draft, returns its id.
  const prepareDraft = useCallback(async (): Promise<{
    draftId: string;
    draftKey: string;
  } | null> => {
    if (!overview || !ref) return null;
    const forge = timeline.forge;
    const provider = { id: forge, label: getForgePresentation(forge).brandLabel };
    const pullRequest = { number: overview.number, title: overview.title, url: overview.url };
    const attachments = [];
    const warnings: string[] = [];
    for (const thread of threads) {
      const attachment = buildPullRequestThreadContextAttachment({
        provider,
        forge,
        pullRequest,
        thread: thread.entry,
      });
      if (attachment) attachments.push(attachment);
    }
    for (const check of checks) {
      let details = null;
      if (check.hasDetails) {
        try {
          details = await fetchDetails.mutateAsync(check);
        } catch (cause) {
          warnings.push(
            `${check.name}: log unavailable (${cause instanceof Error ? cause.message : "error"})`,
          );
        }
      }
      attachments.push(
        buildPullRequestCheckContextAttachment({
          provider,
          forge,
          pullRequest,
          check: check.pane,
          githubDetails: details,
        }),
      );
    }
    const draftId = generateDraftId();
    const scopeKey = buildDraftWorkspaceAttachmentScopeKey(draftId);
    for (const attachment of attachments) {
      useWorkspaceAttachmentsStore.getState().addWorkspaceAttachment({ scopeKey, attachment });
    }
    const text = buildFixPrompt({
      title: overview.title,
      number: overview.number,
      threads,
      checks,
      note: [note, ...warnings].filter((line) => line.trim()).join("\n"),
    });
    return { draftId, draftKey: text };
  }, [checks, fetchDetails, note, overview, ref, threads, timeline.forge]);

  const run = useCallback(
    async (destination: "workspace" | "new") => {
      setBusy(true);
      setError(null);
      try {
        const prepared = await prepareDraft();
        if (!prepared) return;
        const { draftId, draftKey: text } = prepared;
        if (destination === "workspace") {
          if (!targetId) return;
          const key = buildDraftStoreKey({ serverId: source.serverId, agentId: "", draftId });
          useDraftStore.getState().editDraftText({ draftKey: key, text });
          navigateToWorkspace({
            serverId: source.serverId,
            workspaceId: targetId,
            target: { kind: "draft", draftId },
          });
        } else {
          useDraftStore
            .getState()
            .editDraftText({ draftKey: buildNewWorkspaceDraftKey(draftId), text });
          router.navigate(buildNewWorkspaceRoute({ serverId: source.serverId, draftId }));
        }
        onClose();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not prepare the chat");
      } finally {
        setBusy(false);
      }
    },
    [onClose, prepareDraft, source.serverId, targetId],
  );
  const openInWorkspace = useCallback(() => void run("workspace"), [run]);
  const openInNew = useCallback(() => void run("new"), [run]);

  const header = useMemo<SheetHeader>(
    () => ({
      title: "Fix with an agent",
      subtitle: <Text style={styles.muted}>Prefills a chat. Nothing is sent or pushed.</Text>,
    }),
    [],
  );

  return (
    <AdaptiveModalSheet visible onClose={onClose} header={header} testID="review-fix-sheet">
      <View style={styles.body}>
        {ready ? null : (
          <Text style={styles.muted}>
            {timeline.isLoading ? "Loading…" : "Nothing selected to fix."}
          </Text>
        )}
        <View style={settingsStyles.card}>
          {checks.map((check, index) => (
            <View key={check.key} style={[styles.item, index > 0 && settingsStyles.rowBorder]}>
              <StatusBadge size="xs" variant="error" label="Check" />
              <Text style={styles.itemText} numberOfLines={2}>
                {check.name}
              </Text>
            </View>
          ))}
          {threads.map((thread, index) => (
            <View
              key={thread.id}
              style={[styles.item, (index > 0 || checks.length > 0) && settingsStyles.rowBorder]}
            >
              <StatusBadge size="xs" label="Thread" />
              <Text style={styles.itemText} numberOfLines={2}>
                {describeThread(thread)}
              </Text>
            </View>
          ))}
        </View>

        <AdaptiveTextInput
          initialValue={note}
          onChangeText={setNote}
          placeholder="Optional note for the agent"
          multiline
          style={styles.input}
          testID="review-fix-note"
        />

        <Text style={styles.label}>Open the chat in</Text>
        <View style={settingsStyles.card}>
          {targets.length === 0 ? (
            <Text style={[styles.itemText, styles.pad]}>
              No workspace for {ref ? `${ref.owner}/${ref.name}` : "this repository"} on this host.
              Start a new workspace and pick the pull request there.
            </Text>
          ) : (
            targets.map(({ workspace, onBranch }, index) => (
              <TargetRow
                key={workspace.id}
                workspace={workspace}
                onBranch={onBranch}
                first={index === 0}
                selected={workspace.id === targetId}
                onPick={setPickedId}
              />
            ))
          )}
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <View style={styles.actions}>
          <Button variant="secondary" onPress={openInNew} disabled={!ready || busy}>
            New workspace
          </Button>
          <Button
            variant="default"
            onPress={openInWorkspace}
            disabled={!ready || busy || !targetId}
            testID="review-fix-open-chat"
          >
            {busy ? "Preparing…" : "Open in chat"}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

function TargetRow({
  workspace,
  onBranch,
  first,
  selected,
  onPick,
}: {
  workspace: WorkspaceDescriptor;
  onBranch: boolean;
  first: boolean;
  selected: boolean;
  onPick: (id: string) => void;
}) {
  const press = useCallback(() => onPick(workspace.id), [onPick, workspace.id]);
  const state = useMemo(() => ({ selected }), [selected]);
  const rowStyle = useMemo(() => [styles.item, !first && settingsStyles.rowBorder], [first]);
  const radioStyle = useMemo(() => [styles.radio, selected && styles.radioOn], [selected]);
  return (
    <PressHighlight
      style={rowStyle}
      onPress={press}
      accessibilityRole="radio"
      accessibilityState={state}
      testID={`review-fix-target-${workspace.id}`}
    >
      <View style={radioStyle} />
      <View style={styles.itemMain}>
        <Text style={styles.itemText} numberOfLines={1}>
          {workspace.title || workspace.name}
        </Text>
        <Text style={styles.muted} numberOfLines={1}>
          {workspace.gitRuntime?.currentBranch ?? workspace.workspaceDirectory}
        </Text>
      </View>
      {onBranch ? <StatusBadge size="xs" variant="success" label="On this branch" /> : null}
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing[3] },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  itemMain: { flex: 1, minWidth: 0 },
  itemText: { flex: 1, color: theme.colors.foreground, fontSize: theme.fontSize.base },
  pad: { padding: theme.spacing[4] },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginLeft: theme.spacing[1],
  },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.base },
  input: {
    minHeight: 72,
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    fontSize: theme.fontSize.base,
  },
  radio: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
  },
  radioOn: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing[2] },
}));
