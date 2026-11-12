import { z } from "zod";
import type { DesktopTargetCommand } from "@pimi/protocol/desktop-target/rpc-schemas";
import type { AttackService } from "../attack/service.js";
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

type Verb = "snapshot" | "click" | "type" | "key" | "screenshot";
const INPUT_VERBS: ReadonlySet<Verb> = new Set(["click", "type", "key"]);

function refusal(text: string): PimiToolResult {
  return { content: [{ type: "text", text }], structuredContent: { ok: false }, isError: true };
}

/**
 * The desktop_* tools of an Attack run that drives a desktop window. The guard (which window,
 * whether input is allowed) is built here from the run, never from tool input, and the desktop
 * app checks it again on every call.
 */
export function registerDesktopTools(options: RegisterDesktopToolsOptions): void {
  const run = async (
    verb: Verb,
    command: DesktopTargetCommand,
    refusedDetail: string,
  ): Promise<PimiToolResult> => {
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
    if (INPUT_VERBS.has(verb) && !scope.guard.allowInput) {
      return refuse(
        "The owner did not allow desktop input for this run. Clicking, typing and keys are off; snapshot and screenshot still work.",
        `${verb} refused: input not allowed`,
      );
    }
    const payload: DesktopToolsPayload = await options.broker.execute({
      agentId,
      guard: scope.guard,
      command,
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
    await options.attack.recordDesktopAction({
      runId: scope.runId,
      agentId,
      verb,
      outcome: {
        ok: {
          role: result.command === "click" ? result.role : null,
          label: result.command === "click" ? result.label : null,
          point: result.command === "click" ? result.point : null,
        },
      },
    });
    switch (result.command) {
      case "snapshot":
        return {
          content: [
            {
              type: "text",
              text: `${result.tree}${result.truncated ? "\n(tree truncated: depth 12, 400 nodes)" : ""}`,
            },
          ],
          structuredContent: { ok: true, truncated: result.truncated },
        };
      case "screenshot":
        return {
          content: [
            { type: "text", text: `Window screenshot, ${result.width}x${result.height}.` },
            { type: "image", data: result.dataBase64, mimeType: result.mimeType },
          ],
          structuredContent: { ok: true, width: result.width, height: result.height },
        };
      case "click":
        return {
          content: [
            {
              type: "text",
              text: `Clicked ${result.role ?? "element"}${result.label ? ` "${result.label}"` : ""}.`,
            },
          ],
          structuredContent: { ok: true },
        };
      default:
        return {
          content: [{ type: "text", text: `Desktop ${verb} done.` }],
          structuredContent: { ok: true },
        };
    }
  };

  options.registerTool(
    "desktop_snapshot",
    {
      title: "Snapshot desktop window",
      description:
        "Read the accessibility tree of the one desktop window this Attack run drives. Each line starts with an element path in brackets, such as [0/2/1], that desktop_click takes. Re-snapshot after the window changes: paths are positions, not stable ids. Only for runs with a desktop target.",
      inputSchema: {},
    },
    () => run("snapshot", { command: "snapshot", args: {} }, ""),
  );
  options.registerTool(
    "desktop_screenshot",
    {
      title: "Screenshot desktop window",
      description:
        "Capture a PNG of the one desktop window this Attack run drives. Only for runs with a desktop target.",
      inputSchema: { maxWidth: z.number().int().min(64).max(1280).optional() },
    },
    ({ maxWidth }) =>
      run("screenshot", { command: "screenshot", args: maxWidth ? { maxWidth } : {} }, ""),
  );
  options.registerTool(
    "desktop_click",
    {
      title: "Click in desktop window",
      description:
        "Click an element of the desktop window by its path from desktop_snapshot, or a point (x, y in pixels from the window's top left). Points outside the window are refused. Needs the owner's desktop input consent for the run.",
      inputSchema: {
        element: z.string().min(1).max(500).optional(),
        x: z.number().optional(),
        y: z.number().optional(),
      },
    },
    ({ element, x, y }) => {
      if (element === undefined && (x === undefined || y === undefined)) {
        return Promise.resolve(refusal("Pass an element path, or both x and y."));
      }
      return run(
        "click",
        {
          command: "click",
          args: element !== undefined ? { element } : { point: { x: x as number, y: y as number } },
        },
        "",
      );
    },
  );
  options.registerTool(
    "desktop_type",
    {
      title: "Type into desktop window",
      description:
        "Type text into the desktop window this run drives. The window is brought to the front first; the text goes to its focused field. Needs the owner's desktop input consent for the run.",
      inputSchema: { text: z.string().min(1).max(2000) },
    },
    ({ text }) => run("type", { command: "type", args: { text } }, ""),
  );
  options.registerTool(
    "desktop_key",
    {
      title: "Press a key in desktop window",
      description:
        'Press a key or chord in the desktop window this run drives, for example "return", "tab", "cmd+s", "shift+tab". System chords (switching apps, quitting, hiding, screenshots) are refused and recorded. Needs the owner\'s desktop input consent for the run.',
      inputSchema: { chord: z.string().min(1).max(60) },
    },
    ({ chord }) =>
      run(
        "key",
        { command: "key", args: { chord } },
        ` ${chord.replace(/[^\w+\-`.,;'/[\]\\=]/g, "").slice(0, 40)}`,
      ),
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
