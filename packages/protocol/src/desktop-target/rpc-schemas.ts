import { z } from "zod";

// The daemon brokers desktop_* agent tools to the desktop app, the way browser_* tools are brokered
// (see browser-automation/rpc-schemas.ts). The app's main process enforces the guard on every call.

export const DESKTOP_TARGET_COMMAND_NAMES = [
  "list_windows",
  "snapshot",
  "click",
  "type",
  "key",
  "screenshot",
] as const;
export const DesktopTargetCommandNameSchema = z.enum(DESKTOP_TARGET_COMMAND_NAMES);

const AxPathSchema = z.string().min(1).max(500);

export const DesktopTargetCommandSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("list_windows"), args: z.object({}).strict() }),
  z.object({ command: z.literal("snapshot"), args: z.object({}).strict() }),
  z.object({
    command: z.literal("click"),
    args: z
      .object({
        // An element path from the last snapshot, or a point relative to the window's top left.
        element: AxPathSchema.optional(),
        point: z.object({ x: z.number(), y: z.number() }).optional(),
      })
      .strict(),
  }),
  // Typed text travels as data, never spliced into a script.
  z.object({ command: z.literal("type"), args: z.object({ text: z.string().max(2000) }).strict() }),
  z.object({
    command: z.literal("key"),
    args: z.object({ chord: z.string().min(1).max(60) }).strict(),
  }),
  z.object({
    command: z.literal("screenshot"),
    args: z.object({ maxWidth: z.number().int().min(64).max(1280).optional() }).strict(),
  }),
]);

export const DesktopTargetErrorCodeSchema = z.enum([
  "permission_missing",
  "window_gone",
  "refused",
  "unsupported",
  "failed",
]);

export const DesktopWindowInfoSchema = z.object({
  bundleId: z.string(),
  appName: z.string(),
  windowTitle: z.string(),
});

export const DesktopTargetResultSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("list_windows"), windows: z.array(DesktopWindowInfoSchema) }),
  // An indented text tree, at most depth 12 and 400 nodes.
  z.object({ command: z.literal("snapshot"), tree: z.string(), truncated: z.boolean() }),
  z.object({ command: z.literal("click") }),
  z.object({ command: z.literal("type") }),
  z.object({ command: z.literal("key") }),
  z.object({
    command: z.literal("screenshot"),
    mimeType: z.literal("image/png"),
    dataBase64: z.string().min(1),
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative(),
  }),
]);

export const DesktopTargetExecuteRequestSchema = z
  .object({
    type: z.literal("desktop.target.execute.request"),
    requestId: z.string().min(1),
    agentId: z.string().min(1),
    // Set by the daemon from the run: the only window the call may touch.
    guard: z
      .object({
        runId: z.string().min(1),
        bundleId: z.string().min(1),
        windowTitle: z.string(),
        allowInput: z.boolean(),
      })
      .optional(),
    command: DesktopTargetCommandSchema,
  })
  .strict();

export const DesktopTargetExecuteResponseSchema = z.object({
  type: z.literal("desktop.target.execute.response"),
  payload: z.discriminatedUnion("ok", [
    z.object({
      requestId: z.string().min(1),
      ok: z.literal(true),
      result: DesktopTargetResultSchema,
    }),
    z.object({
      requestId: z.string().min(1),
      ok: z.literal(false),
      error: z.object({ code: DesktopTargetErrorCodeSchema, message: z.string().min(1) }),
    }),
  ]),
});

export type DesktopTargetCommand = z.infer<typeof DesktopTargetCommandSchema>;
export type DesktopTargetResult = z.infer<typeof DesktopTargetResultSchema>;
export type DesktopTargetExecuteRequest = z.infer<typeof DesktopTargetExecuteRequestSchema>;
export type DesktopTargetExecuteResponse = z.infer<typeof DesktopTargetExecuteResponseSchema>;
