import { useEffect, useState, useSyncExternalStore } from "react";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import {
  openAutomationEditor,
  type AutomationEditorModel,
  type AutomationEditorSnapshot,
  type AutomationEditorState,
} from "./automation-editor-model";

/** Opens the editor model once per mount and keeps its host, project and preference inputs live. */
export type EditorProvidersSnapshot = ReturnType<typeof useProvidersSnapshot>;

export function useAutomationEditorModel(snapshot: AutomationEditorSnapshot): {
  model: AutomationEditorModel;
  state: AutomationEditorState;
  providers: EditorProvidersSnapshot;
} {
  const [model] = useState(() => openAutomationEditor(snapshot));

  useEffect(() => {
    return () => {
      model.close();
    };
  }, [model]);

  useEffect(() => {
    model.applyHosts(snapshot.hosts);
    model.applyProjectTargets(snapshot.projectTargets);
    model.applyPreferences(snapshot.preferences);
  }, [model, snapshot.hosts, snapshot.preferences, snapshot.projectTargets]);

  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const providers = useAutomationEditorProviderSnapshot(model, state);
  return { model, state, providers };
}

function useAutomationEditorProviderSnapshot(
  model: AutomationEditorModel,
  state: AutomationEditorState,
): EditorProvidersSnapshot {
  const serverId = state.providerSnapshotRequest?.serverId ?? state.selectedServerId;
  const cwd = state.providerSnapshotRequest?.cwd ?? state.workingDir;
  const enabled = Boolean(serverId && cwd.trim());
  const snapshot = useProvidersSnapshot(serverId ?? null, { cwd, enabled });

  useEffect(() => {
    if (!enabled || !serverId || !snapshot.entries) {
      return;
    }
    model.applyProviderSnapshot(serverId, snapshot.entries);
  }, [enabled, model, serverId, snapshot.entries]);

  return snapshot;
}
