import { z } from "zod";
import { DESKTOP_INSPECT_SECTIONS } from "@pimi/protocol/desktop-target/rpc-schemas";
import type {
  DesktopTargetCommand,
  DesktopTargetResult,
} from "@pimi/protocol/desktop-target/rpc-schemas";
import type { AttackService } from "../attack/service.js";
import { snapshotDaemonNetworkActivity } from "../network/activity.js";
import type { DesktopToolsBroker, DesktopToolsPayload } from "./broker.js";
import { PimiToolInputError } from "../agent/tools/types.js";
import type {
  PimiToolConfig,
  PimiToolExecutionContext,
  PimiToolResult,
} from "../agent/tools/types.js";

export interface RegisterDesktopToolsOptions {
  registerTool: (
    name: string,
    config: PimiToolConfig,
    handler: (input: any, context: PimiToolExecutionContext) => Promise<PimiToolResult>, // eslint-disable-line @typescript-eslint/no-explicit-any -- inputs are validated by the catalog before execution
  ) => void;
  broker: Pick<DesktopToolsBroker, "execute">;
  attack: Pick<AttackService, "desktopGuardForAgent" | "recordDesktopAction">;
  callerAgentId?: string;
}

type Verb = Exclude<DesktopTargetCommand["command"], "list_windows">;
const INPUT_VERBS: ReadonlySet<Verb> = new Set([
  "click",
  "type",
  "key",
  "scroll",
  "drag",
  "hover",
  "mouse",
  "deeplink",
]);

// The read-tier security tools, which need the owner's allowDesktopInspect switch. `ipc` is one
// of them only for action "list"; its "probe" is input.
const INSPECT_VERBS: ReadonlySet<Verb> = new Set(["inspect", "secrets_scan", "files", "network"]);

type ScreenshotBody = Extract<DesktopTargetResult, { command: "screenshot" }>;

// The text and image an agent reads for a screenshot, shared by desktop_screenshot and every
// input verb called with screenshotAfter.
function screenshotContent(shot: Omit<ScreenshotBody, "command">): PimiToolResult["content"] {
  const facts = [
    `${shot.width}x${shot.height}`,
    shot.scale !== undefined ? `scale ${shot.scale.toFixed(3)}` : null,
    shot.method ? `method ${shot.method}` : null,
    shot.origin && (shot.origin.x !== 0 || shot.origin.y !== 0)
      ? `region origin ${shot.origin.x},${shot.origin.y}`
      : null,
  ].filter(Boolean);
  const lines = [
    `Window screenshot, ${facts.join(", ")}. Click coordinates are pixels of this image.`,
  ];
  if (shot.suspectBlank) {
    lines.push(
      "suspectBlank: true. The capture may be blank or stale (a game or GPU surface). Try desktop_wait until stable, desktop_window focus, then screenshot again.",
    );
  }
  if (shot.legend) lines.push(`Marks (number N is ref @dN):\n${shot.legend}`);
  return [
    { type: "text", text: lines.join("\n") },
    { type: "image", data: shot.dataBase64, mimeType: shot.mimeType },
  ];
}

// `window` is an input verb except when it only reads the window's state.
function isInputCommand(command: DesktopTargetCommand): boolean {
  if (command.command === "window") return command.args.action !== "state";
  if (command.command === "app") return command.args.action !== "status";
  if (command.command === "ipc") return command.args.action === "probe";
  return INPUT_VERBS.has(command.command as Verb);
}

function isInspectCommand(command: DesktopTargetCommand): boolean {
  if (command.command === "ipc") return command.args.action === "list";
  return INSPECT_VERBS.has(command.command as Verb);
}

// What the audit line and the owner's log say about a call to a security tool: the section,
// action, counts, host and port, scheme or relative path. Never a secret, file content or a
// deep-link payload.
function securityAuditDetail(
  command: DesktopTargetCommand,
  result: DesktopTargetResult,
): string | null {
  const clean = (text: string, max: number) => text.replace(/[^\w\-.,:;/\\@ ]/g, "").slice(0, max);
  switch (result.command) {
    case "inspect":
      return command.command === "inspect" ? (command.args.section ?? "all") : null;
    case "secrets_scan": {
      const counts = new Map<string, number>();
      for (const hit of result.hits) counts.set(hit.kind, (counts.get(hit.kind) ?? 0) + 1);
      const kinds = [...counts].map(([kind, count]) => `${clean(kind, 30)}=${count}`).join(",");
      return `${result.hits.length} hits${kinds ? ` ${kinds}` : ""} in ${result.filesScanned} files`;
    }
    case "ipc":
      if (command.command !== "ipc") return null;
      return command.args.action === "probe" ? `probe 127.0.0.1:${command.args.port ?? 0}` : "list";
    case "network":
      return `${result.endpoints.length} endpoints`;
    case "deeplink": {
      if (command.command !== "deeplink") return null;
      const url = command.args.url;
      const scheme = clean(url.split(":")[0] ?? "", 40);
      return `scheme ${scheme} payload ${url.length} chars`;
    }
    case "files":
      return command.command === "files"
        ? `${command.args.action} ${clean(command.args.path, 80)} ${result.bytes}B`
        : null;
    default:
      return null;
  }
}

function auditFacts(
  command: DesktopTargetCommand,
  result: DesktopTargetResult,
): { role: string | null; label: string | null; point: { x: number; y: number } | null } {
  if (result.command === "click") {
    return { role: result.role, label: result.label, point: result.point };
  }
  return { role: securityAuditDetail(command, result), label: null, point: null };
}

// Why a call is turned away before it reaches the desktop app, from the run's consent switches.
function consentRefusal(
  command: DesktopTargetCommand,
  guard: { allowInput: boolean; allowInspect: boolean; allowRelaunch: boolean },
): { message: string; detail: string } | null {
  const verb = command.command;
  if (isInputCommand(command) && !guard.allowInput) {
    return {
      message:
        "The owner did not allow desktop input for this run. Input is off; snapshot, screenshot, find, element, wait, audit and window state still work.",
      detail: `${verb} refused: input not allowed`,
    };
  }
  if (isInspectCommand(command) && !guard.allowInspect) {
    return {
      message:
        "The owner did not allow security inspection for this run. desktop_inspect, desktop_secrets_scan, desktop_files, desktop_network and desktop_ipc list are off; snapshot, screenshot, find, element, wait, audit and window state still work.",
      detail: `${verb} refused: inspection not allowed`,
    };
  }
  if (verb === "app" && isInputCommand(command) && !guard.allowRelaunch) {
    return {
      message:
        "The owner did not allow launching or relaunching the app for this run. desktop_app status still works.",
      detail: "app refused: relaunch not allowed",
    };
  }
  return null;
}

function refusal(text: string): PimiToolResult {
  return { content: [{ type: "text", text }], structuredContent: { ok: false }, isError: true };
}

function ok(text: string, extra: Record<string, unknown> = {}): PimiToolResult {
  return { content: [{ type: "text", text }], structuredContent: { ok: true, ...extra } };
}

// What an input call did, in the words an agent needs to decide its next step.
function effects(result: { via?: string; changed?: boolean; focusLeft?: string | null }): string {
  const parts: string[] = [];
  if (result.via) parts.push(`via ${result.via}`);
  if (result.changed !== undefined) {
    parts.push(result.changed ? "the window changed" : "nothing visibly changed");
  }
  if (result.focusLeft) {
    parts.push(
      `focus left the window for ${result.focusLeft}; the next input is refused until you bring the window back`,
    );
  }
  return parts.length > 0 ? ` (${parts.join("; ")})` : "";
}

const COORDINATES =
  "Coordinates are pixels of the latest desktop_screenshot of this window, measured from its top left; take a screenshot first and do not reuse coordinates after the window changes size.";
const REFS =
  "An element is a ref from desktop_snapshot, desktop_find or a marked desktop_screenshot, such as @d12 on Windows (a path such as 0/2/1 on macOS). Prefer refs to coordinates.";
const SCREENSHOT_AFTER_FIELD = z
  .boolean()
  .optional()
  .describe(
    "true to get a screenshot taken 250 ms after the action in the same result: saves a round trip in see-and-act loops, such as games.",
  );
const ELEMENT_FIELD = z.string().min(1).max(500).optional();
const MODIFIERS_FIELD = z
  .array(z.enum(["ctrl", "alt", "shift"]))
  .max(3)
  .optional();
const BUTTON_FIELD = z.enum(["left", "right", "middle"]).optional();

function pointOrElement(
  element: string | undefined,
  x: number | undefined,
  y: number | undefined,
): { element: string } | { point: { x: number; y: number } } | null {
  if (element !== undefined) return { element };
  if (x !== undefined && y !== undefined) return { point: { x, y } };
  return null;
}

function describeWindow(
  result: Extract<DesktopTargetResult, { command: "window" }>,
): PimiToolResult {
  let shape = "normal";
  if (result.minimized) shape = "minimized";
  else if (result.maximized) shape = "maximized";
  const state = [
    shape,
    result.foreground ? "foreground" : "background",
    result.responding ? "responding" : "NOT responding",
    result.elevated ? "elevated (input is refused)" : null,
  ].filter(Boolean);
  const surfaces = result.surfaces.map(
    (surface) =>
      `${surface.class} ${surface.rect.width}x${surface.rect.height}@${surface.rect.x},${surface.rect.y}`,
  );
  const extra = surfaces.length > 0 ? `\nSurfaces: ${surfaces.join("; ")}` : "";
  return ok(
    `Window "${result.title}" ${result.rect.width}x${result.rect.height} at ${result.rect.x},${result.rect.y}, dpi ${result.dpi}, ${result.framework}, ${state.join(", ")}.${extra}`,
  );
}

function describeRead(result: DesktopTargetResult): PimiToolResult | null {
  switch (result.command) {
    case "snapshot": {
      const quality = result.treeQuality ? `\nTree quality: ${result.treeQuality}.` : "";
      const truncated = result.truncated
        ? "\n(tree truncated; narrow it with root or interactiveOnly)"
        : "";
      return {
        content: [{ type: "text", text: `${result.tree}${truncated}${quality}` }],
        structuredContent: {
          ok: true,
          truncated: result.truncated,
          treeQuality: result.treeQuality ?? null,
        },
      };
    }
    case "screenshot":
      return {
        content: screenshotContent(result),
        structuredContent: {
          ok: true,
          width: result.width,
          height: result.height,
          scale: result.scale ?? null,
          method: result.method ?? null,
          suspectBlank: result.suspectBlank ?? false,
        },
      };
    case "wait":
      return ok(
        `${result.satisfied ? "Condition met" : "Condition not met"} after ${result.waitedMs} ms.`,
        { satisfied: result.satisfied },
      );
    case "window":
      return describeWindow(result);
    case "find":
      return ok(result.matches.trim() === "" ? "No matches." : result.matches);
    case "element":
      return ok(result.details);
    case "audit":
    case "app":
      return ok(result.report);
    default:
      return null;
  }
}

function describeSecurity(result: DesktopTargetResult): PimiToolResult | null {
  switch (result.command) {
    case "inspect":
    case "ipc":
    case "files":
      return ok(result.report);
    case "secrets_scan":
      return ok(result.report, {
        hits: result.hits.length,
        filesScanned: result.filesScanned,
        truncated: result.truncated,
      });
    case "deeplink":
      return ok(
        result.launched
          ? `Deep link sent to ${result.handler ?? "the app"}${effects(result)}.`
          : `The deep link was not launched${result.handler ? ` (handler ${result.handler})` : ""}.`,
        { launched: result.launched, changed: result.changed ?? null },
      );
    default:
      return null;
  }
}

const NETWORK_RECORD_LIMIT = 200;
const NETWORK_NAME_LIMIT = 20;

// The process tree's endpoints from the helper, with what the daemon's Network monitor knows:
// the launch of the target when Pimi started it, records that name an endpoint's address, and the
// DNS names the daemon saw. The monitor does not see inside the target's own sockets, so the
// endpoint list is the authority and the monitor adds context.
function describeNetwork(
  result: Extract<DesktopTargetResult, { command: "network" }>,
  exeName?: string,
): PimiToolResult {
  const lines = result.endpoints.map((endpoint) => {
    const remote =
      endpoint.remoteAddress === null
        ? "listening"
        : `-> ${endpoint.remoteAddress}:${endpoint.remotePort ?? 0}`;
    const flag = endpoint.plaintext ? " PLAINTEXT" : "";
    return `${endpoint.protocol} ${endpoint.localAddress}:${endpoint.localPort} ${remote} ${endpoint.state} pid ${endpoint.pid}${flag}`;
  });
  const sections = [
    lines.length > 0
      ? `Endpoints of the app's process tree:\n${lines.join("\n")}`
      : "No endpoints.",
  ];
  const snapshot = snapshotDaemonNetworkActivity({
    includeLocal: true,
    limit: NETWORK_RECORD_LIMIT,
  });
  const needle = exeName?.toLowerCase();
  const launches = snapshot.requests.filter(
    (record) =>
      record.protocol === "process" &&
      needle !== undefined &&
      `${record.host} ${record.path}`.toLowerCase().includes(needle),
  );
  const remotes = new Set(
    result.endpoints.flatMap((endpoint) =>
      endpoint.remoteAddress === null ? [] : [endpoint.remoteAddress.toLowerCase()],
    ),
  );
  const named = snapshot.requests.filter(
    (record) => record.protocol !== "process" && remotes.has(record.host.toLowerCase()),
  );
  if (launches.length > 0) {
    sections.push(
      `Network monitor: Pimi launched the app (${launches.length} launch record${launches.length === 1 ? "" : "s"}).`,
    );
    const names = [
      ...new Set(
        snapshot.requests.filter((record) => record.protocol === "dns").map((r) => r.host),
      ),
    ].slice(0, NETWORK_NAME_LIMIT);
    if (names.length > 0) {
      sections.push(
        `DNS names the daemon looked up recently (daemon-wide, not only this app): ${names.join(", ")}`,
      );
    }
  }
  if (named.length > 0) {
    sections.push(
      `Network monitor records for these addresses:\n${named
        .slice(0, 20)
        .map(
          (r) =>
            `${r.protocol} ${r.host}${r.port === null ? "" : `:${r.port}`}${r.path} ${r.state}`,
        )
        .join("\n")}`,
    );
  }
  sections.push(
    result.certSignals.length > 0
      ? `Certificate validation signals:\n${result.certSignals.join("\n")}`
      : "Certificate validation signals: none found.",
  );
  return ok(sections.join("\n\n"), {
    endpoints: result.endpoints.length,
    plaintext: result.endpoints.filter((endpoint) => endpoint.plaintext).length,
  });
}

function describe(result: DesktopTargetResult, verb: Verb): PimiToolResult {
  const read = describeRead(result) ?? describeSecurity(result);
  if (read) return read;
  switch (result.command) {
    case "click":
      return ok(
        `Clicked ${result.role ?? "element"}${result.label ? ` "${result.label}"` : ""}${effects(result)}.`,
        { changed: result.changed ?? null, focusLeft: result.focusLeft ?? null },
      );
    case "type":
      return ok(
        `Typed${result.sent !== undefined ? ` ${result.sent} characters` : ""}${effects(result)}.`,
        { changed: result.changed ?? null, focusLeft: result.focusLeft ?? null },
      );
    case "key":
      return ok(`Key sent${effects(result)}.`, {
        changed: result.changed ?? null,
        focusLeft: result.focusLeft ?? null,
      });
    case "scroll":
    case "drag":
    case "hover":
    case "mouse":
      return ok(`Desktop ${verb} done${effects(result)}.`, { changed: result.changed });
    default:
      return ok(`Desktop ${verb} done.`);
  }
}
/**
 * The desktop_* tools of an Attack run that drives a desktop window. The guard (which window,
 * whether input is allowed) is built here from the run, never from tool input, and the desktop
 * app checks it again on every call.
 */
export function registerDesktopTools(options: RegisterDesktopToolsOptions): void {
  const run = async (
    command: DesktopTargetCommand,
    refusedDetail = "",
  ): Promise<PimiToolResult> => {
    const verb = command.command as Verb;
    const agentId = options.callerAgentId;
    if (!agentId) {
      throw new PimiToolInputError("This tool is only for agents inside an Attack run.");
    }
    const scope = await options.attack.desktopGuardForAgent(agentId);
    if (!scope) {
      return refusal("This tool is only for agents of an Attack run that has a desktop target.");
    }
    const refuse = async (message: string, detail: string): Promise<PimiToolResult> => {
      await options.attack.recordDesktopAction({
        runId: scope.runId,
        agentId,
        verb,
        outcome: { refused: detail },
      });
      return refusal(message);
    };
    if (scope.status !== "running") {
      return refuse(
        `The run is ${scope.status}; desktop actions are off until it runs.`,
        `${verb} refused: run ${scope.status}`,
      );
    }
    const denied = consentRefusal(command, scope.guard);
    if (denied) return refuse(denied.message, denied.detail);
    const payload: DesktopToolsPayload = await options.broker.execute({
      agentId,
      guard: scope.guard,
      command,
      // `wait` may block up to 10 s inside the app.
      ...(verb === "wait" || verb === "secrets_scan" ? { timeoutMs: 30_000 } : {}),
    });
    if (!payload.ok) {
      await options.attack.recordDesktopAction({
        runId: scope.runId,
        agentId,
        verb,
        outcome: { refused: `${verb} ${payload.error.code}${refusedDetail}` },
      });
      return refusal(`Desktop ${verb} failed (${payload.error.code}): ${payload.error.message}`);
    }
    const result = payload.result;
    // The audit holds the verb, role and label, never typed text or element contents.
    await options.attack.recordDesktopAction({
      runId: scope.runId,
      agentId,
      verb,
      outcome: { ok: auditFacts(command, result) },
    });
    const base =
      result.command === "network"
        ? describeNetwork(result, scope.guard.win?.exeName)
        : describe(result, verb);
    const shot = "screenshot" in result ? result.screenshot : undefined;
    if (!shot) return base;
    return { ...base, content: [...base.content, ...screenshotContent(shot)] };
  };

  options.registerTool(
    "desktop_snapshot",
    {
      title: "Snapshot desktop window",
      description: `Read the accessibility tree of the one desktop window this Attack run drives. Lines carry refs (@d12 on Windows, [0/2/1] paths on macOS) that desktop_click, desktop_type and the other tools take. ${REFS} Re-snapshot after the window changes: refs go stale (stale_ref). Set interactiveOnly for a short list of controls, root to expand one subtree. A window whose tree quality is "none" (many games and custom-drawn UIs) has no refs: use desktop_screenshot with grid: true and click coordinates instead. Only for runs with a desktop target.`,
      inputSchema: {
        interactiveOnly: z.boolean().optional(),
        root: ELEMENT_FIELD,
        maxNodes: z.number().int().min(20).max(2000).optional(),
      },
    },
    ({ interactiveOnly, root, maxNodes }) =>
      run({
        command: "snapshot",
        args: {
          ...(interactiveOnly !== undefined ? { interactiveOnly } : {}),
          ...(root !== undefined ? { root } : {}),
          ...(maxNodes !== undefined ? { maxNodes } : {}),
        },
      }),
  );
  options.registerTool(
    "desktop_screenshot",
    {
      title: "Screenshot desktop window",
      description: `Capture a PNG of the one desktop window this Attack run drives. ${COORDINATES} marks: true draws a numbered box on every interactive element (number N is ref @dN, listed in the legend). grid: true draws labelled lines every 100 pixels, for windows with no accessibility tree. region crops to a rectangle of the current image at native resolution, to read small text. maxEdge caps the longest side (256 to 1920, default 1280). If the result says suspectBlank, the capture may be stale. Only for runs with a desktop target.`,
      inputSchema: {
        maxEdge: z.number().int().min(256).max(1920).optional(),
        marks: z.boolean().optional(),
        grid: z.boolean().optional(),
        region: z
          .object({
            x: z.number().min(0),
            y: z.number().min(0),
            width: z.number().positive(),
            height: z.number().positive(),
          })
          .optional(),
      },
    },
    ({ maxEdge, marks, grid, region }) =>
      run({
        command: "screenshot",
        args: {
          ...(maxEdge !== undefined ? { maxEdge } : {}),
          ...(marks !== undefined ? { marks } : {}),
          ...(grid !== undefined ? { grid } : {}),
          ...(region !== undefined ? { region } : {}),
        },
      }),
  );
  options.registerTool(
    "desktop_click",
    {
      title: "Click in desktop window",
      description: `Click an element or a point of the desktop window. ${REFS} ${COORDINATES} Points outside the window are refused. button, count (2 for a double click) and modifiers are optional; via "pattern" activates the element through accessibility instead of the mouse. The result says whether the window changed and whether focus left the window. Needs the owner's desktop input consent for the run.`,
      inputSchema: {
        element: ELEMENT_FIELD,
        x: z.number().optional(),
        y: z.number().optional(),
        button: BUTTON_FIELD,
        count: z.number().int().min(1).max(3).optional(),
        modifiers: MODIFIERS_FIELD,
        via: z.enum(["auto", "input", "pattern"]).optional(),
        screenshotAfter: SCREENSHOT_AFTER_FIELD,
      },
    },
    ({ element, x, y, button, count, modifiers, via, screenshotAfter }) => {
      const target = pointOrElement(element, x, y);
      if (!target) return Promise.resolve(refusal("Pass an element ref, or both x and y."));
      return run({
        command: "click",
        args: {
          ...target,
          ...(button ? { button } : {}),
          ...(count ? { count } : {}),
          ...(modifiers ? { modifiers } : {}),
          ...(via ? { via } : {}),
          ...(screenshotAfter ? { screenshotAfter } : {}),
        },
      });
    },
  );
  options.registerTool(
    "desktop_type",
    {
      title: "Type into desktop window",
      description: `Type text into the desktop window this run drives. The window is brought to the front first. With element, that field is focused first (${REFS}); without it the text goes to the focused field. mode: "unicode" (default) sends characters, "scancode" sends real key presses (for games and apps that ignore synthetic text), "set" sets the field's value directly. clear replaces the existing text; submit presses Enter after. Needs the owner's desktop input consent for the run.`,
      inputSchema: {
        text: z.string().min(1).max(2000),
        element: ELEMENT_FIELD,
        mode: z.enum(["unicode", "scancode", "set"]).optional(),
        clear: z.boolean().optional(),
        submit: z.boolean().optional(),
        screenshotAfter: SCREENSHOT_AFTER_FIELD,
      },
    },
    ({ text, element, mode, clear, submit, screenshotAfter }) =>
      run({
        command: "type",
        args: {
          text,
          ...(element ? { element } : {}),
          ...(mode ? { mode } : {}),
          ...(clear !== undefined ? { clear } : {}),
          ...(submit !== undefined ? { submit } : {}),
          ...(screenshotAfter ? { screenshotAfter } : {}),
        },
      }),
  );
  options.registerTool(
    "desktop_key",
    {
      title: "Press a key in desktop window",
      description:
        'Press a key or chord in the desktop window this run drives, for example "return", "tab", "ctrl+s", "shift+tab" (macOS: "cmd+s"). keys holds several keys down together (["w","shift"]). holdMs keeps the key down, which games need for movement (hold "w" for 800 ms to walk forward). repeat presses it several times. action "down" or "up" holds or releases a key across calls; held keys are released after 5 seconds. System chords are refused and recorded: switching apps, closing, quitting, the Windows key, alt+f4, ctrl+alt chords. Needs the owner\'s desktop input consent for the run.',
      inputSchema: {
        chord: z.string().min(1).max(60).optional(),
        keys: z.array(z.string().min(1).max(30)).min(1).max(6).optional(),
        holdMs: z.number().int().min(0).max(5000).optional(),
        repeat: z.number().int().min(1).max(20).optional(),
        action: z.enum(["press", "down", "up"]).optional(),
        screenshotAfter: SCREENSHOT_AFTER_FIELD,
      },
    },
    ({ chord, keys, holdMs, repeat, action, screenshotAfter }) => {
      if (chord === undefined && keys === undefined) {
        return Promise.resolve(refusal("Pass a chord or keys."));
      }
      const detail = (chord ?? keys?.join("+") ?? "")
        .replace(/[^\w+\-`.,;'/[\]\\=]/g, "")
        .slice(0, 40);
      return run(
        {
          command: "key",
          args: {
            ...(chord !== undefined ? { chord } : {}),
            ...(keys !== undefined ? { keys } : {}),
            ...(holdMs !== undefined ? { holdMs } : {}),
            ...(repeat !== undefined ? { repeat } : {}),
            ...(action ? { action } : {}),
            ...(screenshotAfter ? { screenshotAfter } : {}),
          },
        },
        ` ${detail}`,
      );
    },
  );
  options.registerTool(
    "desktop_scroll",
    {
      title: "Scroll in desktop window",
      description: `Scroll the mouse wheel over an element or point of the desktop window (default: the window centre). dy is in wheel notches, positive scrolls down; dx positive scrolls right. ${REFS} ${COORDINATES} Needs the owner's desktop input consent for the run.`,
      inputSchema: {
        element: ELEMENT_FIELD,
        x: z.number().optional(),
        y: z.number().optional(),
        dx: z.number().int().min(-30).max(30).optional(),
        dy: z.number().int().min(-30).max(30).optional(),
        screenshotAfter: SCREENSHOT_AFTER_FIELD,
      },
    },
    ({ element, x, y, dx, dy, screenshotAfter }) => {
      const target = pointOrElement(element, x, y) ?? {};
      return run({
        command: "scroll",
        args: {
          ...target,
          ...(dx !== undefined ? { dx } : {}),
          ...(dy !== undefined ? { dy } : {}),
          ...(screenshotAfter ? { screenshotAfter } : {}),
        },
      });
    },
  );
  options.registerTool(
    "desktop_drag",
    {
      title: "Drag in desktop window",
      description: `Press at one element or point, move to another and release: sliders, drag and drop, selection, resizing. ${REFS} ${COORDINATES} Give each end as an element or as x and y. Needs the owner's desktop input consent for the run.`,
      inputSchema: {
        fromElement: ELEMENT_FIELD,
        fromX: z.number().optional(),
        fromY: z.number().optional(),
        toElement: ELEMENT_FIELD,
        toX: z.number().optional(),
        toY: z.number().optional(),
        button: BUTTON_FIELD,
        durationMs: z.number().int().min(100).max(3000).optional(),
        modifiers: MODIFIERS_FIELD,
        screenshotAfter: SCREENSHOT_AFTER_FIELD,
      },
    },
    ({
      fromElement,
      fromX,
      fromY,
      toElement,
      toX,
      toY,
      button,
      durationMs,
      modifiers,
      screenshotAfter,
    }) => {
      const from = pointOrElement(fromElement, fromX, fromY);
      const to = pointOrElement(toElement, toX, toY);
      if (!from || !to) {
        return Promise.resolve(refusal("Give both ends: an element, or x and y, for from and to."));
      }
      return run({
        command: "drag",
        args: {
          from,
          to,
          ...(button ? { button } : {}),
          ...(durationMs ? { durationMs } : {}),
          ...(modifiers ? { modifiers } : {}),
          ...(screenshotAfter ? { screenshotAfter } : {}),
        },
      });
    },
  );
  options.registerTool(
    "desktop_hover",
    {
      title: "Hover in desktop window",
      description: `Move the pointer over an element or point and wait there, to open tooltips and hover menus. ${REFS} ${COORDINATES} dwellMs is how long to stay (default 500). Needs the owner's desktop input consent for the run.`,
      inputSchema: {
        element: ELEMENT_FIELD,
        x: z.number().optional(),
        y: z.number().optional(),
        dwellMs: z.number().int().min(0).max(3000).optional(),
        screenshotAfter: SCREENSHOT_AFTER_FIELD,
      },
    },
    ({ element, x, y, dwellMs, screenshotAfter }) => {
      const target = pointOrElement(element, x, y);
      if (!target) return Promise.resolve(refusal("Pass an element ref, or both x and y."));
      return run({
        command: "hover",
        args: {
          ...target,
          ...(dwellMs !== undefined ? { dwellMs } : {}),
          ...(screenshotAfter ? { screenshotAfter } : {}),
        },
      });
    },
  );
  options.registerTool(
    "desktop_mouse",
    {
      title: "Low-level mouse in desktop window",
      description:
        'Low-level mouse control for games and canvases. action "down" or "up" holds or releases a button at the current pointer position; "move_rel" moves the pointer by dx, dy relative counts, which turns the camera in a game that captures the cursor (use small steps and take a screenshot to see the result). Use desktop_click and desktop_drag for ordinary UIs. Needs the owner\'s desktop input consent for the run.',
      inputSchema: {
        action: z.enum(["down", "up", "move_rel"]),
        button: BUTTON_FIELD,
        dx: z.number().int().min(-2000).max(2000).optional(),
        dy: z.number().int().min(-2000).max(2000).optional(),
        durationMs: z.number().int().min(0).max(3000).optional(),
        screenshotAfter: SCREENSHOT_AFTER_FIELD,
      },
    },
    ({ action, button, dx, dy, durationMs, screenshotAfter }) =>
      run({
        command: "mouse",
        args: {
          action,
          ...(button ? { button } : {}),
          ...(dx !== undefined ? { dx } : {}),
          ...(dy !== undefined ? { dy } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(screenshotAfter ? { screenshotAfter } : {}),
        },
      }),
  );
  options.registerTool(
    "desktop_wait",
    {
      title: "Wait in desktop window",
      description:
        'Wait instead of guessing a delay. ms sleeps up to 10 s. until: "stable" waits for the window to stop changing, "change" for it to change, "text" for text to appear in the accessibility tree (pass text), "gone" for an element to disappear (pass element). timeoutMs caps the wait (default 5000). Reads only: allowed without input consent.',
      inputSchema: {
        ms: z.number().int().min(0).max(10_000).optional(),
        until: z.enum(["stable", "change", "text", "gone"]).optional(),
        text: z.string().max(200).optional(),
        element: ELEMENT_FIELD,
        timeoutMs: z.number().int().min(100).max(10_000).optional(),
      },
    },
    ({ ms, until, text, element, timeoutMs }) =>
      run({
        command: "wait",
        args: {
          ...(ms !== undefined ? { ms } : {}),
          ...(until ? { until } : {}),
          ...(text !== undefined ? { text } : {}),
          ...(element ? { element } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        },
      }),
  );
  options.registerTool(
    "desktop_window",
    {
      title: "Desktop window state and layout",
      description:
        'Inspect or arrange the one window this run drives. action "state" reads its title, size, dpi, minimized, foreground and responding flags and the surfaces it owns (no input consent needed). "focus" brings it to the front, "restore" un-minimizes, "maximize" maximizes, "fit" moves it fully on screen, "resize" sets width and height in pixels (320 to 3840 by 240 to 2160): these need the owner\'s desktop input consent. There is no minimize or close.',
      inputSchema: {
        action: z.enum(["state", "focus", "restore", "maximize", "fit", "resize"]),
        width: z.number().int().min(320).max(3840).optional(),
        height: z.number().int().min(240).max(2160).optional(),
      },
    },
    ({ action, width, height }) => {
      if (action === "resize" && (width === undefined || height === undefined)) {
        return Promise.resolve(refusal("resize needs width and height."));
      }
      return run({
        command: "window",
        args: {
          action,
          ...(width !== undefined ? { width } : {}),
          ...(height !== undefined ? { height } : {}),
        },
      });
    },
  );
  options.registerTool(
    "desktop_find",
    {
      title: "Find desktop elements",
      description:
        "Search the window's accessibility tree for elements by name, a substring of the name, role or automation id. Each match comes back with a ref you can click or type into, which is cheaper than a full desktop_snapshot in a large window. At most limit matches (default 20).",
      inputSchema: {
        name: z.string().max(200).optional(),
        nameContains: z.string().max(200).optional(),
        role: z.string().max(60).optional(),
        automationId: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    ({ name, nameContains, role, automationId, limit }) => {
      if (!name && !nameContains && !role && !automationId) {
        return Promise.resolve(
          refusal("Pass at least one of name, nameContains, role, automationId."),
        );
      }
      return run({
        command: "find",
        args: {
          ...(name ? { name } : {}),
          ...(nameContains ? { nameContains } : {}),
          ...(role ? { role } : {}),
          ...(automationId ? { automationId } : {}),
          ...(limit ? { limit } : {}),
        },
      });
    },
  );
  options.registerTool(
    "desktop_element",
    {
      title: "Inspect desktop element",
      description: `Read everything accessibility knows about one element: properties, available patterns and their state. ${REFS} ${COORDINATES} text: true also reads up to 4000 characters of its text. Password fields are never read.`,
      inputSchema: {
        element: ELEMENT_FIELD,
        x: z.number().optional(),
        y: z.number().optional(),
        text: z.boolean().optional(),
      },
    },
    ({ element, x, y, text }) => {
      const target = pointOrElement(element, x, y);
      if (!target) return Promise.resolve(refusal("Pass an element ref, or both x and y."));
      return run({
        command: "element",
        args: { ...target, ...(text !== undefined ? { text } : {}) },
      });
    },
  );
  options.registerTool(
    "desktop_audit",
    {
      title: "Accessibility audit of desktop window",
      description:
        "Report accessibility defects of the window: focusable elements with no name, small click targets, clipped or offscreen controls, unnamed images, duplicate access keys, and the keyboard tab order. Worth running once on every main screen; confirm a defect with desktop_element before you file it.",
      inputSchema: {},
    },
    () => run({ command: "audit", args: {} }),
  );
  options.registerTool(
    "desktop_app",
    {
      title: "Desktop app status and relaunch",
      description:
        'Manage the process of the one app this run drives. action "status" reports running or exited (with the exit code), responding or hung, uptime, memory, handle counts and whether a crash dialog is up: call it when the window disappears or stops answering, and to watch for leaks. "launch" starts the app when it is not running; "relaunch" closes it and starts it again. Both start only the picked app with the arguments the owner typed, never anything else, and need the owner\'s launch consent for the run. If the app would not close, relaunch says so and does not kill it unless the target is disposable.',
      inputSchema: { action: z.enum(["status", "launch", "relaunch"]) },
    },
    ({ action }) => run({ command: "app", args: { action } }),
  );
  registerSecurityTools(options, run);
}

type RunDesktopCommand = (
  command: DesktopTargetCommand,
  refusedDetail?: string,
) => Promise<PimiToolResult>;

// The security tools read the target's own process, binary, install and data dirs, ports and
// traffic. They need the owner's allowDesktopInspect switch; desktop_deeplink and desktop_ipc
// probe are input and need input consent. Secret values are redacted before they leave the
// desktop app.
function registerSecurityTools(options: RegisterDesktopToolsOptions, run: RunDesktopCommand): void {
  options.registerTool(
    "desktop_inspect",
    {
      title: "Inspect desktop app security facts",
      description:
        'Read security facts about the one app this run drives: its process tree, binary and install footprint. section: "process" (pid tree, integrity level, elevation), "signature" (Authenticode state and signer), "mitigations" (ASLR, DEP, CFG per binary), "modules" (loaded modules with full path and whether the containing dir is writable, for DLL-hijack hunting), "ports" (listening endpoints and their bind address), "children" (child processes), "commandline" (the app\'s own arguments), "protocols" (custom URI schemes registered to the exe, for desktop_deeplink), "acls" (who can write the install and data dirs), "electron" (fuses, asar integrity, Electron and Chromium versions), "dotnet" (managed facts and insecure-deserialization signals), or "all" (default, time-boxed). Reads only: nothing is written, loaded or elevated. Needs the owner\'s security inspection consent for the run. Windows only.',
      inputSchema: {
        section: z.enum(DESKTOP_INSPECT_SECTIONS).optional(),
      },
    },
    ({ section }) => run({ command: "inspect", args: section ? { section } : {} }),
  );
  options.registerTool(
    "desktop_secrets_scan",
    {
      title: "Scan desktop app files for secrets",
      description:
        'Scan the app\'s own data and install dirs for secret-shaped content: dotenv and config files, connection strings, JWT and OAuth tokens, private keys, API-key patterns, high-entropy strings, and registry values under the app\'s key. Each hit is { where, kind, valuePrefix (at most 4 characters), valueLength }: the value itself is never returned, so quote only where, kind, prefix and length in a finding. Binary stores (LevelDB, SQLite, crash dumps) are reported as present, not dumped; DPAPI blobs are never decrypted. roots defaults to ["data","install"]; add "registry" for the app\'s HKCU\\Software key. include narrows by globs inside that scope (for example "**/*.json"). Confirm a hit is live with desktop_files before you call it a credential. Needs the owner\'s security inspection consent. Windows only.',
      inputSchema: {
        roots: z
          .array(z.enum(["data", "install", "registry"]))
          .max(3)
          .optional(),
        include: z.array(z.string().min(1).max(200)).max(10).optional(),
        maxFiles: z.number().int().min(1).max(5000).optional(),
        maxBytesPerFile: z.number().int().min(1).max(1_048_576).optional(),
      },
    },
    ({ roots, include, maxFiles, maxBytesPerFile }) =>
      run({
        command: "secrets_scan",
        args: {
          ...(roots ? { roots } : {}),
          ...(include ? { include } : {}),
          ...(maxFiles !== undefined ? { maxFiles } : {}),
          ...(maxBytesPerFile !== undefined ? { maxBytesPerFile } : {}),
        },
      }),
  );
  options.registerTool(
    "desktop_ipc",
    {
      title: "Inspect desktop app IPC",
      description:
        'Local IPC of the app. action "list" enumerates named pipes owned by the app\'s process tree with a DACL summary (flagging Everyone and Authenticated Users with write or full access) and its localhost listeners (needs the owner\'s security inspection consent). action "probe" sends one benign GET to http://127.0.0.1:<port><path> of a port the app itself owns, no auth and no body, response capped at 16 KB, 3 s timeout, plus one request with a foreign Host header to check DNS-rebinding protection (needs the owner\'s desktop input consent). Never another method, host or port. Windows only.',
      inputSchema: {
        action: z.enum(["list", "probe"]),
        port: z.number().int().min(1).max(65_535).optional(),
        path: z.string().max(200).optional(),
      },
    },
    ({ action, port, path }) => {
      if (action === "probe" && port === undefined) {
        return Promise.resolve(refusal("probe needs a port."));
      }
      return run({
        command: "ipc",
        args: {
          action,
          ...(port !== undefined ? { port } : {}),
          ...(path !== undefined ? { path } : {}),
        },
      });
    },
  );
  options.registerTool(
    "desktop_network",
    {
      title: "Desktop app network endpoints",
      description:
        "List the remote endpoints of the app's process tree right now (address, port, state, and PLAINTEXT for non-TLS ports), with what Pimi's Network monitor knows: the launch of the app when Pimi started it and DNS names the daemon saw. Also reports signals of disabled certificate validation (NODE_TLS_REJECT_UNAUTHORIZED=0, .NET callbacks that accept every certificate). Reads only; it intercepts nothing. Needs the owner's security inspection consent. Windows only.",
      inputSchema: {},
    },
    () => run({ command: "network", args: {} }),
  );
  options.registerTool(
    "desktop_deeplink",
    {
      title: "Send a deep link to the desktop app",
      description:
        "Invoke the app's own registered protocol with a payload you choose, to test how it handles the argument. The scheme must be one registered to the target exe (see desktop_inspect section \"protocols\"); a scheme routed to another app is refused. A payload that looks state-changing (not a bare navigation) is refused unless the owner marked the target disposable. The result says whether it launched, the handler, and whether focus left the window. Needs the owner's desktop input consent. Windows only.",
      inputSchema: { url: z.string().min(1).max(2000) },
    },
    ({ url }) => run({ command: "deeplink", args: { url } }),
  );
  options.registerTool(
    "desktop_files",
    {
      title: "Read desktop app files",
      description:
        'Read the app\'s own install and data dirs for config review, never anything else. action "list" lists a directory; "read" returns up to maxBytes (default 65536) of a text file. path is relative to a scope root, written root-name/relative/path (use list with an empty path to see the roots). Binary and oversized files are refused. Browser profiles, other apps\' data, Pimi and credential stores are always refused. Needs the owner\'s security inspection consent. Windows only.',
      inputSchema: {
        action: z.enum(["list", "read"]),
        path: z.string().max(400),
        maxBytes: z.number().int().min(1).max(262_144).optional(),
      },
    },
    ({ action, path, maxBytes }) =>
      run({
        command: "files",
        args: { action, path, ...(maxBytes !== undefined ? { maxBytes } : {}) },
      }),
  );
}
/** Registers the tools only where Attack mode and the desktop broker are both wired. */
export function registerDesktopToolsWhenWired(
  options: Omit<RegisterDesktopToolsOptions, "broker" | "attack"> & {
    broker?: RegisterDesktopToolsOptions["broker"] | null;
    attack?: RegisterDesktopToolsOptions["attack"] | null;
  },
): void {
  const { broker, attack, ...rest } = options;
  if (broker && attack) registerDesktopTools({ ...rest, broker, attack });
}
