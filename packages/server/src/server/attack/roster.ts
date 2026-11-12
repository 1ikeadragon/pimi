import type { AttackRoleId } from "@pimi/protocol/attack/types";
import { BUILTIN_PROFILE_ID_PREFIX } from "../agent/profiles/builtin-profiles.js";

export const ATTACK_COORDINATOR_PROFILE_ID = `${BUILTIN_PROFILE_ID_PREFIX}attack-coordinator`;

export const ATTACK_ROLE_PROFILES: Record<AttackRoleId, { profileId: string; label: string }> = {
  "ui-qa": { profileId: `${BUILTIN_PROFILE_ID_PREFIX}attack-ui-qa`, label: "UI QA and chaos" },
  "secrets-audit": {
    profileId: `${BUILTIN_PROFILE_ID_PREFIX}attack-secrets-auditor`,
    label: "Secrets and config auditor",
  },
};
