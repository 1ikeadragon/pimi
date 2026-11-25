import { z } from "zod";

// The vault holds secrets an agent can use through `vault_run` but never read. Nothing in this
// file carries a secret value: values go in on `vault.set_secret.request` and never come back.

// Shortest passphrase initialize accepts. NIST SP 800-63B sets 8 for online-attack-limited
// secrets. This one also faces offline attack by any process that can read vault.json (every
// same-user agent), so it is raised to 12.
export const VAULT_MIN_PASSPHRASE_LENGTH = 12;

/** What agents write in `vault_run.secrets`. Lower-case-first so it cannot collide with an env name. */
export const VaultSecretNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,63}$/, "Use lower-case letters, digits, '-' and '_' (max 64).");

/**
 * The name agents see for an environment variable: lower-case, `_` to `-`, leading non-letters
 * dropped. The result may still fail `VaultSecretNameSchema` (empty, too long).
 */
export function secretNameFromEnvName(envName: string): string {
  return envName
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/^[^a-z]+/, "");
}

export const VaultEnvNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, "Not a valid environment variable name.");

export const VaultSecretSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local") }),
  z.object({
    kind: z.literal("bitwarden"),
    itemId: z.string().min(1),
    /** `password`, `username` or the name of a custom field. */
    field: z.string().min(1),
  }),
]);
export type VaultSecretSource = z.infer<typeof VaultSecretSourceSchema>;

export const VaultSecretMetaSchema = z.object({
  name: VaultSecretNameSchema,
  envName: VaultEnvNameSchema,
  description: z.string().nullable(),
  source: VaultSecretSourceSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  lastUsedAt: z.string().nullable(),
  /** False when the value is too short for the output redactor to register, or is not loaded. */
  redactable: z.boolean(),
});
export type VaultSecretMeta = z.infer<typeof VaultSecretMetaSchema>;

export const VaultGrantBindingSchema = z.object({
  secret: VaultSecretNameSchema,
  envName: VaultEnvNameSchema,
});
export type VaultGrantBinding = z.infer<typeof VaultGrantBindingSchema>;

export const VaultGrantSchema = z.object({
  id: z.string(),
  /** Absolute, symlink-resolved path of the executable. */
  executable: z.string().min(1),
  /** Arguments that must follow the executable, element for element. Empty matches any arguments. */
  argvPrefix: z.array(z.string()),
  bindings: z.array(VaultGrantBindingSchema).min(1),
  /** Null: any project. */
  projectId: z.string().nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  /** The executable runs code from the project it is started in, so the grant covers that code. */
  runsProjectCode: z.boolean(),
});
export type VaultGrant = z.infer<typeof VaultGrantSchema>;

/** What a blocked `vault_run` is waiting for. */
export const VaultRequestWaitSchema = z.enum(["unlock", "approval", "source"]);
export type VaultRequestWait = z.infer<typeof VaultRequestWaitSchema>;

export const VaultRequestSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  agentId: z.string().nullable(),
  projectId: z.string().nullable(),
  cwd: z.string(),
  /** argv[0] is the resolved executable. */
  argv: z.array(z.string()).min(1),
  /** Empty while `waitingFor` is `unlock`: a locked vault cannot say which variables the names map to. */
  secrets: z.array(VaultGrantBindingSchema),
  runsProjectCode: z.boolean(),
  waitingFor: VaultRequestWaitSchema,
  /** For `source`: the Bitwarden-backed secrets that are not loaded. Empty otherwise. */
  sourceSecrets: z.array(VaultSecretNameSchema),
});
export type VaultRequest = z.infer<typeof VaultRequestSchema>;

export const VaultRequestDecisionSchema = z.enum(["deny", "once", "always"]);
export type VaultRequestDecision = z.infer<typeof VaultRequestDecisionSchema>;

export const VaultAuditEventSchema = z.enum([
  "initialized",
  "unlocked",
  "locked",
  "auto_locked",
  "unlock_failed",
  "operator_granted",
  "secret_set",
  "secret_deleted",
  "grant_set",
  "grant_deleted",
  "request_created",
  "request_resolved",
  "run",
  "run_refused",
  "env_imported",
  "bitwarden_unlocked",
  "bitwarden_locked",
]);
export type VaultAuditEvent = z.infer<typeof VaultAuditEventSchema>;

export const VaultAuditEntrySchema = z.object({
  at: z.string(),
  event: VaultAuditEventSchema,
  agentId: z.string().nullable(),
  /** Names and exit codes only. Written after redaction, never a value. */
  detail: z.string(),
});
export type VaultAuditEntry = z.infer<typeof VaultAuditEntrySchema>;

export const VaultStateSchema = z.enum(["uninitialized", "locked", "unlocked"]);
export type VaultState = z.infer<typeof VaultStateSchema>;

/** `unavailable`: no helper on this daemon. `off`: available, not enrolled. */
export const VaultQuickUnlockSchema = z.enum(["unavailable", "off", "on"]);
export type VaultQuickUnlock = z.infer<typeof VaultQuickUnlockSchema>;

export const VaultStatusSchema = z.object({
  state: VaultStateSchema,
  quickUnlock: VaultQuickUnlockSchema,
  /** When the vault locks itself if nothing uses it. Null while locked. */
  idleLockAt: z.string().nullable(),
  /** When the asking connection stops counting as the operator. Null: it is not the operator. */
  operatorUntil: z.string().nullable(),
  pendingRequests: z.number().int().nonnegative(),
});
export type VaultStatus = z.infer<typeof VaultStatusSchema>;

export const VaultEnvCandidateSchema = z.object({
  name: z.string(),
  /** Already in the daemon's scrub list. */
  scrubbed: z.boolean(),
});
export type VaultEnvCandidate = z.infer<typeof VaultEnvCandidateSchema>;

export const VaultEnvImportActionSchema = z.enum(["import", "scrub_only"]);
export type VaultEnvImportAction = z.infer<typeof VaultEnvImportActionSchema>;

export const VaultEnvImportSkipSchema = z.object({
  name: z.string(),
  reason: z.enum(["not_set", "invalid_name", "name_taken"]),
});

export const VaultErrorCodeSchema = z.enum([
  "not_initialized",
  "already_initialized",
  "locked",
  "bad_passphrase",
  "weak_passphrase",
  "rate_limited",
  "not_operator",
  "not_found",
  "invalid_argument",
  "corrupt",
  "source_unavailable",
  "disabled",
  /** The Touch ID prompt was dismissed. */
  "cancelled",
  /** Another Touch ID prompt is already open. */
  "prompt_open",
  /** The enrolled key no longer exists (Secure Enclave reset, or another Mac). */
  "key_gone",
]);
export type VaultErrorCode = z.infer<typeof VaultErrorCodeSchema>;

export const VaultBitwardenAuthStateSchema = z.enum([
  "unauthenticated",
  "locked",
  "unlocked",
  "unknown",
]);

export const VaultBitwardenMissingSchema = z.object({
  secret: VaultSecretNameSchema,
  reason: z.enum(["item_not_found", "field_not_found"]),
});
export type VaultBitwardenMissing = z.infer<typeof VaultBitwardenMissingSchema>;

export const VaultBitwardenStatusSchema = z.object({
  installed: z.boolean(),
  /** What `bw status` reports. This is the CLI's own session, not the vault's use of it. */
  authState: VaultBitwardenAuthStateSchema,
  userEmail: z.string().nullable(),
  serverUrl: z.string().nullable(),
  /** The CLI's last successful sync. */
  lastSyncAt: z.string().nullable(),
  binaryPath: z.string().nullable(),
  /** Items in the in-memory index. Null when there is none: Bitwarden has not been opened, or the index expired. */
  indexedItems: z.number().int().nonnegative().nullable(),
  /** False when the last open could not sync and used the CLI's cached data. Null before any open. */
  synced: z.boolean().nullable(),
  /** Bound secrets the last open could not find. Kept until the next open. */
  missing: z.array(VaultBitwardenMissingSchema),
  /** Secrets whose value is in daemon memory right now. */
  loadedSecrets: z.array(VaultSecretNameSchema),
  /** When the index and the loaded values are dropped. Null when nothing is held. */
  loadedUntil: z.string().nullable(),
});
export type VaultBitwardenStatus = z.infer<typeof VaultBitwardenStatusSchema>;

export const VaultBitwardenItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  username: z.string().nullable(),
  /** Names only: `password`, `username` and custom field names. */
  fields: z.array(z.string()),
});
export type VaultBitwardenItem = z.infer<typeof VaultBitwardenItemSchema>;
