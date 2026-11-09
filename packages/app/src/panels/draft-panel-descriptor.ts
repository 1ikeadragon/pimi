import type { ComponentType } from "react";
import { i18n } from "@/i18n/i18next";
import type { PanelDescriptor, PanelIconProps } from "@/panels/panel-registry";

export function buildDraftPanelDescriptor(input: {
  isCreating: boolean;
  pendingPrompt?: string | null;
  isProviderHandoff?: boolean;
  icon: ComponentType<PanelIconProps>;
}): PanelDescriptor {
  const { icon, isCreating, pendingPrompt } = input;
  const newAgentLabel = input.isProviderHandoff ? "Continue chat" : i18n.t("panels.draft.newAgent");
  const creatingLabel = pendingPrompt?.trim() || newAgentLabel;
  if (isCreating) {
    return {
      label: creatingLabel,
      subtitle: i18n.t("panels.draft.creatingAgent"),
      tooltip: creatingLabel,
      titleState: "ready",
      icon,
      statusBucket: "running",
    };
  }

  return {
    label: newAgentLabel,
    subtitle: newAgentLabel,
    tooltip: newAgentLabel,
    titleState: "ready",
    icon,
    statusBucket: null,
  };
}
