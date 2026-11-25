// Pimi. PolyForm-Noncommercial-1.0.0.
// What the user does with their review notes. A worktree review sends them to a chat as annotation
// chips (the chat that offered the review, else the chat working in this directory), removing each
// note once its chip is in the draft. A pull request, or a worktree no chat is working in, keeps
// "Ask in chat": the notes become one `review` attachment on a new draft of a workspace, and
// sending that draft clears them (composer/attachments/workspace.tsx). Nothing is ever sent
// without the user pressing send in the composer.
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
import { AnnotationAttachmentSchema } from "@/annotations/model";
import { Button } from "@/components/ui/button";
import { MAX_CHIPS } from "@/composer/chips/model";
import { useToast } from "@/contexts/toast-api-context";
import { useTranslation } from "@/i18n/use-translation";
import { buildReviewAttachmentSnapshot } from "@/review";
import { fileForNote } from "@/review/anchor";
import type { ReviewDraftComment } from "@/review/state";
import { useDeleteReviewDraftComments } from "@/review/store";
import { useDraftStore } from "@/stores/draft-store";
import { useSessionStore, type Agent, type WorkspaceDescriptor } from "@/stores/session-store";
import { buildDraftStoreKey, generateDraftId } from "@/stores/draft-keys";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { generateMessageId } from "@/types/stream";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import type { ParsedDiffFile } from "@pimi/protocol/messages";
import type { ChangeRequestSource, ReviewSource } from "../types";
import { useDeskCopy } from "./copy";
import { noteToAnnotation } from "./note-annotation";
import { resolveNoteTarget, type NoteChatCandidate } from "./note-target";
import { sendNotes } from "./send-notes";

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

function workspacesFor(
  workspaces: ReadonlyMap<string, WorkspaceDescriptor>,
  source: ReviewSource,
): WorkspaceDescriptor[] {
  if (source.kind === "change_request") return matchingWorkspaces(workspaces, source);
  return [...workspaces.values()].filter(
    (workspace) => !workspace.archivingAt && workspace.workspaceDirectory === source.cwd,
  );
}

/** An untitled chat is named by the start of its id. */
const UNTITLED_CHAT_ID_LENGTH = 8;

type AgentMap = ReadonlyMap<string, Agent> | undefined;

function chatCandidate(
  agentId: string | undefined,
  agents: AgentMap,
  details: AgentMap,
  workspaces: ReadonlyMap<string, WorkspaceDescriptor>,
): NoteChatCandidate | null {
  if (!agentId) return null;
  const agent = agents?.get(agentId) ?? details?.get(agentId);
  // The same availability rule an annotation chip's target uses: known and not archived.
  if (!agent || agent.archivedAt) return null;
  return toCandidate(agent, workspaces);
}

function toCandidate(
  agent: Agent,
  workspaces: ReadonlyMap<string, WorkspaceDescriptor>,
): NoteChatCandidate {
  const workspace = agent.workspaceId ? workspaces.get(agent.workspaceId) : undefined;
  return {
    agentId: agent.id,
    title: agent.title ?? "",
    directory: workspace?.workspaceDirectory ?? agent.cwd,
    lastActivityAt: agent.lastActivityAt.getTime(),
  };
}

/** Chats the user talks to: not subagents, not archived, not background. */
function rootChats(
  agents: AgentMap,
  workspaces: ReadonlyMap<string, WorkspaceDescriptor>,
): NoteChatCandidate[] {
  if (!agents) return [];
  const chats: NoteChatCandidate[] = [];
  for (const agent of agents.values()) {
    if (agent.parentAgentId || agent.archivedAt || agent.background) continue;
    chats.push(toCandidate(agent, workspaces));
  }
  return chats;
}

export function AskInChat({
  source,
  reviewDraftKey,
  notes,
  outdatedIds,
  loadedFiles,
  baseRef,
  onViewNotes,
}: {
  source: ReviewSource;
  reviewDraftKey: string;
  /** Every note of this review, in the order they are sent. */
  notes: readonly ReviewDraftComment[];
  outdatedIds: ReadonlySet<string>;
  loadedFiles: ReadonlyMap<string, ParsedDiffFile>;
  baseRef: string | null;
  onViewNotes: () => void;
}) {
  const copy = useDeskCopy();
  const { t } = useTranslation();
  const toast = useToast();
  const deleteReviewDraftComments = useDeleteReviewDraftComments();
  const workspaces = useSessionStore(
    (state) => state.sessions[source.serverId]?.workspaces ?? NO_WORKSPACES,
  );
  const agents = useSessionStore((state) => state.sessions[source.serverId]?.agents);
  const agentDetails = useSessionStore((state) => state.sessions[source.serverId]?.agentDetails);
  const candidates = useMemo(() => workspacesFor(workspaces, source), [workspaces, source]);
  const target = useMemo(
    () =>
      source.kind === "checkout"
        ? resolveNoteTarget({
            cwd: source.cwd,
            origin: chatCandidate(source.origin?.agentId, agents, agentDetails, workspaces),
            chats: rootChats(agents, workspaces),
          })
        : ({ kind: "none" } as const),
    [agents, agentDetails, source, workspaces],
  );
  const mode = source.kind === "checkout" ? source.compare.mode : "all";
  const repoLabel =
    source.kind === "change_request"
      ? `${source.owner}/${source.name}`
      : (source.cwd.split(/[\\/]/).findLast(Boolean) ?? source.cwd);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const openAsk = useCallback(() => setAskOpen(true), []);

  const sendTo = useCallback(
    async (chat: NoteChatCandidate) => {
      if (source.kind !== "checkout" || sending) return;
      setSending(true);
      setError(null);
      const draftKey = buildDraftStoreKey({ serverId: source.serverId, agentId: chat.agentId });
      const store = useDraftStore.getState();
      const result = await sendNotes({
        notes,
        toAnnotation: (note) =>
          AnnotationAttachmentSchema.omit({ slot: true }).parse(
            noteToAnnotation({
              note,
              file: fileForNote(loadedFiles, note.filePath),
              outdated: outdatedIds.has(note.id),
              serverId: source.serverId,
              cwd: source.cwd,
              baseRef,
              id: generateMessageId(),
            }),
          ),
        attach: (attachment) => store.attachAnnotation({ draftKey, attachment }),
        remove: (note) =>
          deleteReviewDraftComments({ key: reviewDraftKey, ids: new Set([note.id]) }),
      });
      setSending(false);
      if (result.sent > 0) {
        navigateToAgent({ serverId: source.serverId, agentId: chat.agentId });
        store.requestComposerFocus({ draftKey });
      }
      if (result.stopped?.reason === "limit") {
        toast.show(
          t("reviewScreen.notes.sentPartial", {
            sent: result.sent,
            total: result.total,
            limit: MAX_CHIPS,
          }),
          { variant: "warning" },
        );
      } else if (result.stopped) {
        const message = describeError(result.stopped.error);
        setError(
          t("reviewScreen.notes.sendFailed", { message, count: result.total - result.sent }),
        );
      }
    },
    [
      baseRef,
      deleteReviewDraftComments,
      loadedFiles,
      notes,
      outdatedIds,
      reviewDraftKey,
      sending,
      source,
      t,
      toast,
    ],
  );
  const handleSendChosen = useCallback(
    (chat: NoteChatCandidate) => {
      setPickOpen(false);
      void sendTo(chat);
    },
    [sendTo],
  );
  const handleSendClick = useCallback(() => {
    if (target.kind === "chat") void sendTo(target.chat);
    else setPickOpen(true);
  }, [sendTo, target]);
  const openPick = useCallback(() => setPickOpen(true), []);

  const attach = useCallback(
    (workspace: WorkspaceDescriptor) => {
      const { attachment } = buildReviewAttachmentSnapshot({
        reviewDraftKey,
        cwd: workspace.workspaceDirectory,
        mode,
        baseRef,
        comments: notes,
        diffFiles: [...loadedFiles.values()],
      });
      if (!attachment) {
        setError(copy.askUnavailable);
        return;
      }
      setError(null);
      // A new draft tab carries the attachment: the workspace's own scope is rewritten by its
      // Changes pane whenever that is mounted, which would drop it.
      const draftId = generateDraftId();
      useWorkspaceAttachmentsStore.getState().setWorkspaceAttachments({
        scopeKey: buildDraftWorkspaceAttachmentScopeKey(draftId),
        attachments: [attachment],
      });
      navigateToWorkspace({
        serverId: source.serverId,
        workspaceId: workspace.id,
        target: { kind: "draft", draftId },
      });
    },
    [baseRef, copy.askUnavailable, loadedFiles, mode, notes, reviewDraftKey, source.serverId],
  );

  if (notes.length === 0) return null;
  const outdatedCount = notes.filter((note) => outdatedIds.has(note.id)).length;
  let send: React.ReactNode;
  if (target.kind === "none") {
    send = (
      <DropdownMenu open={askOpen} onOpenChange={setAskOpen}>
        <DropdownMenuTrigger
          accessibilityRole="button"
          accessibilityLabel={copy.askInChat}
          testID="review-desk-ask-trigger"
        >
          <Button variant="default" size="sm" onPress={openAsk}>
            {copy.askInChat}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" minWidth={260} side="top" testID="review-desk-ask-menu">
          {candidates.length === 0 ? (
            <DropdownMenuLabel>{copy.noWorkspace(repoLabel)}</DropdownMenuLabel>
          ) : (
            candidates.map((workspace) => (
              <AskTarget key={workspace.id} workspace={workspace} onPick={attach} />
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  } else if (target.kind === "chat") {
    send = (
      <Button
        variant="default"
        size="sm"
        loading={sending}
        onPress={handleSendClick}
        testID="review-notes-send"
      >
        {t("reviewScreen.notes.sendTo", { chat: chatLabel(target.chat) })}
      </Button>
    );
  } else {
    send = (
      <DropdownMenu open={pickOpen} onOpenChange={setPickOpen}>
        <DropdownMenuTrigger
          accessibilityRole="button"
          accessibilityLabel={t("reviewScreen.notes.sendToChat")}
        >
          <Button
            variant="default"
            size="sm"
            loading={sending}
            onPress={openPick}
            testID="review-notes-send"
          >
            {t("reviewScreen.notes.sendToChat")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" minWidth={260} side="top" testID="review-notes-send-menu">
          {target.chats.map((chat) => (
            <SendTarget key={chat.agentId} chat={chat} onPick={handleSendChosen} />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  return (
    <View style={styles.bar} testID="review-desk-ask-bar">
      <Text style={styles.count}>
        {copy.annotations(notes.length)}
        {outdatedCount > 0 ? ` · ${copy.outdatedCount(outdatedCount)}` : ""}
      </Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Button variant="ghost" size="sm" onPress={onViewNotes} testID="review-notes-view">
        {t("reviewScreen.notes.view")}
      </Button>
      {send}
    </View>
  );
}

function chatLabel(chat: NoteChatCandidate): string {
  return chat.title || chat.agentId.slice(0, UNTITLED_CHAT_ID_LENGTH);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function SendTarget({
  chat,
  onPick,
}: {
  chat: NoteChatCandidate;
  onPick: (chat: NoteChatCandidate) => void;
}) {
  const handleSelect = useCallback(() => onPick(chat), [chat, onPick]);
  return (
    <DropdownMenuItem onSelect={handleSelect} testID={`review-notes-send-${chat.agentId}`}>
      {chatLabel(chat)}
    </DropdownMenuItem>
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
}));
