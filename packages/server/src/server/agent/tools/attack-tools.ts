import { z } from "zod";
import { FindingCategorySchema, FindingSeveritySchema } from "@pimi/protocol/attack/types";
import type { FindingEvidence } from "@pimi/protocol/attack/types";
import { BrowserAutomationBrowserIdSchema } from "@pimi/protocol/browser-automation/rpc-schemas";
import type { BrowserToolsBroker } from "../../browser-tools/broker.js";
import type { AttackService } from "../../attack/service.js";
import {
  PaseoToolInputError,
  type PaseoToolConfig,
  type PaseoToolExecutionContext,
  type PaseoToolResult,
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
});

const FinishInput = z.object({
  summary: z.string().trim().min(1).max(4000).describe("What the run covered and what it found."),
});

export interface RegisterAttackToolsOptions {
  registerTool: (
    name: string,
    config: PaseoToolConfig,
    handler: (input: unknown, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>,
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
    throw new PaseoToolInputError("This tool is only for agents inside an Attack run.");
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
      throw new PaseoToolInputError(
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
        "Record a verified defect found during an Attack run. Only call it after you reproduced the problem yourself; include numbered repro steps and evidence. Findings are deduplicated by route, category and title: reporting the same problem again raises its count. Only agents inside an Attack run can use it.",
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
      const { finding, deduped } = await options.service.submitFinding(agentId, {
        severity: parsed.severity,
        category: parsed.category,
        title: parsed.title,
        route: parsed.route,
        description: parsed.description,
        repro: parsed.repro,
        evidence: [...parsed.evidence, ...screenshots],
      });
      const text = deduped
        ? `Already recorded as finding ${finding.id}; its report count is now ${finding.reportCount}.`
        : `Recorded finding ${finding.id}.`;
      return {
        content: [{ type: "text", text }],
        structuredContent: { findingId: finding.id, deduped, reportCount: finding.reportCount },
      };
    },
  );

  options.registerTool(
    "finish_attack_run",
    {
      title: "Finish Attack run",
      description:
        'Lead only: mark the Attack run complete once the roster has finished and the findings stand. "Nothing found" is a valid summary.',
      inputSchema: FinishInput,
    },
    async (input) => {
      const agentId = requireCaller(options);
      FinishInput.parse(input);
      const run = await options.service.runForAgent(agentId);
      if (!run) throw new PaseoToolInputError("This agent is not part of an Attack run.");
      const completed = await options.service.completeRun(run.id, agentId);
      return {
        content: [{ type: "text", text: `The run is ${completed.status}.` }],
        structuredContent: { runId: completed.id, status: completed.status },
      };
    },
  );
}
