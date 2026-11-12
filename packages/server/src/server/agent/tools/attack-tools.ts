import { z } from "zod";
import { FindingCategorySchema, FindingSeveritySchema } from "@pimi/protocol/attack/types";
import type { FindingEvidence } from "@pimi/protocol/attack/types";
import { BrowserAutomationBrowserIdSchema } from "@pimi/protocol/browser-automation/rpc-schemas";
import type { BrowserToolsBroker } from "../../browser-tools/broker.js";
import { findingLine } from "../../attack/prompts.js";
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
  resolveCallerAgent: () => { id: string; cwd: string; workspaceId?: string } | null;
}

type ActiveOptions = RegisterAttackToolsOptions & { service: AttackService };

function requireCaller(options: ActiveOptions): string {
  if (!options.callerAgentId) {
    throw new PimiToolInputError("This tool is only for agents inside an Attack run.");
  }
  return options.callerAgentId;
}

async function captureScreenshots(
  options: ActiveOptions,
  agentId: string,
  browserIds: readonly string[],
  title: string,
): Promise<FindingEvidence[]> {
  const evidence: FindingEvidence[] = [];
  const caller = options.resolveCallerAgent();
  if (!options.broker || !caller) return evidence;
  for (const browserId of browserIds) {
    const payload = await options.broker.execute({
      agentId,
      cwd: caller.cwd,
      ...(caller.workspaceId ? { workspaceId: caller.workspaceId } : {}),
      command: { command: "screenshot", args: { browserId, fullPage: false } },
    });
    if (!payload.ok || payload.result.command !== "screenshot") {
      throw new PimiToolInputError(
        `Could not capture a screenshot of ${browserId}: ${payload.ok ? "unexpected result" : payload.error.message}`,
      );
    }
    evidence.push(
      options.service.screenshotEvidence({
        caption: `Screenshot: ${title}`,
        dataBase64: payload.result.dataBase64,
        width: payload.result.width,
        height: payload.result.height,
      }),
    );
  }
  return evidence;
}

// Only agents can use these tools, and only where the daemon runs Attack mode.
export function registerAttackTools(base: RegisterAttackToolsOptions): void {
  const { service } = base;
  if (!service || base.scope !== "agent") return;
  const options: ActiveOptions = {
    ...base,
    service,
    broker: base.browserToolsEnabled ? base.broker : null,
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
      const screenshots = await captureScreenshots(
        options,
        agentId,
        parsed.screenshotBrowserIds,
        parsed.title,
      );
      const result = await options.service.submitFinding(agentId, {
        severity: parsed.severity,
        category: parsed.category,
        title: parsed.title,
        route: parsed.route,
        description: parsed.description,
        repro: parsed.repro,
        evidence: [...parsed.evidence, ...screenshots],
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
      const text =
        result.outcome === "merged"
          ? `Merged into finding ${finding.id} ("${finding.title}"); it now stands for ${finding.reportCount} reports.`
          : `Recorded finding ${finding.id}.`;
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
