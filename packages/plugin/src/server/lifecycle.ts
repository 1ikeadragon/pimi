import type { AgentToolDefinition } from "./agent-tools.js";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentTimelineItem,
  AgentSessionConfig,
} from "@pimi/protocol/agent-types";
import type { PimiApi } from "@pimi/client";
import type { WorkspaceCreateRequest } from "@pimi/protocol/messages";

export interface PluginHookContext {
  pimi: PimiApi;
  signal: AbortSignal;
}

export interface PluginHookWorkspace {
  id: string;
  projectId: string;
  cwd: string;
  name: string | null;
  archivedAt: string | null;
}

export interface PluginHookWorktree {
  path: string;
  branch: string;
  sourceCheckout: string;
}

/** Resolved creation options before Git fetches refs or chooses a unique branch name. */
export type PluginWorktreeCreateRequest = {
  readonly repoRoot: string;
  readonly sourceCheckout: string;
  branch: string;
  slug: string;
  path: string;
} & (
  | { kind: "branch-off"; baseRef: string }
  | { kind: "checkout-branch" }
  | {
      kind: "checkout-change-request";
      baseRef: string;
      forge: string;
      changeRequestNumber: number;
      headRef: string;
      headRepositoryOwner?: string;
      headRepository?: string;
      checkoutRefs?: { remoteName?: string; remoteRef: string }[];
      pushRemoteUrl?: string;
      trackOriginHead?: boolean;
    }
);

export interface PluginHookAgent {
  id: string;
  workspaceId: string | null;
  parentAgentId: string | null;
  provider: string;
  cwd: string;
  title: string | null;
}

export interface PluginSessionOpenRequest {
  agentId: string;
  workspaceId: string | null;
  provider: string;
  cwd: string;
  reason: "create" | "resume" | "refresh" | "import";
  purpose: "interactive" | "history";
  readonly title: string | null;
  readonly labels: Readonly<Record<string, string>>;
  tools: AgentToolDefinition[];
  env: Record<string, string>;
  mcpServers: NonNullable<AgentSessionConfig["mcpServers"]>;
}

export type PluginTurnOutcome =
  | { kind: "completed" }
  | { kind: "failed"; error: { message: string; code?: string } }
  | { kind: "canceled"; reason: string };

export interface PluginHookEvents {
  "agent.turn.before": { agent: PluginHookAgent; turnId: string | null };
  "agent.turn.after": {
    agent: PluginHookAgent;
    turnId: string | null;
    outcome: PluginTurnOutcome;
    /**
     * @deprecated Always empty. Fetch history on demand with
     * context.pimi.agents.ref(agent.id).timeline.refetch({ direction: "tail", limit: 20 }).
     */
    timeline: readonly AgentTimelineItem[];
  };
  "agent.permission.before": { agent: PluginHookAgent; request: AgentPermissionRequest };
  "agent.permission.after": {
    agent: PluginHookAgent;
    requestId: string;
    resolution: AgentPermissionResponse;
  };
  "agent.archive.after": { agent: PluginHookAgent; archivedAt: string };
  "agent.create.after": { agent: PluginHookAgent };
  "agent.close.after": { agent: PluginHookAgent };
  "workspace.create.after": { workspace: PluginHookWorkspace };
  "workspace.archive.after": { workspace: PluginHookWorkspace };
}

export interface PluginHookRequests {
  "worktree.create.before": PluginWorktreeCreateRequest;
  "agent.create.before": { config: AgentSessionConfig; env?: Record<string, string> };
  "agent.open.before": PluginSessionOpenRequest;
  "workspace.create.before": Omit<WorkspaceCreateRequest, "type" | "requestId">;
}

export type PluginHooks = {
  [Name in keyof PluginHookRequests]: {
    request: PluginHookRequests[Name];
    result: PluginHookRequests[Name];
  };
} & { [Name in keyof PluginHookEvents]: { payload: PluginHookEvents[Name] } } & {
  "worktree.create.after": { payload: { worktree: PluginHookWorktree } };
};

export type PluginHookPayload<Name extends keyof PluginHooks> = {
  [Key in keyof PluginHooks]: PluginHooks[Key] extends { request: infer Request }
    ? { request: Request }
    : PluginHooks[Key] extends { payload: infer Payload }
      ? Payload
      : never;
}[Name];
export type PluginHookResult<Name extends keyof PluginHooks> = {
  [Key in keyof PluginHooks]: PluginHooks[Key] extends { result: infer Result }
    ? Result | void
    : void;
}[Name];

type HookHandlers = {
  [Name in keyof PluginHooks]: (
    payload: PluginHookPayload<Name>,
    context: PluginHookContext,
  ) => Promise<PluginHookResult<Name>>;
};

export interface PluginLifecycleRegistration {
  addHook<Name extends keyof PluginHooks>(name: Name, handler: HookHandlers[Name]): () => void;
}

/** @internal Lifecycle policy shared by the daemon and plugin process. */
export const pluginHookRegistry = {
  "workspace.create.before": { waits: true },
  "workspace.create.after": { waits: false },
  "workspace.archive.after": { waits: false },
  "worktree.create.before": { waits: true },
  "worktree.create.after": { waits: true },
  "agent.create.before": { waits: true },
  "agent.create.after": { waits: false },
  "agent.open.before": { waits: true },
  "agent.close.after": { waits: false },
  "agent.archive.after": { waits: false },
  "agent.turn.before": { waits: false },
  "agent.turn.after": { waits: false },
  "agent.permission.before": { waits: false },
  "agent.permission.after": { waits: false },
} as const satisfies Record<keyof PluginHooks, { waits: boolean }>;

/** @internal SDK adapter for the daemon's hook registry. */
export function createLifecycleRegistration(
  register: (
    name: keyof PluginHooks,
    handler: (input: never, context: PluginHookContext) => unknown,
  ) => () => void,
): PluginLifecycleRegistration {
  const names = new Set<string>(Object.keys(pluginHookRegistry));
  return {
    addHook(name, handler) {
      if (!names.has(name)) throw new Error(`Unknown lifecycle hook: ${name}`);
      return register(name, handler);
    },
  };
}
