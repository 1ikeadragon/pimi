// Pimi. PolyForm-Noncommercial-1.0.0.
import { z } from "zod";
import { getPimiToolLeafName } from "./tool-name-normalization.js";
import { TaskDescriptionSchema, TaskTitleSchema } from "./task/types.js";

export const PimiTaskSource = z.object({
  serverId: z.string().trim().min(1).max(256),
  agentId: z.string().trim().min(1).max(256),
});

export const PimiDelegationResult = z.object({
  pimiDelegation: z.object({
    source: PimiTaskSource,
    worker: z.object({
      id: z.string().min(1),
      /** The host the worker runs on. Absent means the same host as the parent (`source.serverId`). */
      serverId: z.string().min(1).optional(),
      provider: z.string().min(1),
      model: z.string().nullable().optional(),
      title: z.string().trim().min(1).max(512),
    }),
    sharedContext: z.boolean(),
    shortened: z.literal(true).optional(),
  }),
});

export const PimiMemoryDestination = z.object({
  view: z.literal("memory"),
  projectId: z.string().min(1).max(4096).optional(),
});
export const PimiSpacesDestination = z.object({
  view: z.literal("spaces"),
  action: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("draft"), text: z.string().max(4096).optional() }),
      z.object({ kind: z.literal("search"), query: z.string().trim().min(1).max(160) }),
      z.object({ kind: z.literal("saved") }),
      z.object({ kind: z.enum(["open", "remove"]), id: z.uuid() }),
    ])
    .optional(),
});
/** Screens the Pimi window shows. */
export type PimiDestination =
  | z.infer<typeof PimiMemoryDestination>
  | z.infer<typeof PimiSpacesDestination>;

/**
 * A destination a voice command can name: the Pimi window's screens, a checkout's Review, or the
 * native Tasks screen, which the app opens itself.
 */
export type PimiVoiceDestination =
  | PimiDestination
  | { view: "review"; path: string; serverId?: string }
  | { view: "tasks" }
  | { view: "task"; id: string }
  | { view: "new-task"; title?: string; description?: string };

export type PimiWorkspaceSection = "memory" | "spaces";
export type PimiActivitySection = "review";

export const PIMI_VOICE_COMMAND_ROUTE = "/api/pimi/voice-command";
export const PIMI_VOICE_COMMAND_LIMIT = 128;
export const PimiVoiceCommandInput = z.strictObject({
  transcript: z.string().trim().min(1).max(4096),
  agentId: z.string().min(1).max(256).optional(),
  workspaceId: z.string().min(1).max(256).optional(),
  commands: z.array(z.string().min(1).max(160)).max(PIMI_VOICE_COMMAND_LIMIT).optional(),
});
export type PimiVoiceCommandInput = z.infer<typeof PimiVoiceCommandInput>;

export const PimiVoiceView = z.enum([
  "chat",
  "tasks",
  "review",
  "memory",
  "spaces",
  "agents",
  "usage",
  "automations",
  "history",
  "skills",
  "hooks",
  "settings",
]);
export type PimiVoiceView = z.infer<typeof PimiVoiceView>;

const voiceNote = z.string().trim().min(1).max(4096);
const voiceTarget = z.string().trim().min(1).max(160);
export const PimiVoiceUsageTab = z.enum(["overview", "sessions", "limits", "recap"]);
export const PimiVoiceNavigation = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("show"), view: PimiVoiceView }),
  z.strictObject({ action: z.literal("new-chat"), text: voiceNote.optional() }),
  z.strictObject({
    action: z.literal("new-task"),
    title: TaskTitleSchema.optional(),
    description: TaskDescriptionSchema.optional(),
  }),
  z.strictObject({ action: z.literal("new-space"), text: voiceNote.optional() }),
  z.strictObject({
    action: z.literal("search-spaces"),
    query: voiceTarget,
  }),
  z.strictObject({ action: z.literal("review-worktree"), name: voiceTarget.optional() }),
  z.strictObject({ action: z.literal("review-prs") }),
  z.strictObject({ action: z.literal("open-task"), title: voiceTarget }),
  z.strictObject({
    action: z.literal("usage"),
    tab: PimiVoiceUsageTab,
    session: voiceTarget.optional(),
  }),
  z.strictObject({
    action: z.literal("space-card"),
    query: voiceTarget,
    intent: z.enum(["open", "remove", "chat"]),
    arxiv: z.boolean().optional(),
    prompt: voiceNote.optional(),
  }),
  z.strictObject({
    action: z.literal("registered-commands"),
    indexes: z
      .array(
        z
          .number()
          .int()
          .min(0)
          .max(PIMI_VOICE_COMMAND_LIMIT - 1),
      )
      .min(1)
      .max(3),
  }),
]);
export type PimiVoiceNavigation = z.infer<typeof PimiVoiceNavigation>;

const chatProvider = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1).optional(),
  thinkingOptionId: z.string().min(1).optional(),
});
// What Ask Pimi asks the app to show. The host resolves each one after the agent's turn, so
// nothing here changes saved data: a removal only opens the card's own confirmation.
export const PimiAskAction = z.discriminatedUnion("action", [
  ...PimiVoiceNavigation.options,
  z.strictObject({ action: z.literal("task"), id: z.uuid() }),
  z.strictObject({ action: z.literal("card"), id: z.uuid(), intent: z.enum(["open", "remove"]) }),
  // The chat starts from the user's own words. The agent only selects the card to attach and
  // the project to open it in; the host has already resolved the project name.
  z.strictObject({
    action: z.literal("start-chat"),
    card: z.uuid().optional(),
    project: z.strictObject({ id: z.string().min(1), path: z.string().min(1) }).optional(),
  }),
]);
export type PimiAskAction = z.infer<typeof PimiAskAction>;
export const PIMI_ASK_ACTION_LIMIT = 3;
export const PIMI_ASK_MESSAGE_LIMIT = 1200;

export const PimiAskResult = z.strictObject({
  message: z.string().max(PIMI_ASK_MESSAGE_LIMIT),
  actions: z.array(PimiAskAction).max(PIMI_ASK_ACTION_LIMIT),
  // Speech that asked for nothing. The app dismisses it without an error.
  ignored: z.literal(true).optional(),
  chatProvider: chatProvider.optional(),
});
export type PimiAskResult = z.infer<typeof PimiAskResult>;

// One JSON object per line. Status lines report progress, and the last line is the result or
// an error.
export const PIMI_ASK_STREAM_TYPE = "application/x-ndjson";
export const PimiAskEvent = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("status"), text: z.string().min(1).max(80) }),
  z.strictObject({ type: z.literal("result"), result: PimiAskResult }),
  z.strictObject({ type: z.literal("error"), error: z.string().min(1).max(240) }),
]);
export type PimiAskEvent = z.infer<typeof PimiAskEvent>;

export function isExplicitVoiceChatRequest(transcript: string): boolean {
  const chat =
    "(?:(?:a|another|any)\\s+)?(?:(?:brand[- ]new|new|fresh|separate)\\s+)?(?:chats?|conversations?|threads?)\\b";
  const declined = new RegExp(
    `\\b(?:don.t|do not|never|without)\\s+(?:(?:actually|just)\\s+)?(?:open(?:ing)?|start(?:ing)?|creat(?:e|ing)|launch(?:ing)?|begin(?:ning)?|mak(?:e|ing)|spin(?:ning)? up)\\s+(?:me\\s+)?${chat}`,
    "i",
  );
  if (declined.test(transcript)) return false;
  return new RegExp(
    `(?:^|[,;.!?]|\\b(?:and|then)\\b)\\s*(?:(?:hey pimi|pimi|ok(?:ay)?|please|can you|could you|would you|i (?:want|need) you to|i.d like you to|um|uh|just|actually)[\\s,]+)*(?:open|start|create|launch|begin|make|spin up)\\s+(?:me\\s+)?${chat}`,
    "i",
  ).test(transcript);
}

export interface PimiVoiceEffect {
  destination?: PimiVoiceDestination;
  navigation?: PimiVoiceNavigation;
  chat?: { serverId: string; workspaceId: string; agentId: string };
}

export interface PimiVoiceResult extends PimiVoiceEffect {
  message: string;
  failed?: boolean;
  ignored?: boolean;
  // Further screens requested in the same Ask Pimi turn, applied in order after the first.
  effects?: PimiVoiceEffect[];
}

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
    const status =
      /^\/(?:[A-Za-z0-9_]{1,15}\/status|i\/web\/status)\/(\d+)(?:\/(?:photo|video)\/\d+)?\/?$/.exec(
        url.pathname,
      );
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

export const PimiVoiceBubbleState = z.strictObject({
  visible: z.boolean(),
  active: z.boolean(),
  status: z.string().max(240),
  level: z.number().min(0).max(1),
  receipt: z
    .strictObject({
      transcript: z.string().max(4096),
      message: z.string().max(1600),
      state: z.enum(["working", "finished", "error"]),
    })
    .optional(),
});
export type PimiVoiceBubbleState = z.infer<typeof PimiVoiceBubbleState>;

export interface PimiReviewSummary {
  filesChanged: number;
  additions: number;
  deletions: number;
  incomplete: boolean;
}

export const PimiRecapPeriod = z.enum(["last-week", "this-week"]);
export type PimiRecapPeriod = z.infer<typeof PimiRecapPeriod>;

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
  return name === tool || getPimiToolLeafName(name) === tool || name === `pimi_${tool}`;
}

export function isPimiReviewSuggestionTool(name: string): boolean {
  return matchesToolName(name, PIMI_REVIEW_SUGGESTION_TOOL);
}

export function isPimiTaskCreateTool(name: string): boolean {
  return matchesToolName(name, "create_pimi_task");
}

export function isPimiDelegationTool(name: string): boolean {
  return matchesToolName(name, "create_agent");
}

export function isPimiPermissionResponseTool(name: string): boolean {
  return matchesToolName(name, "respond_to_permission");
}

export function isPimiActionTool(name: string): boolean {
  return (
    isPimiReviewSuggestionTool(name) || isPimiTaskCreateTool(name) || isPimiDelegationTool(name)
  );
}
