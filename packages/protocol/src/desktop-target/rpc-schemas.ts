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
  "scroll",
  "drag",
  "hover",
  "mouse",
  "wait",
  "window",
  "find",
  "element",
  "audit",
  "app",
  "inspect",
  "secrets_scan",
  "ipc",
  "network",
  "deeplink",
  "files",
] as const;
export const DesktopTargetCommandNameSchema = z.enum(DESKTOP_TARGET_COMMAND_NAMES);

export const DESKTOP_INSPECT_SECTIONS = [
  "process",
  "signature",
  "mitigations",
  "modules",
  "ports",
  "children",
  "commandline",
  "protocols",
  "acls",
  "electron",
  "dotnet",
  "all",
] as const;

export const DesktopPlatformSchema = z.enum(["darwin", "win32"]);

// Which Windows window a target is: the handle is a hint the helper re-checks against the process
// identity on every call, so a recycled handle or a restarted app is never driven by mistake.
export const DesktopWinIdentitySchema = z.object({
  hwnd: z.string(),
  pid: z.number().int(),
  processStartedAt: z.string().nullable(),
  windowClass: z.string(),
  exeName: z.string(),
  framework: z.string(),
});

// macOS: an element path from the last snapshot ("0/2/1"). Windows: a ref ("@d12") from the last
// snapshot, find or marked screenshot.
const ElementRefSchema = z.string().min(1).max(500);
const PointSchema = z.object({ x: z.number(), y: z.number() });
const TargetSpecSchema = z
  .object({ element: ElementRefSchema.optional(), point: PointSchema.optional() })
  .strict();
// Input verbs may ask for a screenshot taken just after the action.
const ScreenshotAfterSchema = z.boolean().optional();
const ButtonSchema = z.enum(["left", "right", "middle"]);
const ModifierKeySchema = z.enum(["ctrl", "alt", "shift"]);

export const DesktopTargetCommandSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("list_windows"), args: z.object({}).strict() }),
  z.object({
    command: z.literal("snapshot"),
    args: z
      .object({
        interactiveOnly: z.boolean().optional(),
        root: ElementRefSchema.optional(),
        maxNodes: z.number().int().min(20).max(2000).optional(),
      })
      .strict(),
  }),
  z.object({
    command: z.literal("click"),
    args: z
      .object({
        // A point is in the pixels of the latest screenshot.
        element: ElementRefSchema.optional(),
        point: PointSchema.optional(),
        button: ButtonSchema.optional(),
        count: z.number().int().min(1).max(3).optional(),
        modifiers: z.array(ModifierKeySchema).max(3).optional(),
        via: z.enum(["auto", "input", "pattern"]).optional(),
        screenshotAfter: ScreenshotAfterSchema,
      })
      .strict(),
  }),
  // Typed text travels as data, never spliced into a script.
  z.object({
    command: z.literal("type"),
    args: z
      .object({
        text: z.string().max(2000),
        element: ElementRefSchema.optional(),
        mode: z.enum(["unicode", "scancode", "set"]).optional(),
        clear: z.boolean().optional(),
        submit: z.boolean().optional(),
        screenshotAfter: ScreenshotAfterSchema,
      })
      .strict(),
  }),
  z.object({
    command: z.literal("key"),
    args: z
      .object({
        chord: z.string().min(1).max(60).optional(),
        keys: z.array(z.string().min(1).max(30)).min(1).max(6).optional(),
        holdMs: z.number().int().min(0).max(5000).optional(),
        repeat: z.number().int().min(1).max(20).optional(),
        action: z.enum(["press", "down", "up"]).optional(),
        screenshotAfter: ScreenshotAfterSchema,
      })
      .strict(),
  }),
  z.object({
    command: z.literal("screenshot"),
    args: z
      .object({
        maxEdge: z.number().int().min(256).max(1920).optional(),
        marks: z.boolean().optional(),
        grid: z.boolean().optional(),
        // In pixels of the current frame: returns that crop at native resolution.
        region: z
          .object({
            x: z.number().min(0),
            y: z.number().min(0),
            width: z.number().positive(),
            height: z.number().positive(),
          })
          .optional(),
      })
      .strict(),
  }),
  z.object({
    command: z.literal("scroll"),
    args: z
      .object({
        element: ElementRefSchema.optional(),
        point: PointSchema.optional(),
        dx: z.number().int().min(-30).max(30).optional(),
        dy: z.number().int().min(-30).max(30).optional(),
        screenshotAfter: ScreenshotAfterSchema,
      })
      .strict(),
  }),
  z.object({
    command: z.literal("drag"),
    args: z
      .object({
        from: TargetSpecSchema,
        to: TargetSpecSchema,
        button: ButtonSchema.optional(),
        durationMs: z.number().int().min(100).max(3000).optional(),
        modifiers: z.array(ModifierKeySchema).max(3).optional(),
        screenshotAfter: ScreenshotAfterSchema,
      })
      .strict(),
  }),
  z.object({
    command: z.literal("hover"),
    args: z
      .object({
        element: ElementRefSchema.optional(),
        point: PointSchema.optional(),
        dwellMs: z.number().int().min(0).max(3000).optional(),
        screenshotAfter: ScreenshotAfterSchema,
      })
      .strict(),
  }),
  z.object({
    command: z.literal("mouse"),
    args: z
      .object({
        action: z.enum(["down", "up", "move_rel"]),
        button: ButtonSchema.optional(),
        dx: z.number().int().min(-2000).max(2000).optional(),
        dy: z.number().int().min(-2000).max(2000).optional(),
        durationMs: z.number().int().min(0).max(3000).optional(),
        screenshotAfter: ScreenshotAfterSchema,
      })
      .strict(),
  }),
  z.object({
    command: z.literal("wait"),
    args: z
      .object({
        ms: z.number().int().min(0).max(10_000).optional(),
        until: z.enum(["stable", "change", "text", "gone"]).optional(),
        text: z.string().max(200).optional(),
        element: ElementRefSchema.optional(),
        timeoutMs: z.number().int().min(100).max(10_000).optional(),
      })
      .strict(),
  }),
  z.object({
    command: z.literal("window"),
    args: z
      .object({
        action: z.enum(["state", "focus", "restore", "maximize", "fit", "resize"]),
        width: z.number().int().min(320).max(3840).optional(),
        height: z.number().int().min(240).max(2160).optional(),
      })
      .strict(),
  }),
  z.object({
    command: z.literal("find"),
    args: z
      .object({
        name: z.string().max(200).optional(),
        nameContains: z.string().max(200).optional(),
        role: z.string().max(60).optional(),
        automationId: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      })
      .strict(),
  }),
  z.object({
    command: z.literal("element"),
    args: z
      .object({
        element: ElementRefSchema.optional(),
        point: PointSchema.optional(),
        text: z.boolean().optional(),
      })
      .strict(),
  }),
  z.object({ command: z.literal("audit"), args: z.object({}).strict() }),
  // The picked app only, with the owner-typed launch arguments. launch and relaunch need the
  // owner's allowRelaunch switch.
  z.object({
    command: z.literal("app"),
    args: z.object({ action: z.enum(["status", "launch", "relaunch"]) }).strict(),
  }),
  // Security reads of the target's own process, binary, files, IPC and network (the design is in
  // SECURITY-DESIGN.md). They need the owner's allowDesktopInspect switch; ipc probe and deeplink
  // are input and need allowInput.
  z.object({
    command: z.literal("inspect"),
    args: z.object({ section: z.enum(DESKTOP_INSPECT_SECTIONS).optional() }).strict(),
  }),
  z.object({
    command: z.literal("secrets_scan"),
    args: z
      .object({
        roots: z
          .array(z.enum(["data", "install", "registry"]))
          .max(3)
          .optional(),
        // Globs inside the target's own scope, for example "**/*.json".
        include: z.array(z.string().min(1).max(200)).max(10).optional(),
        maxFiles: z.number().int().min(1).max(5000).optional(),
        maxBytesPerFile: z.number().int().min(1).max(1_048_576).optional(),
      })
      .strict(),
  }),
  z.object({
    command: z.literal("ipc"),
    args: z
      .object({
        action: z.enum(["list", "probe"]),
        port: z.number().int().min(1).max(65_535).optional(),
        path: z.string().max(200).optional(),
      })
      .strict(),
  }),
  z.object({ command: z.literal("network"), args: z.object({}).strict() }),
  z.object({
    command: z.literal("deeplink"),
    args: z.object({ url: z.string().min(1).max(2000) }).strict(),
  }),
  z.object({
    command: z.literal("files"),
    args: z
      .object({
        action: z.enum(["list", "read"]),
        // Relative to a confirmed scope root.
        path: z.string().max(400),
        maxBytes: z.number().int().min(1).max(262_144).optional(),
      })
      .strict(),
  }),
]);

export const DesktopTargetErrorCodeSchema = z.enum([
  "permission_missing",
  "window_gone",
  "refused",
  "unsupported",
  "failed",
  "stale_ref",
  "elevated_target",
  "occluded",
  "foreground_denied",
  "user_active",
  "secure_desktop",
  "window_minimized",
  "target_hung",
  "blocked",
]);

// On Windows `bundleId` carries the app id: the AUMID of a packaged app, else the lowercased full
// path of the exe.
export const DesktopWindowInfoSchema = z.object({
  bundleId: z.string(),
  appName: z.string(),
  windowTitle: z.string(),
  platform: DesktopPlatformSchema.optional(),
  framework: z.string().optional(),
  elevated: z.boolean().optional(),
  blocked: z.string().nullable().optional(),
  win: DesktopWinIdentitySchema.nullable().optional(),
});

const ScreenshotBodySchema = z.object({
  mimeType: z.literal("image/png"),
  dataBase64: z.string().min(1),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  // The window's size in screen points (macOS) or physical pixels (Windows).
  windowWidth: z.number().nonnegative(),
  windowHeight: z.number().nonnegative(),
  // Image pixels per window pixel, and where the image's top left sits in the window.
  scale: z.number().positive().optional(),
  origin: PointSchema.optional(),
  dpi: z.number().optional(),
  method: z.enum(["wgc", "printwindow", "screen"]).optional(),
  suspectBlank: z.boolean().optional(),
  legend: z.string().optional(),
});

const ChangedSchema = z.object({
  changed: z.boolean(),
  screenshot: ScreenshotBodySchema.optional(),
});

export const DesktopTargetResultSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("list_windows"), windows: z.array(DesktopWindowInfoSchema) }),
  // An indented text tree.
  z.object({
    command: z.literal("snapshot"),
    tree: z.string(),
    truncated: z.boolean(),
    treeQuality: z.enum(["full", "weak", "none"]).optional(),
    nodeCount: z.number().int().nonnegative().optional(),
  }),
  // What the click hit, for the audit line and the owner's action log. Never typed text.
  z.object({
    command: z.literal("click"),
    role: z.string().nullable(),
    label: z.string().max(200).nullable(),
    point: PointSchema.nullable(),
    via: z.enum(["input", "pattern"]).optional(),
    changed: z.boolean().optional(),
    focusLeft: z.string().nullable().optional(),
    screenshot: ScreenshotBodySchema.optional(),
  }),
  z.object({
    command: z.literal("type"),
    via: z.string().optional(),
    changed: z.boolean().optional(),
    focusLeft: z.string().nullable().optional(),
    sent: z.number().int().nonnegative().optional(),
    screenshot: ScreenshotBodySchema.optional(),
  }),
  z.object({
    command: z.literal("key"),
    changed: z.boolean().optional(),
    focusLeft: z.string().nullable().optional(),
    screenshot: ScreenshotBodySchema.optional(),
  }),
  z.object({ command: z.literal("screenshot") }).merge(ScreenshotBodySchema),
  z.object({ command: z.literal("scroll") }).merge(ChangedSchema),
  z.object({ command: z.literal("drag") }).merge(ChangedSchema),
  z.object({ command: z.literal("hover") }).merge(ChangedSchema),
  z.object({ command: z.literal("mouse") }).merge(ChangedSchema),
  z.object({
    command: z.literal("wait"),
    satisfied: z.boolean(),
    waitedMs: z.number().nonnegative(),
  }),
  z.object({
    command: z.literal("window"),
    title: z.string(),
    rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
    dpi: z.number(),
    minimized: z.boolean(),
    maximized: z.boolean(),
    foreground: z.boolean(),
    responding: z.boolean(),
    elevated: z.boolean(),
    framework: z.string(),
    surfaces: z.array(
      z.object({
        class: z.string(),
        rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
      }),
    ),
  }),
  z.object({ command: z.literal("find"), matches: z.string() }),
  z.object({ command: z.literal("element"), details: z.string() }),
  z.object({ command: z.literal("audit"), report: z.string() }),
  // status: running or exited, responsiveness, memory and handle counts, crash dialogs. launch
  // and relaunch: what happened and the window that came up.
  z.object({ command: z.literal("app"), report: z.string() }),
  // A readable report plus the facts it was made from.
  z.object({
    command: z.literal("inspect"),
    report: z.string(),
    structured: z.record(z.string(), z.unknown()),
  }),
  // Secret values are redacted before they leave the desktop app: only a prefix of at most four
  // characters and the length remain.
  z.object({
    command: z.literal("secrets_scan"),
    report: z.string(),
    hits: z.array(
      z.object({
        where: z.string(),
        kind: z.string(),
        valuePrefix: z.string().max(4),
        valueLength: z.number().int().nonnegative(),
      }),
    ),
    filesScanned: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
  z.object({
    command: z.literal("ipc"),
    report: z.string(),
    structured: z.record(z.string(), z.unknown()),
  }),
  // The process tree's remote endpoints. The daemon adds the Network monitor's launch and DNS
  // records to them.
  z.object({
    command: z.literal("network"),
    endpoints: z.array(
      z.object({
        protocol: z.enum(["tcp", "udp"]),
        localAddress: z.string(),
        localPort: z.number().int(),
        remoteAddress: z.string().nullable(),
        remotePort: z.number().int().nullable(),
        state: z.string(),
        pid: z.number().int(),
        plaintext: z.boolean(),
      }),
    ),
    certSignals: z.array(z.string()),
  }),
  z.object({
    command: z.literal("deeplink"),
    launched: z.boolean(),
    handler: z.string().nullable(),
    focusLeft: z.string().nullable().optional(),
    changed: z.boolean().optional(),
  }),
  z.object({
    command: z.literal("files"),
    report: z.string(),
    bytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
]);

export const DesktopTargetGuardSchema = z.object({
  runId: z.string().min(1),
  // The app id: a macOS bundle id, or on Windows an AUMID or a lowercased exe path.
  bundleId: z.string().min(1),
  windowTitle: z.string(),
  allowInput: z.boolean(),
  platform: DesktopPlatformSchema.default("darwin"),
  win: DesktopWinIdentitySchema.nullable().default(null),
  // The owner's separate switch for starting the app again, the arguments they typed for it,
  // and whether the target is disposable (a hung app may then be terminated).
  allowRelaunch: z.boolean().default(false),
  launchArgs: z.string().max(500).default(""),
  disposable: z.boolean().default(false),
  // The owner's switch for the read-only security tools, and the data directories they confirmed
  // as the app's own. Nothing outside the install dir, these and the process tree is ever read.
  allowInspect: z.boolean().default(false),
  dataDirs: z.array(z.string().min(1).max(400)).max(20).default([]),
});

export const DesktopTargetExecuteRequestSchema = z
  .object({
    type: z.literal("desktop.target.execute.request"),
    // Set by the session when it delivers the request to the registered host.
    subscriptionId: z.string().optional(),
    requestId: z.string().min(1),
    agentId: z.string().min(1),
    // Set by the daemon from the run: the only window the call may touch.
    guard: DesktopTargetGuardSchema.optional(),
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
export type DesktopTargetGuard = z.infer<typeof DesktopTargetGuardSchema>;

export type DesktopTargetErrorCode = z.infer<typeof DesktopTargetErrorCodeSchema>;
