import type { ProviderPimiToolsPolicy } from "@pimi/protocol/provider-config";

interface ProviderPimiToolSettings {
  pimiTools?: ProviderPimiToolsPolicy;
}

export function resolvePimiToolPolicy(
  providerId: string,
  providerSettings: Readonly<Record<string, ProviderPimiToolSettings>> | undefined,
): ProviderPimiToolsPolicy | undefined {
  return providerSettings?.[providerId]?.pimiTools;
}

export function isPimiToolEnabled(
  policy: ProviderPimiToolsPolicy | undefined,
  toolName: string,
): boolean {
  if (toolName === "speak") {
    return true;
  }
  if (!isPimiToolPolicyEnabled(policy)) {
    return false;
  }
  return !policy?.disabledTools?.includes(toolName);
}

export function isPimiToolPolicyEnabled(policy: ProviderPimiToolsPolicy | undefined): boolean {
  return policy?.enabled !== false;
}
