import type { AttackRoleId } from "@pimi/protocol/attack/types";
import { BUILTIN_PROFILE_ID_PREFIX } from "../agent/profiles/builtin-profiles.js";

export const ATTACK_COORDINATOR_PROFILE_ID = `${BUILTIN_PROFILE_ID_PREFIX}attack-coordinator`;

export const ATTACK_ROLE_PROFILES: Record<AttackRoleId, { profileId: string; label: string }> = {
  recon: { profileId: `${BUILTIN_PROFILE_ID_PREFIX}attack-recon`, label: "Recon and mapper" },
  "ui-qa": { profileId: `${BUILTIN_PROFILE_ID_PREFIX}attack-ui-qa`, label: "UI QA and chaos" },
  api: { profileId: `${BUILTIN_PROFILE_ID_PREFIX}attack-api`, label: "Backend and API" },
  auth: { profileId: `${BUILTIN_PROFILE_ID_PREFIX}attack-auth`, label: "Auth and access" },
  input: { profileId: `${BUILTIN_PROFILE_ID_PREFIX}attack-input`, label: "Input robustness" },
  "perf-lite": {
    profileId: `${BUILTIN_PROFILE_ID_PREFIX}attack-perf-lite`,
    label: "Perf-lite (bounded load)",
  },
  "desktop-security": {
    profileId: `${BUILTIN_PROFILE_ID_PREFIX}attack-desktop-security`,
    label: "Desktop security tester",
  },
  "secrets-audit": {
    profileId: `${BUILTIN_PROFILE_ID_PREFIX}attack-secrets-auditor`,
    label: "Secrets and config auditor",
  },
};
