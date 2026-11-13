import { useRouter } from "expo-router";
import { useTranslation } from "@/i18n/use-translation";
import type { AgentForkContextOptions, DaemonClient } from "@pimi/client/internal/daemon-client";
import type { WorkspaceComposerAttachment } from "@/attachments/types";
import type { AssistantForkTarget } from "@/components/assistant-fork-menu";
import type { ToastApi } from "@/components/toast-host";
import type { AgentScreenAgent } from "@/hooks/use-agent-screen-state-machine";
import { useStableEvent } from "@/hooks/use-stable-event";
import { buildDraftStoreKey, generateDraftId } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import {
  buildDraftWorkspaceAttachmentScopeKey,
  flushWorkspaceChatHistory,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import { useWorkspaceDraftSubmissionStore } from "@/stores/workspace-draft-submission-store";
import { toErrorMessage } from "@/utils/error-messages";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";
import type { WorkspaceDraftTabSetup, WorkspaceTabTarget } from "@/workspace-tabs/model";

/**
 * The subset of an agent record that a fork needs in order to seed the new
 * draft. Kept structural so both `AgentScreenAgent` (the agent-stream view's
 * live context) and the session store's `Agent` record satisfy it without a
 * projection step.
 */
export type ForkAgentSource = Pick<
  AgentScreenAgent,
  | "provider"
  | "cwd"
  | "currentModeId"
  | "model"
  | "thinkingOptionId"
  | "runtimeInfo"
  | "features"
  | "projectPlacement"
>;

/**
 * Boundary marking where the forked context should stop. Omit it entirely to
 * fork the whole timeline *up to now* — including a partially streamed
 * in-flight turn. `selectForkContextRows` projects the full timeline when
 * neither field is present, which is what makes mid-run forking work.
 */
export type ForkAgentBoundary = Pick<
  AgentForkContextOptions,
  "boundaryCursor" | "boundaryMessageId"
>;

export interface ForkAgentRequest {
  agentId: string;
  agent: ForkAgentSource;
  workspaceId?: string;
  target: AssistantForkTarget;
  boundary?: ForkAgentBoundary;
  handoffFromProvider?: string;
}

export interface UseForkAgentInput {
  serverId: string;
  toast?: ToastApi | null;
  /** Read-only surfaces (provider subagent panes) must never fork. */
  readOnly?: boolean;
}

function buildChatHistoryAttachment(input: {
  draftId: string;
  serverId: string;
  agentId: string;
  payload: Awaited<ReturnType<DaemonClient["buildAgentForkContext"]>>;
  sourceProvider?: string;
  missingAttachmentMessage: string;
  handoffFromProvider?: string;
}): WorkspaceComposerAttachment {
  if (!input.payload.attachment) {
    throw new Error(input.missingAttachmentMessage);
  }
  return {
    kind: "chat_history",
    id: `chat_history:${input.draftId}`,
    attachment: input.handoffFromProvider
      ? { ...input.payload.attachment, title: "Provider handoff" }
      : input.payload.attachment,
    source: {
      serverId: input.serverId,
      agentId: input.agentId,
      boundaryMessageId: input.payload.boundaryMessageId,
      boundaryCursor: input.payload.boundaryCursor,
      itemCount: input.payload.itemCount,
      providerLabel: input.handoffFromProvider,
      providerId: input.handoffFromProvider ? input.sourceProvider : undefined,
      truncated: input.payload.truncated,
    },
  };
}

function buildForkDraftSetup(
  agent: ForkAgentSource,
  target: AssistantForkTarget,
): WorkspaceDraftTabSetup | undefined {
  if (typeof target !== "string" && target.provider !== agent.provider) {
    return {
      provider: target.provider,
      cwd: agent.cwd,
      modeId: null,
      model: target.model ?? null,
      thinkingOptionId: null,
      featureValues: {},
    };
  }
  if (!agent.provider) {
    return undefined;
  }

  const featureValues: Record<string, unknown> = {};
  for (const feature of agent.features ?? []) {
    featureValues[feature.id] = feature.value;
  }

  return {
    provider: agent.provider,
    cwd: agent.cwd,
    modeId: agent.currentModeId ?? agent.runtimeInfo?.modeId ?? null,
    model: agent.model ?? agent.runtimeInfo?.model ?? null,
    thinkingOptionId: agent.thinkingOptionId ?? agent.runtimeInfo?.thinkingOptionId ?? null,
    featureValues,
  };
}

function buildForkDraftTabTarget(
  setup: WorkspaceDraftTabSetup | undefined,
  draftId: string,
): WorkspaceTabTarget {
  return setup ? { kind: "draft", draftId, setup } : { kind: "draft", draftId };
}

/**
 * Shared fork driver behind both turn-footer fork affordances: the completed
 * turn's footer (which supplies a boundary pinned to that turn) and the
 * in-flight turn's footer next to the progress loader (which omits the boundary
 * so the fork captures the still-streaming response).
 */
export function useForkAgent(
  input: UseForkAgentInput,
): (request: ForkAgentRequest) => Promise<void> {
  const { serverId, toast, readOnly = false } = input;
  const { t } = useTranslation();
  const router = useRouter();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);

  return useStableEvent(
    async ({ agentId, agent, workspaceId, target, boundary, handoffFromProvider }) => {
      try {
        if (readOnly) return;
        if (!client) {
          throw new Error(t("workspace.terminal.hostDisconnected"));
        }
        const draftSetup = buildForkDraftSetup(agent, target);
        const prepareForkDraft = async () => {
          const draftId = generateDraftId();
          const payload = await client.buildAgentForkContext(agentId, boundary);
          const attachment = buildChatHistoryAttachment({
            draftId,
            serverId,
            agentId,
            payload,
            sourceProvider: agent.provider,
            handoffFromProvider,
            missingAttachmentMessage: t("message.actions.forkFailed"),
          });
          useWorkspaceAttachmentsStore.getState().setWorkspaceAttachments({
            scopeKey: buildDraftWorkspaceAttachmentScopeKey(draftId),
            attachments: [attachment],
          });
          // Do not expose a continuation draft that cannot survive a restart.
          try {
            await flushWorkspaceChatHistory();
          } catch (error) {
            useWorkspaceAttachmentsStore.getState().clearWorkspaceAttachments({
              scopeKey: buildDraftWorkspaceAttachmentScopeKey(draftId),
            });
            throw error;
          }
          if (handoffFromProvider) {
            const drafts = useDraftStore.getState();
            const source = drafts.getDraftInput(buildDraftStoreKey({ serverId, agentId }));
            if (source) {
              drafts.saveDraftInput({
                draftKey: buildDraftStoreKey({ serverId, agentId: "", draftId }),
                draft: source,
              });
            }
          }
          return draftId;
        };

        if (target !== "workspace") {
          if (!workspaceId) {
            throw new Error(t("message.actions.forkMissingWorkspace"));
          }
          const draftId = await prepareForkDraft();
          navigateToWorkspace({
            serverId,
            workspaceId,
            target: buildForkDraftTabTarget(draftSetup, draftId),
          });
          return;
        }

        const draftId = await prepareForkDraft();
        const sourceDirectory =
          agent.projectPlacement?.checkout?.cwd?.trim() || agent.cwd.trim() || undefined;
        if (draftSetup) {
          useWorkspaceDraftSubmissionStore.getState().setDraftSetup({
            draftId,
            setup: draftSetup,
            sourceDirectory,
          });
        }
        router.push(
          buildNewWorkspaceRoute({
            serverId,
            sourceDirectory,
            displayName: agent.projectPlacement?.projectName,
            projectId: agent.projectPlacement?.projectKey,
            draftId,
          }),
        );
      } catch (error) {
        toast?.error(toErrorMessage(error) || t("message.actions.forkFailed"));
      }
    },
  );
}
