import { z } from "zod";
import { FindingCategorySchema, FindingSeveritySchema } from "@pimi/protocol/attack/types";
import type { FindingEvidence } from "@pimi/protocol/attack/types";
import { BrowserAutomationBrowserIdSchema } from "@pimi/protocol/browser-automation/rpc-schemas";
import type { BrowserToolsBroker } from "../../browser-tools/broker.js";
import type { DesktopToolsBroker } from "../../desktop-tools/broker.js";
import { findingLine } from "../../attack/prompts.js";
import { registerAttackAnnotationTools } from "./attack-annotation-tools.js";
import type { AttackService } from "../../attack/service.js";
import {
  PimiToolInputError,
  type PimiToolConfig,
  type PimiToolExecutionContext,
  type PimiToolResult,
} from "./types.js";

const TextEvidenceSchema = z.object({
  kind: z.enum(["terminal", "note"]),
  caption: z.string().min(1).max(300),
  excerpt: z.string().min(1).max(4000),
});

const SubmitFindingInput = z.object({
  severity: FindingSeveritySchema.describe(
    "blocker: wrong results, data loss, a security hole or a crash on a path users hit. major: wrong behaviour on a realistic but less common path. minor: a real defect with small impact.",
  ),
  category: FindingCategorySchema,
  title: z
    .string()
    .trim()
    .min(3)
    .max(200)
    .describe("One line naming the defect, without the route."),
  route: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe(
      "The page route or repository file the defect is on, for example /signup or src/config.js.",
    ),
  description: z.string().trim().min(1).max(4000).describe("What goes wrong and why it matters."),
  repro: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .describe("Numbered steps, with the exact input, that reproduce it from a fresh page load."),
  evidence: z.array(TextEvidenceSchema).max(5).default([]),
  screenshotBrowserIds: z
    .array(BrowserAutomationBrowserIdSchema)
    .max(2)
    .default([])
    .describe(
      "Browser tabs to capture as screenshot evidence right now. Show the defect on screen first.",
    ),
  desktopScreenshot: z
    .boolean()
    .default(false)
    .describe(
      "true to attach a fresh screenshot of this run's desktop window as evidence. Show the defect in the window first. Only for runs with a desktop target.",
    ),
  desktopHighlight: z
    .object({
      x: z.number().min(0),
      y: z.number().min(0),
      width: z.number().positive(),
      height: z.number().positive(),
    })
    .optional()
    .describe(
      "A rectangle in pixels of your latest desktop_screenshot that shows the defect; it is recorded in the evidence caption. Used with desktopScreenshot.",
    ),
  annotationLabels: z
    .array(z.string().trim().min(1).max(16))
    .max(40)
    .default([])
    .describe(
      'Labels such as "A1" of the owner annotations this finding is about. Required when you found it by testing an annotation.',
    ),
  duplicateOf: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "The id of an existing finding that is the same underlying defect as this report, even if it was worded differently or reached by another route. Your evidence is added to that finding.",
    ),
  distinct: z
    .boolean()
    .optional()
    .describe(
      "true once you have read the existing findings submit_finding listed and this report is none of them.",
    ),
});

const FinishInput = z.object({
  summary: z.string().trim().min(1).max(4000).describe("What the run covered and what it found."),
  merges: z
    .array(
      z.object({
        duplicate: z.string().trim().min(1).describe("The finding id to fold away."),
        into: z.string().trim().min(1).describe("The finding id that keeps it."),
      }),
    )
    .max(200)
    .optional()
    .describe(
      "Your duplicate review: each pair of findings that are one underlying defect. Pass an empty list when every finding is distinct. Omit it on the first call to see the findings.",
    ),
});

export interface RegisterAttackToolsOptions {
  registerTool: (
    name: string,
    config: PimiToolConfig,
    handler: (input: unknown, context: PimiToolExecutionContext) => Promise<PimiToolResult>,
  ) => void;
  scope: "agent" | "top-level";
  service?: AttackService | null;
  callerAgentId?: string;
  browserToolsEnabled?: boolean;
  broker?: Pick<BrowserToolsBroker, "execute"> | null;
  desktopBroker?: Pick<DesktopToolsBroker, "execute"> | null;
  resolveCallerAgent: () => { id: string; cwd: string; workspaceId?: string } | null;
}

type ActiveOptions = RegisterAttackToolsOptions & { service: AttackService };

function requireCaller(options: ActiveOptions): string {
  if (!options.callerAgentId) {
    throw new PimiToolInputError("This tool is only for agents inside an Attack run.");
  }
  return options.callerAgentId;
}

// Evidence is shot at 1280 px wide (a retina viewport is 2560); a page whose PNG is still over the
// size cap is shot again at 640. A failed capture is tried once more, then the finding is recorded
// with a note saying why there is no image, and the tool result tells the agent.
const EVIDENCE_WIDTHS = [1280, 640] as const;
const CAPTURE_RETRY_DELAY_MS = 400;

type CaptureOutcome = { evidence: FindingEvidence } | { failure: string };

async function captureOne(
  options: ActiveOptions,
  agentId: string,
  caller: { cwd: string; workspaceId?: string },
  browserId: string,
  title: string,
): Promise<CaptureOutcome> {
  let failure = "unknown";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, CAPTURE_RETRY_DELAY_MS));
    for (const width of EVIDENCE_WIDTHS) {
      let payload: Awaited<ReturnType<NonNullable<ActiveOptions["broker"]>["execute"]>>;
      try {
        payload = await options.broker!.execute({
          agentId,
          cwd: caller.cwd,
          ...(caller.workspaceId ? { workspaceId: caller.workspaceId } : {}),
          command: {
            command: "screenshot",
            args: { browserId, fullPage: false, thumbnailWidth: width },
          },
        });
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        break;
      }
      if (!payload.ok) {
        failure = payload.error.code;
        break;
      }
      if (payload.result.command !== "screenshot") {
        failure = "unexpected_result";
        break;
      }
      const evidence = options.service.screenshotEvidence({
        caption: `Screenshot: ${title}`,
        dataBase64: payload.result.dataBase64,
        width: payload.result.width,
        height: payload.result.height,
      });
      if (evidence) return { evidence };
      failure = "too_large";
    }
    // A page too large even at the narrowest width will not shrink on a retry.
    if (failure === "too_large") break;
  }
  return { failure };
}

async function captureScreenshots(
  options: ActiveOptions,
  agentId: string,
  browserIds: readonly string[],
  title: string,
): Promise<{ evidence: FindingEvidence[]; failures: string[] }> {
  const evidence: FindingEvidence[] = [];
  const failures: string[] = [];
  const caller = options.resolveCallerAgent();
  if (!options.broker || !caller) return { evidence, failures };
  for (const browserId of browserIds) {
    const outcome = await captureOne(options, agentId, caller, browserId, title);
    if ("evidence" in outcome) {
      evidence.push(outcome.evidence);
      continue;
    }
    failures.push(`${browserId}: ${outcome.failure}`);
    evidence.push({
      kind: "note",
      caption: "Screenshot failed",
      excerpt: `Screenshot of ${browserId} failed: ${outcome.failure}`,
    });
  }
  return { evidence, failures };
}

async function captureDesktop(
  options: ActiveOptions,
  agentId: string,
  title: string,
  highlight: { x: number; y: number; width: number; height: number } | undefined,
): Promise<{ evidence: FindingEvidence; failure: string | null }> {
  const fail = (reason: string) => ({
    evidence: {
      kind: "note" as const,
      caption: "Desktop screenshot failed",
      excerpt: `Desktop screenshot failed: ${reason}`,
    },
    failure: reason,
  });
  if (!options.desktopBroker) return fail("no desktop app is connected");
  const scope = await options.service.desktopGuardForAgent(agentId);
  if (!scope) return fail("this run has no desktop target");
  const box = highlight
    ? ` Highlight: x=${Math.round(highlight.x)}, y=${Math.round(highlight.y)}, ${Math.round(highlight.width)}x${Math.round(highlight.height)} px of the image.`
    : "";
  let reason = "unknown";
  for (const maxEdge of [1280, 640]) {
    let payload: Awaited<ReturnType<NonNullable<ActiveOptions["desktopBroker"]>["execute"]>>;
    try {
      payload = await options.desktopBroker.execute({
        agentId,
        guard: scope.guard,
        command: { command: "screenshot", args: { maxEdge } },
      });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    if (!payload.ok) return fail(payload.error.code);
    if (payload.result.command !== "screenshot") return fail("unexpected_result");
    const evidence = options.service.screenshotEvidence({
      caption: `Desktop screenshot: ${title}.${box}`,
      dataBase64: payload.result.dataBase64,
      width: payload.result.width,
      height: payload.result.height,
    });
    if (evidence) return { evidence, failure: null };
    reason = "too_large";
  }
  return fail(reason);
}

// Only agents can use these tools, and only where the daemon runs Attack mode.
export function registerAttackTools(base: RegisterAttackToolsOptions): void {
  const { service } = base;
  if (!service || base.scope !== "agent") return;
  const options: ActiveOptions = {
    ...base,
    service,
    broker: base.browserToolsEnabled ? base.broker : null,
    desktopBroker: base.desktopBroker ?? null,
  };
  options.registerTool(
    "submit_finding",
    {
      title: "Submit finding",
      description:
        "Record a verified defect found during an Attack run. Only call it after you reproduced the problem yourself; include numbered repro steps and evidence. One underlying defect is one finding: when the run already has findings, the first call records nothing and lists them. Call again with duplicateOf set to the id of the finding this repeats, or with distinct: true if it is a different defect. Only agents inside an Attack run can use it.",
      inputSchema: SubmitFindingInput,
    },
    async (input) => {
      const agentId = requireCaller(options);
      const parsed = SubmitFindingInput.parse(input);
      const { evidence: screenshots, failures: screenshotFailures } = await captureScreenshots(
        options,
        agentId,
        parsed.screenshotBrowserIds,
        parsed.title,
      );
      if (parsed.desktopScreenshot) {
        const shot = await captureDesktop(options, agentId, parsed.title, parsed.desktopHighlight);
        screenshots.push(shot.evidence);
        if (shot.failure) screenshotFailures.push(`desktop: ${shot.failure}`);
      }
      const result = await options.service.submitFinding(agentId, {
        severity: parsed.severity,
        category: parsed.category,
        title: parsed.title,
        route: parsed.route,
        description: parsed.description,
        repro: parsed.repro,
        evidence: [...parsed.evidence, ...screenshots],
        annotationLabels: parsed.annotationLabels,
        duplicateOf: parsed.duplicateOf,
        distinct: parsed.distinct,
      });
      if (result.outcome === "review") {
        const text = `Not recorded yet. This run already has these findings:\n${result.existing.map(findingLine).join("\n")}\n\nIf your report is the same underlying defect as one of them (same cause, even with other wording, another route to it or another agent's angle), call submit_finding again with the same fields plus duplicateOf: "<that id>". If it is a different defect, call again with the same fields plus distinct: true.`;
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            recorded: false,
            existingFindings: result.existing.map((finding) => ({
              id: finding.id,
              severity: finding.severity,
              category: finding.category,
              route: finding.route,
              title: finding.title,
            })),
          },
        };
      }
      const { finding } = result;
      const recorded =
        result.outcome === "merged"
          ? `Merged into finding ${finding.id} ("${finding.title}"); it now stands for ${finding.reportCount} reports.`
          : `Recorded finding ${finding.id}.`;
      const text =
        screenshotFailures.length > 0
          ? `${recorded} The finding has no screenshot (${screenshotFailures.join("; ")}); a note says so.`
          : recorded;
      return {
        content: [{ type: "text", text }],
        structuredContent: {
          recorded: true,
          findingId: finding.id,
          merged: result.outcome === "merged",
          reportCount: finding.reportCount,
        },
      };
    },
  );

  registerAttackAnnotationTools({
    registerTool: options.registerTool,
    service: options.service,
    callerAgentId: options.callerAgentId,
  });

  options.registerTool(
    "finish_attack_run",
    {
      title: "Finish Attack run",
      description:
        'Lead only: mark the Attack run complete once the roster has finished and the findings stand. With two or more findings, the first call lists them and ends nothing: review them for duplicates and call again with merges (an empty list when all are distinct). "Nothing found" is a valid summary.',
      inputSchema: FinishInput,
    },
    async (input) => {
      const agentId = requireCaller(options);
      const parsed = FinishInput.parse(input);
      const run = await options.service.runForAgent(agentId);
      if (!run) throw new PimiToolInputError("This agent is not part of an Attack run.");
      const { run: completed, review } = await options.service.completeRun(
        run.id,
        agentId,
        parsed.merges,
      );
      if (review) {
        const text = `Not finished yet. Review these findings for duplicates first:\n${review.map(findingLine).join("\n")}\n\nTwo findings are duplicates when fixing one underlying defect would close both. Call finish_attack_run again with merges: [{ duplicate: "<id to fold away>", into: "<id that keeps it>" }] for each such pair, or merges: [] if every finding is distinct.`;
        return {
          content: [{ type: "text", text }],
          structuredContent: { runId: completed.id, status: completed.status, finished: false },
        };
      }
      return {
        content: [{ type: "text", text: `The run is ${completed.status}.` }],
        structuredContent: { runId: completed.id, status: completed.status },
      };
    },
  );
}
