import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UserComposerAttachment } from "@/attachments/types";
import type { TextReplacement } from "@/composer/types";
import type { DraftAgentControlsProps } from "@/composer/agent-controls";
import type { DraftCommandTarget } from "@/agent-commands";
import {
  useAgentFormState,
  type CreateAgentInitialValues,
  type UseAgentFormStateResult,
} from "@/hooks/use-agent-form-state";
import { useDraftAgentFeatures } from "@/hooks/use-draft-agent-features";
import {
  buildDraftAgentControls,
  hasDraftContent,
  resolveDraftKey,
  type DraftKeyInput,
} from "@/composer/draft/input-draft-core";
import {
  buildDraftCommandTarget,
  resolveEffectiveComposerModeId,
  resolveEffectiveComposerModelId,
  resolveEffectiveComposerThinkingOptionId,
  type ProviderSelectionState,
} from "@/provider-selection/provider-selection";
import type { AnnotationAttachment } from "@/annotations/model";
import { annotationsOf, lowestFreeSlot } from "@/composer/chips/model";
import { useDraftStore } from "@/stores/draft-store";
import { AfterPaintPublication } from "@/composer/after-paint-publication";
import { useShallow } from "zustand/shallow";
import type { ComposerTextSource } from "@/composer/text-source";
import { isWeb } from "@/constants/platform";
import {
  materializeAgentProfile,
  useAgentProfiles,
  type MaterializedAgentProfile,
} from "@/agent-profiles";

type AttachmentUpdater =
  | UserComposerAttachment[]
  | ((prev: UserComposerAttachment[]) => UserComposerAttachment[]);

interface AgentInputDraftComposerOptions {
  initialServerId: string | null;
  initialValues?: CreateAgentInitialValues;
  initialFeatureValues?: Record<string, unknown>;
  isVisible?: boolean;
  lockedWorkingDir?: string;
  /** An agent profile to apply once the host's profiles and providers have loaded. */
  initialProfileId?: string;
}

/** The profile a draft is attached to: sent as `profileId` when the agent is created. */
export interface DraftAttachedProfile {
  id: string;
  name: string;
}

interface UseAgentInputDraftInput {
  draftKey: DraftKeyInput;
  composer?: AgentInputDraftComposerOptions;
}

type DraftComposerState = UseAgentFormStateResult & {
  workingDir: string;
  effectiveModeId: string;
  effectiveModelId: string;
  effectiveThinkingOptionId: string;
  featureValues: Record<string, unknown> | undefined;
  agentControls: DraftAgentControlsProps;
  commandDraft: DraftCommandTarget;
  attachedProfile: DraftAttachedProfile | null;
};

export interface AgentInputDraft {
  textSource: ComposerTextSource;
  editText: (text: string) => void;
  replaceText: (text: string) => void;
  textReplacement: TextReplacement;
  attachments: UserComposerAttachment[];
  setAttachments: (updater: AttachmentUpdater) => void;
  clear: (lifecycle: "sent" | "abandoned") => void;
  isHydrated: boolean;
  attachmentFocusRequestId: number;
  composerState: DraftComposerState | null;
}

/**
 * An annotation added by something that cannot see the stash (a plugin) may have taken the slot of
 * one the user deleted; undo would then bring back a chip that points at the wrong annotation.
 * Moves such a newcomer to a free slot.
 */
function avoidStashedSlots(
  next: UserComposerAttachment[],
  previous: readonly UserComposerAttachment[],
  stashed: readonly AnnotationAttachment[],
): UserComposerAttachment[] {
  const known = new Set(annotationsOf(previous).map((annotation) => annotation.id));
  const reserved = new Set(stashed.map((annotation) => annotation.slot));
  const used = new Set(annotationsOf(next).map((annotation) => annotation.slot));
  return next.map((attachment) => {
    if (attachment.kind !== "annotation" || known.has(attachment.id)) return attachment;
    if (!reserved.has(attachment.slot)) return attachment;
    const slot = lowestFreeSlot([...used, ...reserved]);
    if (slot === null) return attachment;
    used.add(slot);
    return { ...attachment, slot };
  });
}

export function useAgentInputDraft(input: UseAgentInputDraftInput): AgentInputDraft {
  const composerOptions = input.composer ?? null;
  const workingDir = composerOptions?.lockedWorkingDir?.trim() || "";
  const formState = useAgentFormState({
    workingDir,
    serverId: composerOptions?.initialServerId ?? null,
    initialValues: composerOptions?.initialValues,
    isVisible: composerOptions?.isVisible ?? false,
    isCreateFlow: true,
  });
  const draftKey = useMemo(
    () =>
      resolveDraftKey({
        draftKey: input.draftKey,
        selectedServerId: formState.selectedServerId,
      }),
    [formState.selectedServerId, input.draftKey],
  );
  const attachments = useDraftStore(
    useShallow((state) =>
      state.drafts[draftKey]?.lifecycle === "active"
        ? (state.drafts[draftKey].input.attachments ?? [])
        : [],
    ),
  );
  const textSource = useMemo<ComposerTextSource>(
    () => ({
      getSnapshot: () => {
        const record = useDraftStore.getState().drafts[draftKey];
        return record?.lifecycle === "active" ? record.input.text : "";
      },
      subscribe: (listener) =>
        useDraftStore.subscribe((state, previous) => {
          if (
            state.drafts[draftKey]?.input.text !== previous.drafts[draftKey]?.input.text ||
            state.drafts[draftKey]?.lifecycle !== previous.drafts[draftKey]?.lifecycle
          )
            listener();
        }),
    }),
    [draftKey],
  );
  const attachmentFocusRequestId = useDraftStore(
    (state) => state.attachmentFocusRequestByDraftKey[draftKey] ?? 0,
  );
  const [hydratedDraftKey, setHydratedDraftKey] = useState<string | null>(null);
  const isHydrated = hydratedDraftKey === draftKey;
  const textReplacementRevisionRef = useRef(0);
  const [textReplacement, setTextReplacement] = useState<TextReplacement>(() => ({
    kind: "initial",
    key: `${draftKey}:0`,
    text: textSource.getSnapshot(),
  }));

  const publishTextReplacement = useCallback(
    (kind: "hydrated" | "replace", nextText: string) => {
      textReplacementRevisionRef.current += 1;
      setTextReplacement({
        kind,
        key: `${draftKey}:${textReplacementRevisionRef.current}`,
        text: nextText,
      });
    },
    [draftKey],
  );

  const saveDraft = useCallback(
    (
      update: (draft: { text: string; attachments: UserComposerAttachment[] }) => {
        text: string;
        attachments: UserComposerAttachment[];
      },
    ) => {
      const store = useDraftStore.getState();
      const current = store.getDraftInput(draftKey) ?? { text: "", attachments: [] };
      const next = update(current);
      if (!hasDraftContent(next)) {
        store.clearDraftInput({ draftKey, lifecycle: "abandoned" });
        return;
      }
      store.saveDraftInput({ draftKey, draft: next });
    },
    [draftKey],
  );

  // The store drops or re-slots chips an edit left dangling; the editor shows what it kept.
  const commitText = useCallback(
    (nextText: string) => {
      const committed = useDraftStore.getState().editDraftText({ draftKey, text: nextText });
      if (committed !== nextText) publishTextReplacement("replace", committed);
    },
    [draftKey, publishTextReplacement],
  );

  const textPublication = useMemo(
    () => new AfterPaintPublication<string>(commitText),
    [commitText],
  );

  const editText = useCallback(
    (nextText: string) => {
      if (isWeb) {
        textPublication.stage(nextText);
      } else {
        commitText(nextText);
      }
    },
    [commitText, textPublication],
  );

  const replaceText = useCallback(
    (nextText: string) => {
      textPublication.cancel();
      const committed = useDraftStore.getState().editDraftText({ draftKey, text: nextText });
      publishTextReplacement("replace", committed);
    },
    [draftKey, publishTextReplacement, textPublication],
  );

  const setAttachments = useCallback(
    (updater: AttachmentUpdater) => {
      saveDraft((current) => {
        const next = typeof updater === "function" ? updater(current.attachments) : updater;
        const stashed = useDraftStore.getState().detachedAnnotationsByDraftKey[draftKey] ?? [];
        return { ...current, attachments: avoidStashedSlots(next, current.attachments, stashed) };
      });
    },
    [draftKey, saveDraft],
  );

  // Kept until the draft is sent or the user detaches it; changing the model does not detach it,
  // because the instructions are what the profile adds.
  const [attachedProfile, setAttachedProfile] = useState<DraftAttachedProfile | null>(null);

  const clear = useCallback(
    (lifecycle: "sent" | "abandoned") => {
      textPublication.cancel();
      useDraftStore.getState().clearDraftInput({ draftKey, lifecycle });
      setAttachedProfile(null);
    },
    [draftKey, textPublication],
  );

  useEffect(() => {
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") textPublication.flush();
    };
    const flush = () => textPublication.flush();
    const canListenForPageHide =
      isWeb && typeof window !== "undefined" && typeof window.addEventListener === "function";
    if (isWeb && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", flushWhenHidden);
    }
    if (canListenForPageHide) {
      window.addEventListener("pagehide", flush);
    }
    return () => {
      if (isWeb && typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", flushWhenHidden);
      }
      if (canListenForPageHide) {
        window.removeEventListener("pagehide", flush);
      }
      textPublication.flush();
    };
  }, [textPublication]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await useDraftStore.getState().hydrateDraftInput({ draftKey });
      if (!cancelled) {
        const hydratedText = useDraftStore.getState().getDraftInput(draftKey)?.text ?? "";
        publishTextReplacement("hydrated", hydratedText);
        setHydratedDraftKey(draftKey);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [draftKey, publishTextReplacement]);

  const providerSelection = useMemo<ProviderSelectionState>(
    () => ({
      provider: formState.selectedProvider,
      modelId: formState.selectedModel,
      modeId: formState.selectedMode,
      thinkingOptionId: formState.selectedThinkingOptionId,
      availableModels: formState.availableModels,
      modeOptions: formState.modeOptions,
    }),
    [
      formState.availableModels,
      formState.modeOptions,
      formState.selectedMode,
      formState.selectedModel,
      formState.selectedProvider,
      formState.selectedThinkingOptionId,
    ],
  );

  const effectiveModeId = useMemo(
    () => resolveEffectiveComposerModeId(providerSelection, formState.isModelLoading),
    [formState.isModelLoading, providerSelection],
  );

  const effectiveModelId = useMemo(
    () => resolveEffectiveComposerModelId(providerSelection),
    [providerSelection],
  );

  const effectiveThinkingOptionId = useMemo(
    () => resolveEffectiveComposerThinkingOptionId(providerSelection, effectiveModelId),
    [effectiveModelId, providerSelection],
  );

  const {
    features: draftFeatures,
    featureValues: draftFeatureValues,
    setFeatureValue: setDraftFeatureValue,
    applyProfileFeatureValues,
  } = useDraftAgentFeatures({
    serverId: formState.selectedServerId,
    provider: formState.selectedProvider,
    cwd: workingDir,
    modeId: formState.selectedMode,
    modelId: effectiveModelId,
    thinkingOptionId: effectiveThinkingOptionId,
    initialFeatureValues: composerOptions?.initialFeatureValues,
  });

  const applyDraftAgentProfile = useCallback(
    (profile: MaterializedAgentProfile) => {
      // A profile without a provider keeps the draft's provider and adds only its instructions.
      if (profile.provider) {
        formState.applyProfileFromUser(profile);
        applyProfileFeatureValues(profile.featureValues);
      }
      setAttachedProfile({ id: profile.id, name: profile.name });
    },
    [applyProfileFeatureValues, formState],
  );
  const detachAgentProfile = useCallback(() => setAttachedProfile(null), []);

  useApplyInitialProfile({
    profileId: composerOptions?.initialProfileId ?? null,
    serverId: formState.selectedServerId,
    formState,
    apply: applyDraftAgentProfile,
  });

  const commandDraft = useMemo(
    () =>
      buildDraftCommandTarget({
        selection: providerSelection,
        cwd: workingDir,
        effectiveModelId,
        effectiveThinkingOptionId,
        featureValues: draftFeatureValues,
      }),
    [
      effectiveModelId,
      effectiveThinkingOptionId,
      draftFeatureValues,
      providerSelection,
      workingDir,
    ],
  );

  const composerState = useMemo<DraftComposerState | null>(() => {
    if (!composerOptions) {
      return null;
    }

    return {
      ...formState,
      workingDir,
      effectiveModeId,
      effectiveModelId,
      effectiveThinkingOptionId,
      featureValues: draftFeatureValues,
      agentControls: buildDraftAgentControls({
        formState,
        features: draftFeatures,
        onSetFeature: setDraftFeatureValue,
        onApplyAgentProfile: applyDraftAgentProfile,
        attachedProfile,
        onDetachAgentProfile: detachAgentProfile,
      }),
      commandDraft,
      attachedProfile,
    };
  }, [
    commandDraft,
    composerOptions,
    effectiveModeId,
    effectiveModelId,
    effectiveThinkingOptionId,
    draftFeatures,
    draftFeatureValues,
    applyDraftAgentProfile,
    attachedProfile,
    detachAgentProfile,
    formState,
    setDraftFeatureValue,
    workingDir,
  ]);

  return {
    textSource,
    editText,
    replaceText,
    textReplacement,
    attachments,
    setAttachments,
    clear,
    isHydrated,
    attachmentFocusRequestId,
    composerState,
  };
}

/**
 * Applies a profile named by the route (Try it, or a new agent started from a running one) once:
 * after the host's profiles arrive and, for a profile with a provider, once that provider's models
 * have loaded so the draft can select them.
 */
function useApplyInitialProfile(input: {
  profileId: string | null;
  serverId: string | null;
  formState: UseAgentFormStateResult;
  apply: (profile: MaterializedAgentProfile) => void;
}): void {
  const { profileId, serverId, formState, apply } = input;
  const { profiles } = useAgentProfiles(profileId ? serverId : null);
  const appliedRef = useRef<string | null>(null);
  const providerReady = useCallback(
    (provider: string) =>
      !formState.isAllModelsLoading &&
      formState.modelSelectorProviders.some((entry) => entry.id === provider),
    [formState.isAllModelsLoading, formState.modelSelectorProviders],
  );
  useEffect(() => {
    if (!profileId || appliedRef.current === profileId || !profiles) return;
    const profile = profiles.find((entry) => entry.id === profileId);
    if (!profile) return;
    if (profile.provider && !providerReady(profile.provider)) return;
    appliedRef.current = profileId;
    apply(materializeAgentProfile(profile));
  }, [apply, profileId, profiles, providerReady]);
}

export const __private__ = {
  resolveDraftKey,
  resolveEffectiveComposerModeId,
  resolveEffectiveComposerModelId,
  resolveEffectiveComposerThinkingOptionId,
  buildDraftCommandTarget,
  buildDraftAgentControls,
};
