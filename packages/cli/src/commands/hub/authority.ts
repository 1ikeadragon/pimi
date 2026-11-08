import type { HubCredentialStore } from "./credentials.js";
import { HubCommandError } from "./error.js";
import { normalizeHubOrigin } from "./origin.js";

export interface HubAuthorityOptions {
  origin?: string;
  apiKey?: string;
}

interface ResolveHubInput {
  options: HubAuthorityOptions;
  env: Readonly<Record<string, string | undefined>>;
  credentials: HubCredentialStore;
}

export function resolveHubOrigin(input: ResolveHubInput): string {
  const configuredOrigin =
    input.options.origin ?? input.env.PIMI_HUB_URL ?? input.env.PASEO_HUB_URL;
  const selectedOrigin = configuredOrigin ?? input.credentials.active()?.origin;
  if (selectedOrigin === undefined) {
    throw new HubCommandError("HUB_ORIGIN_REQUIRED", "Provide your Hub URL to connect.");
  }
  return normalizeHubOrigin(selectedOrigin);
}

export function resolveHubCredential(input: ResolveHubInput & { origin: string }): string {
  const explicitCredential =
    input.options.apiKey ?? input.env.PIMI_HUB_API_KEY ?? input.env.PASEO_HUB_API_KEY;
  if (explicitCredential !== undefined) return explicitCredential;
  const stored = input.credentials.get(input.origin);
  if (stored !== null) return stored.credential;
  throw new HubCommandError(
    "HUB_API_KEY_REQUIRED",
    `No stored Hub login matches ${input.origin}. Run \`pimi hub login ${input.origin}\`, pass --api-key <secret>, or set PIMI_HUB_API_KEY.`,
  );
}
