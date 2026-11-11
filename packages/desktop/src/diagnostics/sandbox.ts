export function describeSandbox(input: { disabled: boolean }): {
  enabled: boolean;
  reason: string;
} {
  return {
    enabled: !input.disabled,
    reason: input.disabled ? "requested by --no-sandbox" : "Chromium default",
  };
}
