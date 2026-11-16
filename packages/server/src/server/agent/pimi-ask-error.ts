import {
  OpenCodeHelperStartupError,
  findOpenCodeHttpError,
  openCodeHttpFailureCode,
} from "./providers/opencode/http-error.js";

type AskPimiFailure = "startup" | "auth" | "access" | "limit";

const messages: Record<AskPimiFailure, string> = {
  startup:
    "Pimi couldn't start a local OpenCode server. Check that OpenCode 2.x (2.0.10 or later) is installed and available to Pimi.",
  auth: "OpenCode needs you to sign in again. Check its connection in Settings → Providers, then retry.",
  access:
    "OpenCode denied this request. Check the account's access and usage limits in OpenCode, then retry.",
  limit:
    "OpenCode hit a rate, usage, or spending limit. Retry later, check its limits, or select another Ask Pimi model in Settings → Pimi models.",
};

// Only categories leave the private turn. Provider exception text can contain the user's request.
export class AskPimiProviderError extends Error {
  constructor(readonly failure: AskPimiFailure) {
    super(messages[failure]);
    this.name = "AskPimiProviderError";
  }
}

export function askPimiFailureFromCode(code: string | undefined): AskPimiProviderError | undefined {
  switch (code) {
    case "opencode_http_401":
      return new AskPimiProviderError("auth");
    case "opencode_http_403":
      return new AskPimiProviderError("access");
    case "opencode_http_402":
    case "opencode_http_429":
      return new AskPimiProviderError("limit");
    default:
      return undefined;
  }
}

export function askPimiProviderFailure(error: unknown): AskPimiProviderError | undefined {
  if (error instanceof AskPimiProviderError) return error;
  if (error instanceof OpenCodeHelperStartupError) return new AskPimiProviderError("startup");
  return askPimiFailureFromCode(openCodeHttpFailureCode(findOpenCodeHttpError(error)?.status));
}
