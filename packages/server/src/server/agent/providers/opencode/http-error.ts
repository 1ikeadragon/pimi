export class OpenCodeHttpError extends Error {
  readonly name = "OpenCodeHttpError";

  constructor(
    readonly operation: string,
    readonly status: number | undefined,
    readonly html: boolean,
  ) {
    const statusLabel = status === undefined ? "" : ` (HTTP ${status})`;
    super(
      html
        ? `OpenCode ${operation} returned HTML instead of JSON; incompatible OpenCode API${statusLabel}`
        : `OpenCode ${operation} failed${statusLabel}`,
    );
  }
}

export class OpenCodeHelperStartupError extends Error {
  readonly name = "OpenCodeHelperStartupError";
  constructor(cause: unknown) {
    super("Pimi could not start its local OpenCode helper", { cause });
  }
}

export function openCodeHttpFailureCode(status: number | undefined): string | undefined {
  return status === undefined ? undefined : `opencode_http_${status}`;
}

// The promise SDK wraps fetch failures in ClientError.cause.
export function findOpenCodeHttpError(error: unknown): OpenCodeHttpError | undefined {
  const seen = new Set<Error>();
  while (error instanceof Error && !seen.has(error)) {
    if (error instanceof OpenCodeHttpError) return error;
    seen.add(error);
    error = error.cause;
  }
  return undefined;
}
