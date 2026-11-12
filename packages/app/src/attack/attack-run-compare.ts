import type { Finding } from "@pimi/protocol/attack/types";

export interface AttackRunComparison {
  /** In the newer run only. */
  added: Finding[];
  /** In the older run only. */
  gone: Finding[];
  /** In both runs, shown from the newer run. */
  still: Finding[];
}

/**
 * Compares two runs by finding signature (route + category + normalised title). The match is
 * exact, so a finding the agents reworded reads as one added and one gone; the counts are a
 * reading aid, not a regression verdict.
 */
export function compareRuns(
  older: readonly Finding[],
  newer: readonly Finding[],
): AttackRunComparison {
  const olderBySignature = new Map(older.map((finding) => [finding.signature, finding]));
  const newerSignatures = new Set(newer.map((finding) => finding.signature));
  return {
    added: newer.filter((finding) => !olderBySignature.has(finding.signature)),
    gone: older.filter((finding) => !newerSignatures.has(finding.signature)),
    still: newer.filter((finding) => olderBySignature.has(finding.signature)),
  };
}
