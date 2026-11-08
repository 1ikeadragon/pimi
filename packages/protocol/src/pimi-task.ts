// Pimi addition to the Paseo fork. Apache-2.0.
import { z } from "zod";
import { getPaseoToolLeafName } from "./tool-name-normalization.js";
import { WORKSPACE_LABEL_COLORS } from "./workspace-labels.js";

export const PimiTaskLabels = z.array(z.string().min(1));
export const PimiTaskMode = z.enum(["chat", "worktree"]);
export const PimiStoredTaskMode = z.enum(["chat", "worktree", "research", "code"]);
export const PIMI_TASK_WORKER_LABEL = "pimi.task-id";

export const PimiTaskFields = z.object({
  title: z.string().trim().min(1).max(100),
  brief: z.string().trim().min(1).max(2400),
  mode: PimiTaskMode.optional().describe(
    "Use chat for general work in separate folders. Choose worktree when workers should edit an attached Git repository.",
  ),
  labels: PimiTaskLabels.optional().describe(
    "Existing Pimi label names from list_pimi_labels. Replaces task labels; [] removes all.",
  ),
});

export const PimiExperimentFields = z.object({
  title: z.string().trim().min(1).max(55),
  hypothesis: z.string().trim().min(1).max(1600),
});

export const PimiTaskProposalInput = PimiTaskFields.extend({
  experiments: z.array(PimiExperimentFields).max(4).optional(),
});

export const PimiTaskSource = z.object({
  serverId: z.string().trim().min(1).max(256),
  agentId: z.string().trim().min(1).max(256),
});

export const PimiTaskProposal = PimiTaskProposalInput.extend({
  mode: PimiStoredTaskMode.transform((mode) => {
    if (mode === "research") return "chat";
    if (mode === "code") return "worktree";
    return mode;
  }).optional(),
  id: z.uuid(),
  source: PimiTaskSource,
});

export type PimiTaskProposal = z.infer<typeof PimiTaskProposal>;

export const PimiTaskStage = z.enum(["backlog", "ready", "in-progress", "review", "done"]);
export const PIMI_TASK_AGENT_SOCKET_FILE = "pimi-task-socket";
export const PIMI_TASK_PIPE_PREFIX = "\\\\.\\pipe\\pimi-tasks-";
export const PimiTaskPipeDescriptor = z.strictObject({
  socketPath: z
    .string()
    .startsWith(PIMI_TASK_PIPE_PREFIX)
    .refine((value) => z.uuid().safeParse(value.slice(PIMI_TASK_PIPE_PREFIX.length)).success),
  secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export const PimiTaskAgentTool = {
  create: "create_pimi_task",
  list: "list_pimi_tasks",
  get: "get_pimi_task",
  repositories: "list_pimi_repositories",
  update: "update_pimi_task",
  linkWork: "link_pimi_task_work",
  labels: "list_pimi_labels",
  labelWork: "set_pimi_work_label",
  createLabel: "create_pimi_label",
} as const;
export const PimiTaskAgentListInput = z.strictObject({
  query: z.string().trim().max(100).optional().describe("Search task titles and briefs."),
  offset: z.number().int().nonnegative().optional().describe("Use nextOffset from the prior page."),
});
export const PimiTaskAgentGetInput = z.strictObject({
  id: z.uuid().describe("Saved task ID."),
});

export const PIMI_MOBILE_TASK_SOCKET_OPERATION = "mobile_tasks";
export const PIMI_TASK_PAGE_SIZE = 50;
// A title and brief may each require up to six JSON characters per input character.
export const PIMI_MOBILE_TASK_REQUEST_LIMIT = 16 * 1024;
export const PimiMobileTaskOperation = z.discriminatedUnion("action", [
  PimiTaskAgentListInput.extend({ action: z.literal("list") }),
  PimiTaskAgentGetInput.extend({ action: z.literal("get") }),
  z.strictObject({
    action: z.literal("create"),
    ...PimiTaskAgentGetInput.shape,
    title: PimiTaskFields.shape.title,
    brief: PimiTaskFields.shape.brief,
  }),
  PimiTaskAgentGetInput.extend({ action: z.literal("set-stage"), stage: PimiTaskStage.nullable() }),
]);
export type PimiMobileTaskOperation = z.infer<typeof PimiMobileTaskOperation>;

const PimiMobileTaskSummary = z.object({
  ...PimiTaskAgentGetInput.shape,
  title: PimiTaskFields.shape.title,
  stage: PimiTaskStage.nullable(),
});
const PimiMobileTaskDetail = PimiMobileTaskSummary.extend({ brief: PimiTaskFields.shape.brief });
export type PimiMobileTaskDetail = z.infer<typeof PimiMobileTaskDetail>;
export const PimiMobileTaskResult = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("page"),
    tasks: z.array(PimiMobileTaskSummary).max(PIMI_TASK_PAGE_SIZE),
    nextOffset: z.number().int().nonnegative().nullable(),
  }),
  z.object({ kind: z.literal("task"), task: PimiMobileTaskDetail }),
]);
export type PimiMobileTaskResult = z.infer<typeof PimiMobileTaskResult>;

const PimiTaskRepositoryPath = z
  .string()
  .min(1)
  .max(4096)
  .describe("Repository path returned by list_pimi_repositories.");
export const PimiTaskAgentCreateInput = PimiTaskFields.omit({ mode: true })
  .extend({
    labels: PimiTaskLabels.optional().describe("Existing Pimi label names from list_pimi_labels."),
    repository: PimiTaskRepositoryPath.optional(),
    stage: PimiTaskStage.optional().describe(
      "Set when the request specifies a stage. Defaults to To do.",
    ),
  })
  .strict();
export const PimiTaskCreatedResult = z.object({
  task: z.object({ id: PimiTaskAgentGetInput.shape.id, title: PimiTaskFields.shape.title }),
  created: z.boolean(),
  source: PimiTaskSource,
});
export type PimiTaskCreatedResult = z.infer<typeof PimiTaskCreatedResult>;

export const PimiTaskAgentUpdateInput = PimiTaskFields.partial()
  .extend({
    ...PimiTaskAgentGetInput.shape,
    stage: PimiTaskStage.nullable()
      .optional()
      .describe("Use null to return to automatic progress."),
    repository: PimiTaskRepositoryPath.optional(),
  })
  .strict();
export const PimiWorkLabelInput = z.strictObject({
  workspaceId: z.string().min(1).describe("Workspace ID from list_pimi_labels workspaces."),
  name: z.string().min(1).describe("Existing Pimi label name."),
  assigned: z.boolean().describe("True to attach, false to remove."),
});
export const PimiWorkLabelCreateInput = z.strictObject({
  workspaceId: z.string().min(1).describe("Workspace ID from list_pimi_labels workspaces."),
  name: z.string().trim().min(1).describe("Name for the new shared Pimi label."),
  color: z.enum(WORKSPACE_LABEL_COLORS).describe("Color for the new label."),
});

export const PimiTaskAgentLinkWorkInput = z.strictObject({
  ...PimiTaskAgentGetInput.shape,
  ...PimiExperimentFields.shape,
  path: z.string().min(1).max(4096).describe("Exact path of an existing worktree shown in Work."),
});

export const PimiMemoryDestination = z.object({
  view: z.literal("memory"),
  projectId: z.string().min(1).max(4096).optional(),
});
export const PimiNewTaskDestination = PimiTaskFields.pick({
  title: true,
  brief: true,
})
  .partial()
  .extend({ view: z.literal("new-task") });
export const PimiOpenTaskDestination = PimiTaskAgentGetInput.extend({ view: z.literal("task") });
export const PimiSimpleDestinationView = z.enum(["tasks", "worktrees", "review-home", "spaces"]);
export const PimiReviewPrDestination = z.object({
  view: z.literal("review-pr"),
  url: z
    .string()
    .max(512)
    .regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*\/?$/),
});
export type PimiDestination =
  | { view: z.infer<typeof PimiSimpleDestinationView> }
  | z.infer<typeof PimiMemoryDestination>
  | z.infer<typeof PimiNewTaskDestination>
  | z.infer<typeof PimiOpenTaskDestination>
  | z.infer<typeof PimiReviewPrDestination>
  | { view: "review"; path: string; serverId?: string }
  | { view: "task-draft"; proposal: PimiTaskProposal };

export type PimiWorkspaceSection = "tasks" | "board" | "review" | "memory" | "spaces";

export const PIMI_SPACES_ROUTE = "/api/pimi/spaces";
export const PIMI_SPACE_IMAGE_BYTES = 4 * 1024 * 1024;
// The request includes base64 encoding and its JSON envelope.
export const PIMI_SPACE_REQUEST_BYTES = 6 * 1024 * 1024;

export const PIMI_VIDEO_EMBED_ORIGIN = "https://www.youtube-nocookie.com";
export const PIMI_X_EMBED_PAGE = "https://platform.twitter.com/embed/Tweet.html";
export const PIMI_ARXIV_EMBED_ORIGIN = "https://arxiv.org";
const youtubeVideoId = /^[A-Za-z0-9_-]{11}$/;
const xStatusId = /^[1-9]\d{0,19}$/;
const arxivPaperId =
  /^(?:\d{2}(?:0[1-9]|1[0-2])\.\d{4,5}|[a-z][a-z-]*(?:\.[A-Z]{2})?\/\d{2}(?:0[1-9]|1[0-2])\d{3})(?:v[1-9]\d*)?$/;

export function parsePimiSpaceUrl(input: unknown): URL | null {
  if (typeof input !== "string" || input.length > 4096 || !/^https?:\/\/[^\s\\]+$/i.test(input))
    return null;
  const url = URL.parse(input);
  if (
    !url ||
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.href.length > 4096
  )
    return null;
  return url;
}

export function pimiVideoEmbed(url: URL): string | null {
  if (url.protocol !== "https:" || url.port) return null;
  const [, route, id] = url.pathname.split("/");
  let videoId: string | null | undefined;
  switch (url.hostname) {
    case "youtu.be":
      videoId = route;
      break;
    case "youtube.com":
    case "www.youtube.com":
    case "m.youtube.com":
      if (route === "watch") videoId = url.searchParams.get("v");
      else if (["shorts", "live", "embed"].includes(route)) videoId = id;
      break;
    case "www.youtube-nocookie.com":
      videoId = route === "embed" ? id : null;
      break;
  }
  return videoId && youtubeVideoId.test(videoId)
    ? `${PIMI_VIDEO_EMBED_ORIGIN}/embed/${videoId}`
    : null;
}

export function isPimiVideoEmbed(url: URL): boolean {
  return url.origin === PIMI_VIDEO_EMBED_ORIGIN && pimiVideoEmbed(url) === url.href;
}

function xEmbedUrl(id: string | null): string | null {
  return id && xStatusId.test(id) ? `${PIMI_X_EMBED_PAGE}?id=${id}&dnt=true` : null;
}

function pimiArxivEmbed(url: URL): string | null {
  if (url.origin !== PIMI_ARXIV_EMBED_ORIGIN || url.username || url.password) return null;
  const route = /^\/(abs|pdf|html)\/(.+)$/.exec(url.pathname);
  if (!route) return null;
  const id = route[1] === "pdf" ? route[2].replace(/\.pdf$/, "") : route[2];
  return arxivPaperId.test(id) ? `${PIMI_ARXIV_EMBED_ORIGIN}/html/${id}` : null;
}

export function isPimiArxivEmbed(url: URL): boolean {
  return pimiArxivEmbed(url) === url.href;
}

export function pimiSpaceEmbed(url: URL): string | null {
  if (url.protocol !== "https:" || url.port || url.username || url.password) return null;
  if (
    ["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"].includes(
      url.hostname,
    )
  ) {
    const status = /^\/(?:[A-Za-z0-9_]{1,15}\/status|i\/web\/status)\/(\d+)\/?$/.exec(url.pathname);
    return xEmbedUrl(status?.[1] ?? null);
  }
  return pimiArxivEmbed(url) ?? pimiVideoEmbed(url);
}

export function isPimiXEmbed(url: URL): boolean {
  return xEmbedUrl(url.searchParams.get("id")) === url.href;
}

export function isPimiSpaceEmbed(url: URL): boolean {
  return isPimiVideoEmbed(url) || isPimiXEmbed(url) || isPimiArxivEmbed(url);
}

export interface PimiVoiceBubbleState {
  visible: boolean;
  active: boolean;
  status: string;
  level: number;
}

export const PimiReportLinkRequest = z.strictObject({
  taskId: z.uuid(),
  reportId: z.uuid(),
  href: z.string().trim().min(1).max(8192),
});
export type PimiReportLinkRequest = z.infer<typeof PimiReportLinkRequest>;
export const PimiReportLinkTarget = PimiReportLinkRequest.extend({
  serverId: z.string().min(1).max(256).optional(),
  workspaceId: z.string().min(1).max(256).optional(),
});
export type PimiReportLinkTarget = z.infer<typeof PimiReportLinkTarget>;
export const PimiReportLinkError = z.strictObject({
  reportId: z.uuid(),
  message: z.string().min(1).max(1000),
});
export type PimiReportLinkError = z.infer<typeof PimiReportLinkError>;

export interface PimiReviewSummary {
  filesChanged: number;
  additions: number;
  deletions: number;
  incomplete: boolean;
}

export const PimiRecapPeriod = z.enum(["last-week", "this-week"]);
export type PimiRecapPeriod = z.infer<typeof PimiRecapPeriod>;

export interface PimiRecap {
  startsAt: string;
  endsBefore: string;
  tasks: { id: string; title: string; completedAt: string }[];
  pullRequests: { url: string; title?: string; mergedAt: string }[];
  taskCount: number;
  pullRequestCount: number;
  hasUndatedCompletions: boolean;
}

export const PIMI_TASK_PROPOSAL_TOOL = "propose_pimi_task";
export const PimiTaskProposalResult = z.object({
  pimiTaskProposal: PimiTaskProposal,
});
export const PIMI_REVIEW_SUGGESTION_TOOL = "suggest_pimi_review";
export const PimiReviewSuggestionInput = z.object({
  summary: z.string().trim().min(1).max(300).optional(),
});
export const PimiReviewSuggestion = PimiReviewSuggestionInput.extend({
  path: z.string().min(1),
  source: PimiTaskSource,
});
export type PimiReviewSuggestion = z.infer<typeof PimiReviewSuggestion>;
export const PimiReviewSuggestionResult = z.object({
  pimiReviewSuggestion: PimiReviewSuggestion,
});

function matchesToolName(name: string, tool: string): boolean {
  return (
    name === tool ||
    getPaseoToolLeafName(name) === tool ||
    name === `pimi_${tool}` ||
    name === `paseo_${tool}`
  );
}

export function isPimiTaskProposalTool(name: string): boolean {
  return matchesToolName(name, PIMI_TASK_PROPOSAL_TOOL);
}

export function isPimiReviewSuggestionTool(name: string): boolean {
  return matchesToolName(name, PIMI_REVIEW_SUGGESTION_TOOL);
}

export function isPimiTaskCreateTool(name: string): boolean {
  return matchesToolName(name, PimiTaskAgentTool.create);
}

export function isPimiActionTool(name: string): boolean {
  return (
    isPimiTaskProposalTool(name) || isPimiReviewSuggestionTool(name) || isPimiTaskCreateTool(name)
  );
}

/** Read-only label projection for the desktop console. Assignments stay with the task or workspace. */
export interface PimiLinkedLabels {
  serverId?: string;
  workspaces: Record<string, string[]>;
  agents: Record<string, string[]>;
}
