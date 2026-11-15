/**
 * Agent profiles: named bundles of composer settings (provider, model, mode,
 * thinking option, feature values, notes) stored host-wide in daemon config.
 *
 * What leaves this module: reading and writing the list, the form fields the
 * profile page renders, resolving a profile for a draft, and drawing a
 * profile's glyph. Everything else (the form model, the catalog and feature
 * probes, the icon registry) is internal; import from `@/agent-profiles`,
 * never a path inside it.
 */
export type { AgentProfile } from "@pimi/protocol/messages";
export type { MaterializedAgentProfile } from "./internal/materialize-profile";
export { useAgentProfiles } from "./internal/use-agent-profiles";
export { AgentProfileGlyph } from "./internal/agent-profile-glyph";
export { materializeAgentProfile } from "./internal/materialize-profile";
export { AgentProfileFormFields } from "./settings/agent-profile-form-fields";
export { useAgentProfileForm } from "./internal/use-profile-form-model";
export type { AgentProfileFormSnapshot } from "./internal/profile-form-model";
export {
  upsertAgentProfile,
  buildDeleteProfilePatch,
  buildResetProfilePatch,
} from "./internal/profile-list";
export { buildAgentProfileTags, type AgentProfileTag } from "./internal/profile-summary";
