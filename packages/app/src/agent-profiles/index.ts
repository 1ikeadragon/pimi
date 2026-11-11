/**
 * Agent profiles: named bundles of composer settings (provider, model, mode,
 * thinking option, feature values, notes) stored host-wide in daemon config.
 *
 * What leaves this module: reading and writing the list, the form fields the
 * profile page renders, pinning profiles to the model picker, and drawing a
 * profile's glyph. Everything
 * else (the form model, the catalog and feature probes, the materialization
 * rules, the icon registry, the row and modal chrome) is internal; import from
 * `@/agent-profiles`, never a path inside it.
 *
 * `useAgentProfilePicker` deliberately hands the picker a flat row view model
 * and one `applyProfile(id)` callback rather than the profiles themselves: what
 * a profile contains, and how it reaches a live agent versus a draft, stays in
 * here.
 */
export type { AgentProfile } from "@pimi/protocol/messages";
export type { MaterializedAgentProfile } from "./internal/materialize-profile";
export type { AgentProfileSeed } from "./internal/profile-form-model";
export { useAgentProfileEditor, type AgentProfileEditorControls } from "./agent-profile-editor";
export { useAgentProfiles } from "./internal/use-agent-profiles";
export {
  useAgentProfilePicker,
  type AgentProfileApplyTarget,
  type AgentProfilePicker,
  type AgentProfilePickerRow,
  type DraftAgentProfileControls,
} from "./internal/use-agent-profile-picker";
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
