import type { TFunction } from "i18next";
import type {
  InstructionLayer,
  InstructionLayerStatus,
  InstructionsTarget,
} from "@pimi/protocol/messages";
import type { StatusBadgeVariant } from "@/components/ui/status-badge";

export function instructionsQueryKey(serverId: string, target: InstructionsTarget | null) {
  return ["provider-instructions", serverId, target] as const;
}

/**
 * Loaded is the only state that shows the agent the file's text. Everything the resolver could
 * not read for a reason Pimi can name is a warning; a read that failed is an error; the rest are
 * ordinary facts about how the provider behaves, so they stay muted.
 */
const STATUS_VARIANT: Record<InstructionLayerStatus, StatusBadgeVariant> = {
  loaded: "success",
  missing: "muted",
  skipped: "muted",
  on_demand: "muted",
  unreadable: "error",
  over_budget: "warning",
  unknown: "warning",
};

export function statusVariant(status: InstructionLayerStatus): StatusBadgeVariant {
  return STATUS_VARIANT[status];
}

/** A missing file is the normal case for most paths a provider checks; only show it when asked. */
export function isQuietLayer(layer: InstructionLayer): boolean {
  return layer.status === "missing";
}

export function layerTitle(layer: InstructionLayer, t: TFunction): string {
  switch (layer.kind) {
    case "profile":
      return t("instructions.layer.profile", { name: layer.name ?? "" });
    case "agent_definition":
      return t("instructions.layer.agentDefinition", { name: layer.name ?? "" });
    case "host_prompt":
      return t("instructions.layer.hostPrompt");
    case "builtin":
      return layer.builtinPart ? t(`instructions.builtin.${layer.builtinPart}`) : layer.id;
    case "file":
    case "remote_url":
      return layer.displayPath ?? layer.path ?? layer.id;
  }
}

export function formatSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  return `${(sizeBytes / 1024).toFixed(1)} KB`;
}
