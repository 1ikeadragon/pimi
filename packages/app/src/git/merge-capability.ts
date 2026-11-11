import { type ForgeSpecificEnvelope, type MergeCapability } from "@/git/client-forge-module";
import { CLIENT_FORGE_LOGIC_MODULES } from "@/git/forges";

export type ForgeSpecificStatusFacts = ForgeSpecificEnvelope;

export type { MergeCapability };

/**
 * Resolve the neutral merge capability from a registered forge's runtime facts.
 * Returns null for an unregistered, unknown, or schema-mismatched facts family;
 * callers then fall back to raw git state.
 */
function deriveForgeMergeCapability(facts: unknown): MergeCapability | null {
  for (const module of CLIENT_FORGE_LOGIC_MODULES) {
    const capability = module.facts?.deriveMergeCapability(facts);
    if (capability) {
      return capability;
    }
  }
  return null;
}

/**
 * Build the neutral merge capability from a forge's PR status facts. Returns
 * null when the forge supplied no merge facts (e.g. a host that exposes none, or
 * an unknown forge), in which case the caller falls back to raw git state.
 * Per-forge derivation lives on client forge modules; this stays the single
 * neutral entry point the action policy reads.
 */
export function deriveMergeCapability(forgeSpecific: unknown): MergeCapability | null {
  if (forgeSpecific === null || forgeSpecific === undefined) {
    return null;
  }
  return deriveForgeMergeCapability(forgeSpecific);
}
