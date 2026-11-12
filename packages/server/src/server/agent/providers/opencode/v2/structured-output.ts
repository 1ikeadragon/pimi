import { Ajv } from "ajv";
import { z } from "zod";
import type { SessionMessageInfo } from "@opencode/client";

export const STRUCTURED_OUTPUT_TOOL = "pimi_structured_output";
const schemas = new Ajv({ strict: false, allErrors: true });

export function isStructuredOutputTool(name: string): boolean {
  // Older OpenCode servers and their saved sessions can still emit this name.
  return name === STRUCTURED_OUTPUT_TOOL || name === "pimi_structured_output";
}

export function structuredOutput(input: unknown) {
  const schema = z.union([z.boolean(), z.record(z.string(), z.json())]).parse(input);
  const validate = schemas.compile(schema);
  return {
    schema,
    assert(history: SessionMessageInfo[]) {
      const start = history.findLastIndex((message) => message.type === "user");
      for (const message of history.slice(start + 1)) {
        if (message.type !== "assistant") continue;
        for (const part of message.content) {
          if (
            part.type !== "tool" ||
            !isStructuredOutputTool(part.name) ||
            part.state.status !== "completed"
          )
            continue;
          const result = part.state.metadata?.pimiStructuredOutput;
          if (result === undefined) continue;
          if (!validate(result))
            throw new Error(
              `Invalid OpenCode structured output: ${schemas.errorsText(validate.errors)}`,
            );
          return;
        }
      }
      throw new Error("OpenCode finished without submitting the required structured output");
    },
  };
}
