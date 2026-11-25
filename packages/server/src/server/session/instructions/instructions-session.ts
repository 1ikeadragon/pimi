import { homedir } from "node:os";
import { resolve } from "node:path";
import type pino from "pino";
import type { AgentProfile } from "@pimi/protocol/agent-profile";
import type { InstructionLayer, InstructionsResult } from "@pimi/protocol/messages";
import { getErrorMessage } from "@pimi/protocol/error-utils";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { AgentStorage } from "../../agent/agent-storage.js";
import type { AgentSessionConfig } from "../../agent/agent-sdk-types.js";
import type { ProviderSnapshotManager } from "../../agent/provider-snapshot-manager.js";
import { nodeInstructionFs } from "../../agent/instructions/fs.js";
import { pimiInstructionLayers } from "../../agent/instructions/pimi-layers.js";
import {
  resolveProviderInstructions,
  type ResolveProviderInstructionsInput,
} from "../../agent/instructions/resolve.js";
import {
  resolveExternalOpenCodeServer,
  type ExternalOpenCodeServer,
} from "../../agent/providers/opencode/v2/external-server.js";
import { selectOpenCodeService } from "../../agent/providers/opencode/v2/service-selection.js";
import { resolveProjectConfigRoot } from "../../../utils/pimi-config-file.js";
import type { ProjectRegistry, WorkspaceRegistry } from "../../workspace-registry.js";

export interface InstructionsSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

export interface InstructionsSessionOptions {
  host: InstructionsSessionHost;
  agentManager: Pick<AgentManager, "getAgent" | "describePimiInstructions">;
  agentStorage: Pick<AgentStorage, "get">;
  providerSnapshotManager: Pick<
    ProviderSnapshotManager,
    "listProviderAccountScopes" | "getHarnessInstallation"
  >;
  projectRegistry: Pick<ProjectRegistry, "list">;
  workspaceRegistry: Pick<WorkspaceRegistry, "listActive">;
  getAgentProfiles: () => readonly AgentProfile[];
  logger: pino.Logger;
}

type Target = Extract<
  SessionInboundMessage,
  { type: "provider.instructions.list.request" }
>["target"];

/** What the target pins down before any file is read. */
interface ResolvedTarget {
  provider: string;
  cwd: string;
  /** Launch overrides the agent was created with, merged over the provider's environment. */
  launchEnv: Record<string, string>;
  agentMode: string | null;
  config: AgentSessionConfig;
  systemPrompt: string | null;
  profileName: string | null;
}

function currentMode(agent: { currentModeId: string | null; config: AgentSessionConfig }) {
  return agent.currentModeId ?? agent.config.modeId ?? null;
}

function storedMode(record: Awaited<ReturnType<AgentStorage["get"]>> | null) {
  return record?.lastModeId ?? record?.config?.modeId ?? null;
}

class InstructionsTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstructionsTargetError";
  }
}

/**
 * A client's read-only view of what reaches an agent as instructions: the provider's own files
 * and Pimi's added prompts. Reads only the paths the provider rule tables produce from a
 * working directory the daemon already knows, never a client-supplied path.
 */
export class InstructionsSession {
  private readonly options: InstructionsSessionOptions;

  constructor(options: InstructionsSessionOptions) {
    this.options = options;
  }

  async handleListRequest(
    msg: Extract<SessionInboundMessage, { type: "provider.instructions.list.request" }>,
  ): Promise<void> {
    const { host, logger } = this.options;
    try {
      const result = await this.resolve(msg.target);
      host.emit({
        type: "provider.instructions.list.response",
        payload: { requestId: msg.requestId, error: null, result },
      });
    } catch (error) {
      const known = error instanceof InstructionsTargetError;
      if (!known) {
        logger.warn({ err: error, target: msg.target }, "Failed to resolve instruction layers");
      }
      host.emit({
        type: "provider.instructions.list.response",
        payload: { requestId: msg.requestId, error: getErrorMessage(error), result: null },
      });
    }
  }

  private async resolve(target: Target): Promise<InstructionsResult> {
    const resolved = await this.resolveTarget(target);
    const scopes = this.options.providerSnapshotManager.listProviderAccountScopes();
    const scope = scopes.find((candidate) => candidate.provider === resolved.provider);
    if (!scope) {
      throw new InstructionsTargetError(`Provider ${resolved.provider} is not configured`);
    }
    const env = { ...scope.env, ...resolved.launchEnv };
    const installation = await this.options.providerSnapshotManager.getHarnessInstallation(
      resolved.provider,
    );

    let openCode: ResolveProviderInstructionsInput["openCode"] = null;
    if (scope.baseProvider === "opencode") {
      openCode = await this.openCodeRuntime(env, installation?.version ?? null);
    }

    const provider = await resolveProviderInstructions({
      fs: nodeInstructionFs,
      homeDir: homedir(),
      platform: process.platform,
      baseProvider: scope.baseProvider,
      cwd: resolved.cwd,
      env,
      openCode,
      agentMode: resolved.agentMode,
    });
    const pimi = await this.options.agentManager.describePimiInstructions(resolved.config);
    const layers: InstructionLayer[] = [
      ...provider.layers,
      ...pimiInstructionLayers({
        systemPrompt: resolved.systemPrompt,
        profileName: resolved.profileName,
        hostPrompt: pimi.hostPrompt,
        parts: pimi.parts,
      }),
    ];
    return {
      provider: resolved.provider,
      baseProvider: scope.baseProvider,
      cwd: resolved.cwd,
      ruleset: provider.ruleset,
      providerVersion: installation?.version ?? null,
      truncated: provider.truncated,
      layers,
      notices: provider.notices,
    };
  }

  private resolveTarget(target: Target): Promise<ResolvedTarget> {
    return target.kind === "agent" ? this.agentTarget(target.agentId) : this.draftTarget(target);
  }

  private async agentTarget(agentId: string): Promise<ResolvedTarget> {
    const live = this.options.agentManager.getAgent(agentId);
    const stored = live ? null : await this.options.agentStorage.get(agentId);
    const agent = live ?? stored;
    if (!agent) throw new InstructionsTargetError(`Unknown agent ${agentId}`);
    const systemPrompt = agent.config?.systemPrompt ?? null;
    const config: AgentSessionConfig = {
      provider: agent.provider,
      cwd: agent.cwd,
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(agent.config?.crew ? { crew: true } : {}),
    };
    const mode = live ? currentMode(live) : storedMode(stored);
    return {
      provider: agent.provider,
      cwd: resolve(agent.cwd),
      launchEnv: agent.launchEnv ?? {},
      agentMode: mode,
      config,
      systemPrompt,
      profileName: agent.config?.profile?.name ?? null,
    };
  }

  private async draftTarget(target: Extract<Target, { kind: "draft" }>): Promise<ResolvedTarget> {
    const cwd = await this.knownWorkspaceRoot(target.cwd);
    if (!cwd) throw new InstructionsTargetError("Unknown workspace directory");
    let profile: AgentProfile | null = null;
    if (target.profileId !== null) {
      profile =
        this.options.getAgentProfiles().find((entry) => entry.id === target.profileId) ?? null;
      if (!profile) throw new InstructionsTargetError(`Unknown agent profile ${target.profileId}`);
    }
    const instructions = profile?.instructions?.trim() ?? "";
    return {
      provider: target.provider,
      cwd,
      launchEnv: {},
      agentMode: null,
      config: {
        provider: target.provider,
        cwd,
        ...(instructions ? { systemPrompt: instructions } : {}),
      },
      systemPrompt: instructions || null,
      profileName: profile?.name ?? null,
    };
  }

  /** The directory when it is a known project root or workspace, resolved through symlinks. */
  private async knownWorkspaceRoot(requested: string): Promise<string | null> {
    const [projects, workspaces] = await Promise.all([
      this.options.projectRegistry.list(),
      this.options.workspaceRegistry.listActive(),
    ]);
    const roots = new Set<string>([
      ...projects.filter((project) => project.archivedAt === null).map((p) => resolve(p.rootPath)),
      ...workspaces.map((workspace) => resolve(workspace.cwd)),
    ]);
    return resolveProjectConfigRoot(resolve(requested), roots);
  }

  private async openCodeRuntime(
    env: Record<string, string>,
    version: string | null,
  ): Promise<ResolveProviderInstructionsInput["openCode"]> {
    const explicit: ExternalOpenCodeServer | undefined = resolveExternalOpenCodeServer(env);
    const selection = await selectOpenCodeService({ explicit, env });
    // A server Pimi did not start is OpenCode 2.x; its own home decides its global files.
    if (selection.kind !== "owned") return { major: 2, externalServer: true };
    if (version?.startsWith("1.")) return { major: 1, externalServer: false };
    if (version?.startsWith("2.")) return { major: 2, externalServer: false };
    return null;
  }
}
