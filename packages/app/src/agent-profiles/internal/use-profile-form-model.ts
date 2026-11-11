import { useEffect, useState, useSyncExternalStore } from "react";
import {
  openAgentProfileForm,
  type AgentProfileFormModel,
  type AgentProfileFormSnapshot,
  type AgentProfileFormState,
} from "./profile-form-model";
import { useAgentProfileFormCatalog, useAgentProfileFormFeatures } from "./use-profile-form-inputs";

/**
 * One model per mount. The modal keys its body on mode + profile id, so create
 * and edit never share an instance and reopening always starts from the record.
 */
export function useAgentProfileFormModel(
  snapshot: AgentProfileFormSnapshot,
): AgentProfileFormModel {
  const [model] = useState(() => openAgentProfileForm(snapshot));

  useEffect(() => {
    return () => {
      model.close();
    };
  }, [model]);

  return model;
}

export function useAgentProfileFormState(model: AgentProfileFormModel): AgentProfileFormState {
  return useSyncExternalStore(model.subscribe, model.getState, model.getState);
}

/**
 * A profile form bound to one host: the model, its state, and the host's provider catalog and
 * feature listings feeding it. Used by the profile page; the quick-edit sheet wires the same
 * pieces itself.
 */
export function useAgentProfileForm(input: {
  serverId: string;
  snapshot: AgentProfileFormSnapshot;
}): { model: AgentProfileFormModel; state: AgentProfileFormState } {
  const model = useAgentProfileFormModel(input.snapshot);
  const state = useAgentProfileFormState(model);
  useAgentProfileFormCatalog({ serverId: input.serverId, model });
  useAgentProfileFormFeatures({ serverId: input.serverId, model, state });
  return { model, state };
}
