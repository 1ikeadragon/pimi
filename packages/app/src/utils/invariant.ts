const isProduction = process.env.NODE_ENV === "production";

/** Throws when `condition` is falsy. Production builds drop the message, as tiny-invariant did. */
export function invariant(condition: unknown, message?: string): asserts condition {
  if (condition) return;
  if (isProduction) throw new Error("Invariant failed");
  throw new Error(message ? `Invariant failed: ${message}` : "Invariant failed");
}
