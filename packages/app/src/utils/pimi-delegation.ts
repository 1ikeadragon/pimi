import type { ToolCallTimelineItem } from "@pimi/protocol/agent-types";
import { isPimiDelegationTool, PimiDelegationResult } from "@pimi/protocol/pimi-task";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isErrorResult(value: unknown): boolean {
  return isRecord(value) && Boolean(value.isError);
}

export function readPimiDelegation(output: unknown) {
  if (isErrorResult(output)) return null;
  // Claude's buildToolOutput preserves generic MCP results under `output`.
  if (isRecord(output) && "output" in output && !("structuredContent" in output)) {
    output = output.output;
  }
  if (isErrorResult(output)) return null;
  const direct = PimiDelegationResult.safeParse(
    isRecord(output) ? (output.structuredContent ?? output) : output,
  );
  if (direct.success) return direct.data.pimiDelegation;
  // Providers may relay the MCP text block instead of its structured payload.
  const content = isRecord(output) ? output.content : output;
  const block = Array.isArray(content) && content.length === 1 ? content[0] : content;
  const serialized = isRecord(block) && block.type === "text" ? block.text : block;
  if (typeof serialized !== "string") return null;
  try {
    const value: unknown = JSON.parse(serialized);
    if (isErrorResult(value)) return null;
    const parsed = PimiDelegationResult.safeParse(value);
    return parsed.success ? parsed.data.pimiDelegation : null;
  } catch {
    // Unrecognized tool output remains visible in the original tool row.
    return null;
  }
}

export type PimiDelegation = NonNullable<ReturnType<typeof readPimiDelegation>>;

/** Recognize the exact tool identity retained by each provider adapter. */
export function readPimiDelegationToolCall(
  data: Pick<ToolCallTimelineItem, "name" | "status" | "error" | "detail" | "metadata">,
): PimiDelegation | null {
  if (data.status !== "completed" || data.error) return null;
  // ACP categorizes MCP tools as `other` and retains their real name in metadata.title.
  const acpTitle =
    data.name === "other" && data.metadata?.kind === "other" ? data.metadata.title : undefined;
  if (
    !isPimiDelegationTool(data.name) &&
    !(typeof acpTitle === "string" && isPimiDelegationTool(acpTitle))
  )
    return null;
  if (data.detail.type === "unknown") return readPimiDelegation(data.detail.output);
  // ACP's content blocks become plain_text rather than unknown.output.
  if (data.detail.type === "plain_text") return readPimiDelegation(data.detail.text);
  return null;
}
