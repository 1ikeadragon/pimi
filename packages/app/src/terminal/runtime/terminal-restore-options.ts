import type { SubscribeTerminalRequest } from "@pimi/protocol/messages";

export interface ResolveTerminalRestoreOptionsInput {
  scrollbackLines: number;
  canClaimSize: boolean;
  size: { rows: number; cols: number } | null;
}

export function resolveTerminalRestoreOptions(
  input: ResolveTerminalRestoreOptionsInput,
): NonNullable<SubscribeTerminalRequest["restore"]> {
  return {
    mode: "visible-snapshot",
    scrollbackLines: input.scrollbackLines,
    ...(input.canClaimSize && input.size ? { size: input.size } : {}),
  };
}
