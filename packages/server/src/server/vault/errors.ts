import type { VaultErrorCode } from "@pimi/protocol/vault/types";

export interface VaultErrorOptions {
  /** Set on `rate_limited`: how long until the next attempt is accepted. */
  retryAfterMs?: number;
  cause?: unknown;
}

/**
 * The only error type whose message may reach a client. Messages never carry a secret value, the
 * passphrase, or a path inside the vault.
 */
export class VaultError extends Error {
  readonly retryAfterMs: number | undefined;

  constructor(
    readonly code: VaultErrorCode,
    message: string,
    options: VaultErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "VaultError";
    this.retryAfterMs = options.retryAfterMs;
  }
}
