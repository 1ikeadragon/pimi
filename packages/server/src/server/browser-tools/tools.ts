import { z } from "zod";
import { BrowserAutomationBrowserIdSchema } from "@pimi/protocol/browser-automation/rpc-schemas";
import type { AttackService } from "../attack/service.js";
import type { BrowserToolsBroker, BrowserToolsExecuteInput } from "./broker.js";
import { browserToolsFailure, type BrowserToolsResponsePayload } from "./errors.js";
import type {
  PimiToolConfig,
  PimiToolExecutionContext,
  PimiToolResult,
} from "../agent/tools/types.js";

interface CallerAgentContext {
  id: string;
  cwd: string;
  workspaceId?: string;
}

export interface RegisterBrowserToolsOptions {
  registerTool: (
    name: string,
    config: PimiToolConfig,
    handler: (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tool inputs are validated by the catalog before execution.
      input: any,
      context: PimiToolExecutionContext,
    ) => Promise<PimiToolResult>,
  ) => void;
  broker: Pick<BrowserToolsBroker, "execute">;
  callerAgentId?: string;
  resolveCallerAgent: () => CallerAgentContext | null;
  /** Confines an Attack run's agents to the run's hosts; absent where Attack mode is not wired. */
  attack?: Pick<AttackService, "guardForAgent" | "checkNavigation"> | null;
}

const HTTP_URL_ONLY_MESSAGE = "URL must use http/https only";
const WORKSPACE_CONTEXT_MESSAGE =
  "This browser tool needs a workspace. Start the agent from a Pimi workspace before calling browser_new_tab or browser_list_tabs.";
const SHOW_WORKSPACE_CONTEXT_MESSAGE =
  "browser_show needs a workspace and this agent has none. Give the user the link in your reply instead.";
const SHOW_URL_MAX_LENGTH = 8192;
const URL_WHITESPACE_PATTERN = /\s/;
const NON_HTTP_EXPLICIT_SCHEME_PATTERN = /^(?!https?:\/\/)[a-z][a-z0-9+.-]*:\/\//i;

const BrowserHttpUrlInputSchema = z
  .string()
  .trim()
  .transform((value, context) => {
    const normalized = normalizeHttpUrlInput(value);
    if (!normalized) {
      context.addIssue({
        code: "custom",
        message: HTTP_URL_ONLY_MESSAGE,
      });
      return z.NEVER;
    }
    return normalized;
  });
// Mirrors openReportWeb in the desktop app: a link with credentials is never put in front of the user.
const BrowserShowUrlInputSchema = BrowserHttpUrlInputSchema.refine(
  (value) => value.length <= SHOW_URL_MAX_LENGTH,
  `URL must be at most ${SHOW_URL_MAX_LENGTH} characters`,
).refine((value) => {
  const url = new URL(value);
  return !url.username && !url.password;
}, "URL must not contain a username or password");
const BrowserRefInputSchema = z.string().regex(/^@e\d+$/);
const BrowserClickButtonInputSchema = z.enum(["left", "right", "middle"]);
const BrowserClickModifierInputSchema = z.enum(["Alt", "Control", "Meta", "Shift"]);
const BrowserWaitInputSchema = z
  .object({
    text: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().max(30_000).optional(),
    browserId: BrowserAutomationBrowserIdSchema,
  })
  .refine((input) => Number(Boolean(input.text)) + Number(Boolean(input.url)) === 1, {
    message: "browser_wait requires exactly one of text or url",
  });

// Tabs an Attack run's agents drive may only open the run's hosts. The daemon refuses a bad
// new_tab, show_tab or navigate here and audits it; the desktop app enforces the same list on links,
// redirects and scripts (`attackGuard` rides along on every command).
function confineAttackAgents(options: RegisterBrowserToolsOptions): RegisterBrowserToolsOptions {
  const { attack, broker } = options;
  if (!attack) return options;
  const guarded: Pick<BrowserToolsBroker, "execute"> = {
    execute: async (input: BrowserToolsExecuteInput) => {
      const attackGuard = await attack.guardForAgent(input.agentId);
      if (!attackGuard) return broker.execute(input);
      const { command } = input;
      const url =
        command.command === "navigate" ||
        command.command === "new_tab" ||
        command.command === "show_tab"
          ? command.args.url
          : undefined;
      if (url) {
        const decision = await attack.checkNavigation(input.agentId, url);
        if (!decision.allowed) {
          return browserToolsFailure({
            requestId: input.requestId ?? "attack-navigation-refused",
            code: "browser_denied",
            message: decision.message,
          });
        }
      }
      return broker.execute({ ...input, attackGuard });
    },
  };
  return { ...options, broker: guarded };
}

export function registerBrowserTools(unconfined: RegisterBrowserToolsOptions): void {
  const options = confineAttackAgents(unconfined);
  options.registerTool(
    "browser_list_tabs",
    {
      title: "List browser tabs",
      description:
        "List open Pimi browser tabs for this agent's workspace across connected browser automation hosts. Use returned browserId values with tab-scoped tools.",
      inputSchema: {},
    },
    async () => {
      const context = resolveBrowserToolContext(options);
      const missingWorkspace = requireWorkspaceContext(context);
      if (missingWorkspace) {
        return missingWorkspace;
      }
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        command: {
          command: "list_tabs",
          args: {},
        },
      });
      return browserToolResult({ payload, context });
    },
  );

  options.registerTool(
    "browser_new_tab",
    {
      title: "Create browser tab",
      description:
        "Create a new Pimi browser tab in this agent's workspace on the most recently connected browser automation host, opened in the background without switching the user's view. Pass an http(s) URL or a scheme-less host URL, which is treated as http; the returned browserId is used by tab-scoped tools.",
      inputSchema: {
        url: BrowserHttpUrlInputSchema.optional(),
      },
    },
    async ({ url }) => {
      const context = resolveBrowserToolContext(options);
      const missingWorkspace = requireWorkspaceContext(context);
      if (missingWorkspace) {
        return missingWorkspace;
      }
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        command: {
          command: "new_tab",
          args: url ? { url } : {},
        },
      });
      return browserToolResult({ payload, context });
    },
  );

  options.registerTool(
    "browser_snapshot",
    {
      title: "Snapshot browser page",
      description:
        "Return a model-readable snapshot of a Pimi browser tab. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
      inputSchema: {
        browserId: BrowserAutomationBrowserIdSchema,
      },
    },
    async ({ browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "snapshot",
          args: {
            browserId,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
    "browser_click",
    {
      title: "Click browser element",
      description:
        "Click an element in a Pimi browser tab. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
      inputSchema: {
        ref: BrowserRefInputSchema,
        browserId: BrowserAutomationBrowserIdSchema,
        button: BrowserClickButtonInputSchema.optional(),
        doubleClick: z.boolean().optional(),
        modifiers: z.array(BrowserClickModifierInputSchema).optional(),
      },
    },
    async ({ ref, browserId, button, doubleClick, modifiers }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "click",
          args: {
            browserId,
            ref,
            button: button ?? "left",
            doubleClick: doubleClick ?? false,
            modifiers: modifiers ?? [],
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
    "browser_fill",
    {
      title: "Fill browser element",
      description:
        "Fill an input-like element in a Pimi browser tab. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
      inputSchema: {
        ref: BrowserRefInputSchema,
        value: z.string(),
        browserId: BrowserAutomationBrowserIdSchema,
      },
    },
    async ({ ref, value, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "fill",
          args: {
            browserId,
            ref,
            value,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
    "browser_wait",
    {
      title: "Wait for browser condition",
      description:
        "Wait until a Pimi browser tab contains text or reaches a URL fragment. Use browserId from browser_new_tab or browser_list_tabs; waits up to 5s by default on the browser host.",
      inputSchema: BrowserWaitInputSchema,
    },
    async ({ text, url, timeoutMs, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        ...(timeoutMs ? { timeoutMs: timeoutMs + 1_000 } : {}),
        command: {
          command: "wait",
          args: {
            browserId,
            ...(text ? { text } : {}),
            ...(url ? { url } : {}),
            ...(timeoutMs ? { timeoutMs } : {}),
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
    "browser_type",
    {
      title: "Type into browser",
      description:
        "Type text into an element, or into the focused element when ref is omitted. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
      inputSchema: {
        text: z.string(),
        ref: BrowserRefInputSchema.optional(),
        browserId: BrowserAutomationBrowserIdSchema,
      },
    },
    async ({ text, ref, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "type",
          args: {
            browserId,
            ...(ref ? { ref } : {}),
            text,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
    "browser_keypress",
    {
      title: "Press browser key",
      description:
        "Dispatch a keypress to an element, or to the focused element when ref is omitted. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
      inputSchema: {
        key: z.string().min(1),
        ref: BrowserRefInputSchema.optional(),
        browserId: BrowserAutomationBrowserIdSchema,
      },
    },
    async ({ key, ref, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "keypress",
          args: {
            browserId,
            ...(ref ? { ref } : {}),
            key,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
    "browser_navigate",
    {
      title: "Navigate browser",
      description:
        "Navigate a Pimi browser tab to a URL. Use browserId from browser_new_tab or browser_list_tabs; pass an http(s) URL or a scheme-less host URL, which is treated as http.",
      inputSchema: { url: BrowserHttpUrlInputSchema, browserId: BrowserAutomationBrowserIdSchema },
    },
    async ({ url, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "navigate",
          args: {
            browserId,
            url,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  for (const toolConfig of [
    {
      name: "browser_back",
      command: "back",
      title: "Browser back",
      description:
        "Go back in a Pimi browser tab. Use browserId from browser_new_tab or browser_list_tabs.",
    },
    {
      name: "browser_forward",
      command: "forward",
      title: "Browser forward",
      description:
        "Go forward in a Pimi browser tab. Use browserId from browser_new_tab or browser_list_tabs.",
    },
    {
      name: "browser_reload",
      command: "reload",
      title: "Browser reload",
      description:
        "Reload a Pimi browser tab. Use browserId from browser_new_tab or browser_list_tabs.",
    },
  ] as const) {
    options.registerTool(
      toolConfig.name,
      {
        title: toolConfig.title,
        description: toolConfig.description,
        inputSchema: { browserId: BrowserAutomationBrowserIdSchema },
      },
      async ({ browserId }) => {
        const context = resolveBrowserToolContext(options);
        const payload = await options.broker.execute({
          agentId: context.agentId,
          cwd: context.cwd,
          ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

          command: {
            command: toolConfig.command,
            args: {
              browserId,
            },
          },
        });
        return browserToolResult({ payload, context: { ...context, browserId } });
      },
    );
  }

  options.registerTool(
    "browser_screenshot",
    {
      title: "Capture browser screenshot",
      description:
        "Capture a PNG screenshot of a Pimi browser tab. Use browserId from browser_new_tab or browser_list_tabs. Set fullPage to true to capture the full page.",
      inputSchema: {
        browserId: BrowserAutomationBrowserIdSchema,
        fullPage: z.boolean().default(false),
      },
    },
    async ({ browserId, fullPage }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "screenshot",
          args: {
            browserId,
            fullPage: fullPage ?? false,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
    "browser_upload",
    {
      title: "Upload files in browser",
      description:
        "Set workspace files on a file input in a Pimi browser tab. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
      inputSchema: {
        ref: BrowserRefInputSchema,
        filePaths: z.array(z.string().min(1)).min(1),
        browserId: BrowserAutomationBrowserIdSchema,
      },
    },
    async ({ ref, filePaths, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "upload",
          args: {
            browserId,
            ref,
            filePaths,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  for (const toolConfig of [
    {
      name: "browser_hover",
      command: "hover",
      title: "Hover browser element",
      description:
        "Hover an element in a Pimi browser tab. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
    },
  ] as const) {
    options.registerTool(
      toolConfig.name,
      {
        title: toolConfig.title,
        description: toolConfig.description,
        inputSchema: { ref: BrowserRefInputSchema, browserId: BrowserAutomationBrowserIdSchema },
      },
      async ({ ref, browserId }) => {
        const context = resolveBrowserToolContext(options);
        const payload = await options.broker.execute({
          agentId: context.agentId,
          cwd: context.cwd,
          ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

          command: {
            command: toolConfig.command,
            args: {
              browserId,
              ref,
            },
          },
        });
        return browserToolResult({ payload, context: { ...context, browserId } });
      },
    );
  }

  options.registerTool(
    "browser_select",
    {
      title: "Select browser option",
      description:
        "Set a select element in a Pimi browser tab to a value. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
      inputSchema: {
        ref: BrowserRefInputSchema,
        value: z.string(),
        browserId: BrowserAutomationBrowserIdSchema,
      },
    },
    async ({ ref, value, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "select",
          args: {
            browserId,
            ref,
            value,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
    "browser_drag",
    {
      title: "Drag browser element",
      description:
        "Drag one element onto another in a Pimi browser tab. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
      inputSchema: {
        sourceRef: BrowserRefInputSchema,
        targetRef: BrowserRefInputSchema,
        browserId: BrowserAutomationBrowserIdSchema,
      },
    },
    async ({ sourceRef, targetRef, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "drag",
          args: {
            browserId,
            sourceRef,
            targetRef,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
    "browser_logs",
    {
      title: "Read browser logs",
      description:
        "Read recent console messages and browser performance network entries for a Pimi browser tab. Use browserId from browser_new_tab or browser_list_tabs; maxEntries defaults to 50.",
      inputSchema: {
        maxEntries: z.number().int().positive().max(200).optional(),
        browserId: BrowserAutomationBrowserIdSchema,
      },
    },
    async ({ maxEntries, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "logs",
          args: {
            browserId,
            maxEntries: maxEntries ?? 50,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
    "browser_evaluate",
    {
      title: "Evaluate browser JavaScript",
      description:
        "Evaluate a JavaScript function in a Pimi browser tab. Use browserId from browser_new_tab or browser_list_tabs; when ref is provided, refs come from the latest browser_snapshot and the resolved element is passed as the first argument.",
      inputSchema: {
        function: z.string().min(1),
        ref: BrowserRefInputSchema.optional(),
        browserId: BrowserAutomationBrowserIdSchema,
      },
    },
    async ({ function: functionSource, ref, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "evaluate",
          args: {
            browserId,
            function: functionSource,
            ...(ref ? { ref } : {}),
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
    "browser_scroll",
    {
      title: "Scroll browser",
      description:
        "Scroll a Pimi browser tab by deltaX/deltaY CSS pixels. Use browserId from browser_new_tab or browser_list_tabs; optional ref comes from the latest browser_snapshot and centers the wheel input over that element.",
      inputSchema: {
        browserId: BrowserAutomationBrowserIdSchema,
        ref: BrowserRefInputSchema.optional(),
        deltaX: z.number(),
        deltaY: z.number(),
      },
    },
    async ({ browserId, ref, deltaX, deltaY }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "scroll",
          args: {
            browserId,
            ...(ref ? { ref } : {}),
            deltaX,
            deltaY,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
    "browser_resize",
    {
      title: "Resize browser viewport",
      description:
        "Resize a Pimi browser tab's resident webview viewport. Use browserId from browser_new_tab or browser_list_tabs.",
      inputSchema: {
        browserId: BrowserAutomationBrowserIdSchema,
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      },
    },
    async ({ browserId, width, height }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "resize",
          args: {
            browserId,
            width,
            height,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
    "browser_close_tab",
    {
      title: "Close browser tab",
      description:
        "Close a Pimi browser tab, remove its resident webview, and unregister it from the browser automation host. Use browserId from browser_new_tab or browser_list_tabs.",
      inputSchema: {
        browserId: BrowserAutomationBrowserIdSchema,
      },
    },
    async ({ browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "close_tab",
          args: {
            browserId,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );
}

/**
 * `browser_show` stays available when the full browser tools are off: it only puts a page in front
 * of the user and hands the agent nothing back, so it needs no opt-in.
 */
export function registerBrowserShowTool(unconfined: RegisterBrowserToolsOptions): void {
  const options = confineAttackAgents(unconfined);
  options.registerTool(
    "browser_show",
    {
      title: "Show web page to user",
      description:
        "Open a URL in a visible Pimi browser tab beside the chat so the user can look at it and annotate elements back to you. Use it when the user asks to see or open a page or link, or when you want them to look at a page such as a local dev server. It only shows the page: it returns no page content and cannot click, type, or screenshot. http/https only; a scheme-less host is treated as http.",
      inputSchema: { url: BrowserShowUrlInputSchema },
    },
    async ({ url }) => {
      const context = resolveBrowserToolContext(options);
      if (!context.workspaceId) {
        return {
          content: [{ type: "text", text: SHOW_WORKSPACE_CONTEXT_MESSAGE }],
          structuredContent: { ok: false, shown: false, url, reason: "no_workspace" },
          isError: true,
        };
      }
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        workspaceId: context.workspaceId,
        command: { command: "show_tab", args: { url, requireVisible: false } },
      });
      return browserShowResult({ payload, url, context });
    },
  );
}

function browserShowResult(params: {
  payload: BrowserToolsResponsePayload;
  url: string;
  context: { agentId?: string; cwd?: string; workspaceId?: string };
}): PimiToolResult {
  const { payload, url, context } = params;
  if (payload.ok && payload.result.command === "show_tab") {
    const { browserId, visible, reused } = payload.result;
    const text = visible
      ? `Opened ${payload.result.url} in a Pimi browser tab next to the chat.`
      : `Opened ${payload.result.url} in the workspace's tabs, but that workspace is not on screen in the desktop app. Also give the user the link.`;
    return {
      content: [{ type: "text", text }],
      structuredContent: {
        ok: true,
        shown: true,
        visible,
        reused,
        url: payload.result.url,
        browserId,
      },
    };
  }
  if (!payload.ok && payload.error.code === "browser_no_host") {
    return {
      content: [
        {
          type: "text",
          text: "No Pimi desktop app is connected (the user may be on mobile or web). Give the user the URL as a Markdown link.",
        },
      ],
      structuredContent: { ok: false, shown: false, url, reason: "no_desktop" },
    };
  }
  return browserToolResult({ payload, context });
}

function resolveBrowserToolContext(options: RegisterBrowserToolsOptions): {
  agentId?: string;
  cwd?: string;
  workspaceId?: string;
} {
  const callerAgent = options.resolveCallerAgent();
  return {
    ...(options.callerAgentId ? { agentId: options.callerAgentId } : {}),
    ...(callerAgent?.cwd ? { cwd: callerAgent.cwd } : {}),
    ...(callerAgent?.workspaceId ? { workspaceId: callerAgent.workspaceId } : {}),
  };
}

function normalizeHttpUrlInput(value: string): string | null {
  if (value.length === 0) {
    return null;
  }

  const explicitHttpUrl = /^https?:\/\//i.test(value);
  if (explicitHttpUrl) {
    return isValidHttpUrl(value) ? value : null;
  }

  if (URL_WHITESPACE_PATTERN.test(value) || NON_HTTP_EXPLICIT_SCHEME_PATTERN.test(value)) {
    return null;
  }

  const normalized = `http://${value}`;
  return isValidHttpUrl(normalized) ? normalized : null;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function requireWorkspaceContext(context: {
  agentId?: string;
  cwd?: string;
  workspaceId?: string;
}): PimiToolResult | null {
  if (context.workspaceId) {
    return null;
  }

  return browserToolResult({
    payload: {
      requestId: "browser-tools-workspace-context",
      ok: false,
      error: {
        code: "browser_denied",
        message: WORKSPACE_CONTEXT_MESSAGE,
        retryable: false,
      },
    },
    context,
  });
}

function browserToolResult(params: {
  payload: BrowserToolsResponsePayload;
  context: { agentId?: string; cwd?: string; workspaceId?: string; browserId?: string };
}): PimiToolResult {
  const { payload, context } = params;
  if (payload.ok) {
    return {
      content: browserToolSuccessContent(payload),
      structuredContent: {
        ok: true,
        result: browserToolStructuredResult(payload.result),
        ...(payload.dialogs ? { dialogs: payload.dialogs } : {}),
        context,
      },
    };
  }

  return {
    content: [
      {
        type: "text",
        text: appendDialogSummary(summarizeBrowserError(payload.error), payload.dialogs),
      },
    ],
    structuredContent: {
      ok: false,
      error: payload.error,
      ...(payload.dialogs ? { dialogs: payload.dialogs } : {}),
      context,
    },
  };
}

function browserToolStructuredResult(
  result: Extract<BrowserToolsResponsePayload, { ok: true }>["result"],
): Extract<BrowserToolsResponsePayload, { ok: true }>["result"] | Record<string, unknown> {
  if (result.command !== "screenshot") {
    return result;
  }

  const { dataBase64: _dataBase64, ...metadata } = result;
  return metadata;
}

function browserToolSuccessContent(
  payload: Extract<BrowserToolsResponsePayload, { ok: true }>,
): PimiToolResult["content"] {
  const textContent = { type: "text" as const, text: summarizeBrowserSuccess(payload) };
  const imageContent = browserToolImageContent(payload.result);
  return imageContent ? [textContent, imageContent] : [textContent];
}

function browserToolImageContent(
  result: Extract<BrowserToolsResponsePayload, { ok: true }>["result"],
): PimiToolResult["content"][number] | null {
  if (result.command !== "screenshot") {
    return null;
  }

  return {
    type: "image",
    data: result.dataBase64,
    mimeType: result.mimeType,
  };
}

function summarizeBrowserSuccess(
  payload: Extract<BrowserToolsResponsePayload, { ok: true }>,
): string {
  const withDialogs = (summary: string) => appendDialogSummary(summary, payload.dialogs);
  const controlSummary = summarizeBrowserControlSuccess(payload.result);
  if (controlSummary) {
    return withDialogs(controlSummary);
  }

  const refActionSummary = summarizeBrowserRefActionSuccess(payload.result);
  if (refActionSummary) {
    return withDialogs(refActionSummary);
  }

  const diagnosticsSummary = summarizeBrowserDiagnosticsSuccess(payload.result);
  if (diagnosticsSummary) {
    return withDialogs(diagnosticsSummary);
  }

  const keyboardSummary = summarizeBrowserKeyboardSuccess(payload.result);
  if (keyboardSummary) {
    return withDialogs(keyboardSummary);
  }

  const navigationSummary = summarizeBrowserNavigationSuccess(payload.result);
  if (navigationSummary) {
    return withDialogs(navigationSummary);
  }

  const mediaSummary = summarizeBrowserMediaSuccess(payload.result);
  if (mediaSummary) {
    return withDialogs(mediaSummary);
  }

  if (payload.result.command === "list_tabs") {
    const count = payload.result.tabs.length;
    if (count === 0) {
      return "No Pimi browser tabs are open. Call browser_new_tab to create one.";
    }
    const tabLines = payload.result.tabs.map((tab) => {
      const active = tab.isActive ? " active" : "";
      return `- browserId=${tab.browserId}${active} title=${JSON.stringify(tab.title || "Untitled")} url=${tab.url}`;
    });
    return withDialogs(
      [
        `Found ${count} Pimi browser tab${count === 1 ? "" : "s"}. Use these browserId values for tab-scoped browser tools.`,
        ...tabLines,
      ].join("\n"),
    );
  }

  if (payload.result.command === "new_tab") {
    return withDialogs(
      `Created browser tab browserId=${payload.result.browserId} url=${payload.result.url}. Use this browserId for tab-scoped browser tools.`,
    );
  }

  if (payload.result.command === "snapshot") {
    return withDialogs(
      [
        `Snapshot captured ${payload.result.stats.nodeCount} node${payload.result.stats.nodeCount === 1 ? "" : "s"} with ${payload.result.stats.refCount} ref${payload.result.stats.refCount === 1 ? "" : "s"}.`,
        `Title: ${payload.result.title || "Untitled"}`,
        `URL: ${payload.result.url}`,
        "",
        payload.result.snapshot,
      ].join("\n"),
    );
  }

  if (payload.result.command === "wait") {
    return withDialogs(`Browser wait matched ${payload.result.matched}.`);
  }

  return withDialogs(`Browser ${payload.result.command} complete.`);
}

function appendDialogSummary(
  summary: string,
  dialogs: BrowserToolsResponsePayload["dialogs"],
): string {
  if (!dialogs || dialogs.length === 0) {
    return summary;
  }
  return `${summary}\nHandled browser dialog${dialogs.length === 1 ? "" : "s"}: ${dialogs
    .map((dialog) => `${dialog.action} ${dialog.type} ${JSON.stringify(dialog.message)}`)
    .join("; ")}.`;
}

function summarizeBrowserMediaSuccess(
  result: Extract<BrowserToolsResponsePayload, { ok: true }>["result"],
): string | null {
  if (result.command === "screenshot") {
    return `Captured browser screenshot (${result.width}x${result.height}).`;
  }
  if (result.command === "upload") {
    const count = result.filePaths.length;
    return `Uploaded ${count} file${count === 1 ? "" : "s"} to browser element ${result.ref}.`;
  }
  return null;
}

function summarizeBrowserKeyboardSuccess(
  result: Extract<BrowserToolsResponsePayload, { ok: true }>["result"],
): string | null {
  if (result.command === "type") {
    return result.ref
      ? `Typed into browser element ${result.ref}.`
      : "Typed into the focused browser element.";
  }

  if (result.command === "keypress") {
    return result.ref
      ? `Pressed ${result.key} on browser element ${result.ref}.`
      : `Pressed ${result.key} in the browser.`;
  }

  return null;
}

function summarizeBrowserNavigationSuccess(
  result: Extract<BrowserToolsResponsePayload, { ok: true }>["result"],
): string | null {
  if (result.command === "navigate") {
    return `Navigated browser to ${result.url}.`;
  }

  if (result.command === "back" || result.command === "forward" || result.command === "reload") {
    return `Browser ${result.command} complete.`;
  }

  return null;
}

function summarizeBrowserDiagnosticsSuccess(
  result: Extract<BrowserToolsResponsePayload, { ok: true }>["result"],
): string | null {
  if (result.command === "evaluate") {
    return [
      "Browser evaluate returned:",
      result.resultJson,
      ...(result.truncated ? ["Result was truncated."] : []),
    ].join("\n");
  }

  if (result.command !== "logs") {
    return null;
  }

  const consoleCount = result.console.length;
  const networkCount = result.network.length;
  return `Read ${consoleCount} console log${consoleCount === 1 ? "" : "s"} and ${networkCount} network entr${networkCount === 1 ? "y" : "ies"}.`;
}

function summarizeBrowserRefActionSuccess(
  result: Extract<BrowserToolsResponsePayload, { ok: true }>["result"],
): string | null {
  if (result.command === "click") {
    return `Clicked browser element ${result.ref}.`;
  }

  if (result.command === "fill") {
    return `Filled browser element ${result.ref}.`;
  }

  return null;
}

function summarizeBrowserControlSuccess(
  result: Extract<BrowserToolsResponsePayload, { ok: true }>["result"],
): string | null {
  if (result.command === "select") {
    return `Selected ${result.value} in browser element ${result.ref}.`;
  }

  if (result.command === "hover") {
    return `Hovered browser element ${result.ref}.`;
  }

  if (result.command === "drag") {
    return `Dragged browser element ${result.sourceRef} to ${result.targetRef}.`;
  }

  if (result.command === "scroll") {
    return result.ref
      ? `Scrolled browser element ${result.ref} by ${result.deltaX}, ${result.deltaY}.`
      : `Scrolled browser by ${result.deltaX}, ${result.deltaY}.`;
  }

  if (result.command === "resize") {
    return `Resized browser viewport to ${result.width}x${result.height}.`;
  }

  if (result.command === "close_tab") {
    return `Closed browser tab ${result.browserId}.`;
  }

  return null;
}

function summarizeBrowserError(
  error: Extract<BrowserToolsResponsePayload, { ok: false }>["error"],
): string {
  switch (error.code) {
    case "browser_disabled":
      return "Browser tools are disabled. Enable browser tools on the host, then try again.";
    case "browser_no_host":
      return error.message;
    case "browser_timeout":
      return "The browser did not respond before the timeout. Try again or check the browser host.";
    case "screenshot_no_frame":
      return error.message;
    case "browser_unsupported":
      return error.message;
    case "browser_stale_ref":
      return "That browser element reference is stale. Take a new browser snapshot and try again.";
    default:
      return error.message;
  }
}
