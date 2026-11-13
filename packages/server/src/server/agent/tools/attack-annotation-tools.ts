import { z } from "zod";
import type { AttackService } from "../../attack/service.js";
import {
  PimiToolInputError,
  type PimiToolConfig,
  type PimiToolExecutionContext,
  type PimiToolResult,
} from "./types.js";

const LabelInput = z.object({
  label: z.string().trim().min(1).max(16).describe('The annotation label, for example "A1".'),
});

const ResultInput = LabelInput.extend({
  result: z
    .enum(["clean", "not_testable"])
    .describe(
      "clean: you or a subagent tested it and it held. not_testable: it could not be tested here, for example the element needs data or a state the run cannot reach.",
    ),
  note: z.string().trim().min(1).max(1000).describe("What was tried, or why it could not be."),
});

interface RegisterAttackAnnotationToolsOptions {
  registerTool: (
    name: string,
    config: PimiToolConfig,
    handler: (input: unknown, context: PimiToolExecutionContext) => Promise<PimiToolResult>,
  ) => void;
  service: AttackService;
  callerAgentId?: string;
}

function requireCaller(options: RegisterAttackAnnotationToolsOptions): string {
  if (!options.callerAgentId) {
    throw new PimiToolInputError("This tool is only for agents inside an Attack run.");
  }
  return options.callerAgentId;
}

async function asInputError<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Error && error.name === "AttackStateError") {
      throw new PimiToolInputError(error.message);
    }
    throw error;
  }
}

// The owner's pre-flight notes: what the owner marked, as text plus the element's screenshot.
export function registerAttackAnnotationTools(options: RegisterAttackAnnotationToolsOptions): void {
  options.registerTool(
    "get_annotation",
    {
      title: "Get annotation",
      description:
        'Read one of the owner\'s pre-flight annotations by label (for example "A1"): their note, the page, the element selector and text, and a screenshot of the element when there is one. For a desktop window annotation it returns the region of the window screenshot instead of a page and selector. Test exactly what the note asks, then pass the label in annotationLabels when you submit_finding about it. Only agents inside an Attack run can use it.',
      inputSchema: LabelInput,
    },
    async (input) => {
      const agentId = requireCaller(options);
      const parsed = LabelInput.parse(input);
      const { annotation, imageBase64 } = await asInputError(() =>
        options.service.annotationForAgent(agentId, parsed.label),
      );
      const region = annotation.kind === "desktop" ? annotation.region : null;
      const lines = (
        region
          ? [
              `${annotation.label}: ${annotation.note.trim() || "(no note)"}`,
              `region x,y,w,h: ${region.x},${region.y},${region.width},${region.height} of the desktop window screenshot (window pixels, as in desktop_screenshot)`,
              imageBase64
                ? "The attached image is that region as the owner saw it."
                : "The owner's mark has no screenshot.",
            ]
          : [
              `${annotation.label}: ${annotation.note.trim() || "(no note)"}`,
              `page: ${annotation.url}`,
              `element: <${annotation.tag}> ${annotation.selector}`,
              annotation.text.trim() ? `text: ${JSON.stringify(annotation.text.trim())}` : null,
              annotation.html.trim() ? `html: ${annotation.html.trim()}` : null,
              imageBase64
                ? "The attached image is the element as the owner saw it."
                : "The owner's mark has no screenshot.",
            ]
      ).filter((line): line is string => line !== null);
      const content: PimiToolResult["content"] = [{ type: "text", text: lines.join("\n") }];
      if (imageBase64) content.push({ type: "image", data: imageBase64, mimeType: "image/jpeg" });
      return {
        content,
        // Some tool bridges forward only the image and structuredContent when both kinds are present.
        structuredContent: {
          label: annotation.label,
          note: annotation.note,
          kind: annotation.kind,
          region,
          page: annotation.url,
          selector: annotation.selector,
          tag: annotation.tag,
          text: annotation.text,
          hasImage: imageBase64 !== null,
        },
      };
    },
  );

  options.registerTool(
    "report_annotation_result",
    {
      title: "Report annotation result",
      description:
        "Lead only: record what became of an owner annotation that has no finding. Call it once per such annotation before finish_attack_run: clean when it was tested and held, not_testable when it could not be tested, with a short note. An annotation a finding names (annotationLabels) needs no result. Only agents inside an Attack run can use it.",
      inputSchema: ResultInput,
    },
    async (input) => {
      const agentId = requireCaller(options);
      const parsed = ResultInput.parse(input);
      const run = await asInputError(() => options.service.reportAnnotationResult(agentId, parsed));
      return {
        content: [{ type: "text", text: `Recorded ${parsed.label} as ${parsed.result}.` }],
        structuredContent: { label: parsed.label, result: parsed.result, runId: run.id },
      };
    },
  );
}
