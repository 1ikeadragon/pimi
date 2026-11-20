/**
 * When a tool call's first event was recorded, as an ISO string. Every lifecycle update after
 * the first replaces the row's timestamp, so the start would otherwise be lost once a call
 * folds into one projected row. The daemon's projection and the app's stream merge both carry
 * it forward from the first row they saw.
 */
export const TOOL_CALL_STARTED_AT_METADATA_KEY = "pimiStartedAt";

export function readToolCallStartedAt(
  metadata: Record<string, unknown> | undefined,
): string | null {
  const value = metadata?.[TOOL_CALL_STARTED_AT_METADATA_KEY];
  return typeof value === "string" ? value : null;
}

/** `metadata` with the start carried forward; the same object when it already has one. */
export function withToolCallStartedAt(
  metadata: Record<string, unknown> | undefined,
  startedAt: string,
): Record<string, unknown> {
  if (metadata && readToolCallStartedAt(metadata) !== null) return metadata;
  return { ...metadata, [TOOL_CALL_STARTED_AT_METADATA_KEY]: startedAt };
}
