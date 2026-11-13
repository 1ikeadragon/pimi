import type {
  AgentModePermissionClass,
  AgentProviderModeDefinition,
} from "@pimi/protocol/provider-manifest";
import type { AgentProviderSwitchMarker } from "@pimi/protocol/agent-types";
import type { ManagedAgent } from "../agent-manager.js";
import type { AgentProvider } from "../agent-sdk-types.js";
import type { AgentProviderSwitchTarget } from "../provider-switch.js";
import type { ProviderSnapshotManager } from "../provider-snapshot-manager.js";

type PermissionClass = AgentModePermissionClass | "unattended";

/**
 * Target classes to try, nearest first, for each class a chat can be in. Never widens what the
 * chat was allowed to do without asking: only unattended maps to unattended, and a stricter
 * source never lands in a more permissive mode than the next rung.
 */
const NEAREST: Record<PermissionClass, readonly PermissionClass[]> = {
  plan: ["plan"],
  ask: ["ask", "edits"],
  edits: ["edits", "ask"],
  review: ["review", "edits"],
  unattended: ["unattended"],
};

function classOf(mode: AgentProviderModeDefinition): PermissionClass | undefined {
  return mode.isUnattended ? "unattended" : mode.permissionClass;
}

type CarriedMode = Pick<AgentProviderSwitchTarget, "modeId" | "featureValues"> & {
  permissionMode?: NonNullable<AgentProviderSwitchMarker["permissionMode"]>;
};

/**
 * The mode a chat keeps when it moves to `target` because of a limit. An auto-approve chat that
 * landed in the target's default would stop at the first permission prompt and an unattended run
 * would sit there, so the mode follows the chat to the closest equivalent. With no equivalent the
 * target's default applies and the result says so for the timeline marker.
 */
export async function resolveCarriedPermissionMode(input: {
  providerSnapshotManager: Pick<
    ProviderSnapshotManager,
    "getModeDefinitions" | "isAgentUnattended" | "resolveCreateConfig"
  >;
  agent: ManagedAgent;
  targetProvider: AgentProvider;
  target: AgentProviderSwitchTarget;
}): Promise<CarriedMode> {
  const { providerSnapshotManager, agent, targetProvider, target } = input;
  const sourceModes = providerSnapshotManager.getModeDefinitions(agent.provider);
  const sourceMode = sourceModes.find((mode) => mode.id === agent.currentModeId);
  const targetModes = providerSnapshotManager.getModeDefinitions(targetProvider);
  const sourceLabel = sourceMode?.label ?? agent.currentModeId ?? undefined;
  const reset = (): CarriedMode => ({
    modeId: target.modeId,
    featureValues: target.featureValues,
    ...(sourceLabel ? { permissionMode: { carried: false, label: sourceLabel } } : {}),
  });

  // Unattended can live in a provider feature (OpenCode's auto-accept) as well as in a mode, and
  // the create path already reads both off the parent agent and maps them onto the target.
  if (providerSnapshotManager.isAgentUnattended(agent)) {
    const inherited = await providerSnapshotManager.resolveCreateConfig({
      cwd: agent.cwd,
      provider: targetProvider,
      requestedMode: undefined,
      featureValues: undefined,
      parent: agent,
      unattended: false,
    });
    const carried =
      inherited.modeId !== target.modeId ||
      JSON.stringify(inherited.featureValues ?? null) !==
        JSON.stringify(target.featureValues ?? null);
    if (!carried) return reset();
    const label = targetModes.find((mode) => mode.id === inherited.modeId)?.label;
    return {
      modeId: inherited.modeId,
      featureValues: inherited.featureValues,
      permissionMode: { carried: true, ...(label ? { label } : {}) },
    };
  }

  // A chat with no mode set started in the provider's default, so the target's default matches.
  if (agent.currentModeId == null) {
    return { modeId: target.modeId, featureValues: target.featureValues };
  }
  const sourceClass = sourceMode ? classOf(sourceMode) : undefined;
  if (!sourceClass) return reset();
  for (const wanted of NEAREST[sourceClass]) {
    const match = targetModes.find((mode) => classOf(mode) === wanted);
    if (match) {
      return {
        modeId: match.id,
        featureValues: target.featureValues,
        permissionMode: { carried: true, label: match.label },
      };
    }
  }
  return reset();
}
