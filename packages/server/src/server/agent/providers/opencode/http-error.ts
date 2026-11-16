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
