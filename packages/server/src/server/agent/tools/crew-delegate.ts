// Crew mode's `delegate` tool: a structured brief from the chat's own model, the lead, to one of
// the Crew tier profiles. A chat has it while its `crew` flag is on.
// It is a thin layer over create_agent (and create_chat for worktrees), so the child is an
// ordinary subagent: parent label, inherited context, and a finish notification to the lead.
import { z } from "zod";
import {
  CREW_ROLE_LABEL,
  CREW_TIER_PROFILE_IDS,
  CREW_ROLES,
  PARENT_AGENT_ID_LABEL,
  type CrewRole,
} from "@pimi/protocol/agent-labels";
import type { AgentProfile } from "@pimi/protocol/agent-profile";
import { renderTemplate } from "../../prompts/render.js";
import {
  PimiToolInputError,
  type PimiToolConfig,
  type PimiToolExecutionContext,
  type PimiToolResult,
} from "./types.js";

/** What a chat in Crew mode is told, appended to its instructions when its session opens. */
export const CREW_LEAD_INSTRUCTIONS = renderTemplate("crew-lead", {});

const CREW_OFF_NOTE =
  "Crew mode is now off for this chat. You no longer lead a crew: the `delegate` tool is gone and the crew lead instructions no longer apply. Do the work yourself.";

/**
 * What a chat's next turn must tell its provider after Crew mode changed, or null when the
 * session already knows. `crewTold` records that the lead instructions reached the session, in
 * its system prompt at creation or in an earlier note.
 */
export function crewChangeNote(config: { crew?: boolean; crewTold?: boolean }): string | null {
  const crew = config.crew === true;
  if (crew === (config.crewTold === true)) return null;
  return `<pimi-crew-mode>\n${crew ? CREW_LEAD_INSTRUCTIONS : CREW_OFF_NOTE}\n</pimi-crew-mode>`;
}

/** Live crew children one lead may have at once. */
export const CREW_MAX_LIVE_CHILDREN = 4;

const NO_EDITS_SUFFIX =
  "This is analysis only. Do NOT edit, create, or delete any files. Do NOT write code. Return a plan or a review.";

const DelegateInput = z.strictObject({
  role: z
    .enum(CREW_ROLES)
    .describe(
      "thinker: hard design, planning or review, no edits. worker: implements a well-specified change. chore: mechanical job with no judgment.",
    ),
  goal: z.string().trim().min(1).max(200).describe("One line: what the child must achieve."),
  context: z
    .string()
    .trim()
    .min(1)
    .describe(
      "What the child needs that the attached chat history may not give it: decisions made, constraints found, what you tried.",
    ),
  files: z.array(z.string().min(1)).describe("Paths the child should read or change."),
  doneWhen: z
    .string()
    .trim()
    .min(1)
    .describe("What you will check to accept the result. A checkable condition."),
  constraints: z.string().trim().min(1).optional().describe("Limits: do not touch, style, scope."),
  worktree: z
    .boolean()
    .optional()
    .describe(
      "Worker and chore only: run in a fresh git worktree of this project. It starts from the last commit, so commit or describe your uncommitted changes in context first.",
    ),
});
type DelegateArgs = z.infer<typeof DelegateInput>;

interface CallerAgent {
  provider: string;
  config: { model?: string | null; crew?: boolean };
  runtimeInfo?: { model?: string | null } | null;
}

interface CrewChild {
  lifecycle: string;
  labels: Record<string, string>;
}

export interface RegisterDelegateToolOptions {
  registerTool: (
    name: string,
    config: PimiToolConfig,
    handler: (input: DelegateArgs, context: PimiToolExecutionContext) => Promise<PimiToolResult>,
  ) => void;
  callerAgentId: string | undefined;
  /** The caller's session leads a crew; unset means read the caller agent's config. */
  crew?: boolean;
  getCallerAgent: () => CallerAgent | null;
  listAgents: () => CrewChild[];
  findProfile: (id: string) => AgentProfile | undefined;
  /** Model ids the provider offers on this host, or null when the provider is unusable. */
  listProviderModels: (provider: string) => Promise<readonly string[] | null>;
  callTool: (
    name: string,
    input: unknown,
    context: PimiToolExecutionContext,
  ) => Promise<PimiToolResult>;
}

export function registerDelegateTool(options: RegisterDelegateToolOptions): void {
  const { callerAgentId } = options;
  // A session opening for an agent not registered yet, or the shared manifest, passes `crew`;
  // a live caller is read.
  const crew = options.crew ?? options.getCallerAgent()?.config.crew === true;
  if (!crew) return;
  options.registerTool(
    "delegate",
    {
      title: "Delegate",
      description:
        "Hand work to a Crew tier. thinker: hard design, planning or review (no edits). worker: a well-specified implementation. chore: a mechanical job. The child gets this chat as reference and your brief, runs as your subagent, and you are notified with its final message when it finishes; do not poll. Returns at once with its id. At most 4 children run at once.",
      inputSchema: DelegateInput,
      outputSchema: {
        agentId: z.string(),
        role: z.enum(CREW_ROLES),
        provider: z.string(),
        model: z.string().optional(),
        chatId: z.string().optional(),
        note: z.string().optional(),
      },
    },
    async (args, context) => {
      if (!callerAgentId) throw new PimiToolInputError("Only a crew lead can delegate.");
      const live = options
        .listAgents()
        .filter(
          (agent) =>
            agent.labels[PARENT_AGENT_ID_LABEL] === callerAgentId &&
            agent.labels[CREW_ROLE_LABEL] !== undefined &&
            (agent.lifecycle === "initializing" || agent.lifecycle === "running"),
        ).length;
      if (live >= CREW_MAX_LIVE_CHILDREN) {
        throw new PimiToolInputError(
          `${live} crew children are already running; the limit is ${CREW_MAX_LIVE_CHILDREN}. Wait for one to finish, or do this yourself.`,
        );
      }
      if (args.role === "thinker" && args.worktree) {
        throw new PimiToolInputError("A thinker makes no edits, so it needs no worktree.");
      }
      const tier = await resolveTier(options, args.role);
      let chatId: string | undefined;
      if (args.worktree) {
        const chat = await options.callTool(
          "create_chat",
          { isolation: "worktree", title: args.goal.slice(0, 60) },
          context,
        );
        chatId = (chat.structuredContent as { chatId?: string } | undefined)?.chatId;
        if (!chatId) throw new Error("Worktree chat was created without a chat id");
      }
      const created = await options.callTool(
        "create_agent",
        {
          title: args.goal.slice(0, 60),
          profile: tier.profileId,
          ...(tier.provider ? { provider: tier.provider } : {}),
          initialPrompt: renderBrief(args),
          inheritContext: true,
          notifyOnFinish: true,
          labels: { [CREW_ROLE_LABEL]: args.role },
          ...(chatId ? { chatId } : {}),
        },
        context,
      );
      if (created.isError) return created;
      const child = created.structuredContent as { agentId: string; type: string };
      const result = {
        agentId: child.agentId,
        role: args.role,
        provider: child.type,
        ...(tier.model ? { model: tier.model } : {}),
        ...(chatId ? { chatId } : {}),
        ...(tier.note ? { note: tier.note } : {}),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );
}

interface ResolvedTier {
  profileId: string;
  /** Set only when the tier falls back to the lead's own model. */
  provider?: string;
  /** The model the child runs on, for the lead to name; absent when the provider picks it. */
  model?: string;
  note?: string;
}

async function resolveTier(
  options: RegisterDelegateToolOptions,
  role: CrewRole,
): Promise<ResolvedTier> {
  const profile = options.findProfile(CREW_TIER_PROFILE_IDS[role]);
  if (!profile) {
    throw new PimiToolInputError(
      `The Crew ${role} profile was deleted. Restore it in Library > Profiles, or do this yourself.`,
    );
  }
  const sameAsLead = profile.provider === undefined;
  const models = profile.provider ? await options.listProviderModels(profile.provider) : null;
  const usable =
    !sameAsLead &&
    models !== null &&
    (profile.model === undefined ? models.length > 0 : models.includes(profile.model));
  if (usable) return { profileId: profile.id, model: profile.model };
  const lead = options.getCallerAgent();
  if (!lead) throw new PimiToolInputError("Crew lead is not running");
  const leadModel = lead.config.model ?? lead.runtimeInfo?.model;
  const own = leadModel ? `${lead.provider}/${leadModel}` : lead.provider;
  // No provider on the tier profile is the user's choice of "same as lead", not a failure.
  if (sameAsLead) return { profileId: profile.id, provider: own, model: leadModel ?? undefined };
  const wanted = `${profile.provider}${profile.model ? `/${profile.model}` : ""}`;
  return {
    profileId: profile.id,
    provider: own,
    model: leadModel ?? undefined,
    note: `The Crew ${role} tier (${wanted}) is unavailable on this host, so it runs on your own model (${own}).`,
  };
}

function renderBrief(args: DelegateArgs): string {
  const sections = [
    `# Goal\n${args.goal}`,
    `# Context\n${args.context}`,
    `# Files\n${args.files.length > 0 ? args.files.map((file) => `- ${file}`).join("\n") : "None named."}`,
    `# Done when\n${args.doneWhen}`,
    ...(args.constraints ? [`# Constraints\n${args.constraints}`] : []),
    ...(args.role === "thinker" ? [NO_EDITS_SUFFIX] : []),
  ];
  return sections.join("\n\n");
}
