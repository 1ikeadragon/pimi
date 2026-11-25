import { z } from "zod";
import {
  VaultAuditEntrySchema,
  VaultBitwardenItemSchema,
  VaultBitwardenMissingSchema,
  VaultBitwardenStatusSchema,
  VaultEnvCandidateSchema,
  VaultEnvImportActionSchema,
  VaultEnvImportSkipSchema,
  VaultEnvNameSchema,
  VaultGrantBindingSchema,
  VaultGrantSchema,
  VaultRequestDecisionSchema,
  VaultRequestSchema,
  VaultSecretMetaSchema,
  VaultSecretNameSchema,
  VaultSecretSourceSchema,
  VaultStatusSchema,
} from "./types.js";

// Failures arrive as `rpc_error` with `code: "vault_<VaultErrorCode>"`. No request or response
// ever carries a secret value back; the passphrase and `value` fields only travel inbound.

/** An upper bound on pasted values (a private key is a few KiB), not a policy on secret size. */
const MAX_SECRET_VALUE_LENGTH = 64 * 1024;

const PassphraseSchema = z.string().min(1).max(1024);

export const VaultGetStatusRequestSchema = z.object({
  type: z.literal("vault.get_status.request"),
  requestId: z.string(),
});
export const VaultInitializeRequestSchema = z.object({
  type: z.literal("vault.initialize.request"),
  requestId: z.string(),
  passphrase: PassphraseSchema,
});
export const VaultUnlockRequestSchema = z.object({
  type: z.literal("vault.unlock.request"),
  requestId: z.string(),
  passphrase: PassphraseSchema,
});
export const VaultLockRequestSchema = z.object({
  type: z.literal("vault.lock.request"),
  requestId: z.string(),
});
export const VaultAuthorizeRequestSchema = z.object({
  type: z.literal("vault.authorize.request"),
  requestId: z.string(),
  passphrase: PassphraseSchema,
});
export const VaultListSecretsRequestSchema = z.object({
  type: z.literal("vault.list_secrets.request"),
  requestId: z.string(),
});
export const VaultSetSecretRequestSchema = z.object({
  type: z.literal("vault.set_secret.request"),
  requestId: z.string(),
  name: VaultSecretNameSchema,
  envName: VaultEnvNameSchema,
  description: z.string().max(500).nullable(),
  source: VaultSecretSourceSchema,
  /** Local sources: the new value, or null to keep the stored one. */
  value: z.string().max(MAX_SECRET_VALUE_LENGTH).nullable(),
});
export const VaultDeleteSecretRequestSchema = z.object({
  type: z.literal("vault.delete_secret.request"),
  requestId: z.string(),
  name: VaultSecretNameSchema,
});
export const VaultListGrantsRequestSchema = z.object({
  type: z.literal("vault.list_grants.request"),
  requestId: z.string(),
});
export const VaultSetGrantRequestSchema = z.object({
  type: z.literal("vault.set_grant.request"),
  requestId: z.string(),
  /** Null creates a grant. */
  grantId: z.string().nullable(),
  executable: z.string().min(1),
  argvPrefix: z.array(z.string()),
  bindings: z.array(VaultGrantBindingSchema).min(1),
  projectId: z.string().nullable(),
});
export const VaultDeleteGrantRequestSchema = z.object({
  type: z.literal("vault.delete_grant.request"),
  requestId: z.string(),
  grantId: z.string(),
});
export const VaultListRequestsRequestSchema = z.object({
  type: z.literal("vault.list_requests.request"),
  requestId: z.string(),
});
export const VaultResolveRequestRequestSchema = z.object({
  type: z.literal("vault.resolve_request.request"),
  requestId: z.string(),
  vaultRequestId: z.string(),
  decision: VaultRequestDecisionSchema,
  /** For `always`: how many arguments after the executable the grant fixes. */
  argvPrefixLength: z.number().int().nonnegative(),
  /** For `always`: restrict the grant to the project of the request. */
  scopeToProject: z.boolean(),
});
export const VaultListAuditRequestSchema = z.object({
  type: z.literal("vault.list_audit.request"),
  requestId: z.string(),
  limit: z.number().int().positive(),
});
export const VaultEnvListCandidatesRequestSchema = z.object({
  type: z.literal("vault.env.list_candidates.request"),
  requestId: z.string(),
});
export const VaultEnvImportRequestSchema = z.object({
  type: z.literal("vault.env.import.request"),
  requestId: z.string(),
  names: z.array(z.string()).min(1),
  action: VaultEnvImportActionSchema,
});

export const VaultGetStatusResponseSchema = z.object({
  type: z.literal("vault.get_status.response"),
  payload: z.object({ requestId: z.string(), status: VaultStatusSchema }),
});
export const VaultInitializeResponseSchema = z.object({
  type: z.literal("vault.initialize.response"),
  payload: z.object({ requestId: z.string(), status: VaultStatusSchema }),
});
export const VaultUnlockResponseSchema = z.object({
  type: z.literal("vault.unlock.response"),
  payload: z.object({ requestId: z.string(), status: VaultStatusSchema }),
});
export const VaultLockResponseSchema = z.object({
  type: z.literal("vault.lock.response"),
  payload: z.object({ requestId: z.string(), status: VaultStatusSchema }),
});
export const VaultAuthorizeResponseSchema = z.object({
  type: z.literal("vault.authorize.response"),
  payload: z.object({ requestId: z.string(), status: VaultStatusSchema }),
});
export const VaultListSecretsResponseSchema = z.object({
  type: z.literal("vault.list_secrets.response"),
  payload: z.object({ requestId: z.string(), secrets: z.array(VaultSecretMetaSchema) }),
});
export const VaultSetSecretResponseSchema = z.object({
  type: z.literal("vault.set_secret.response"),
  payload: z.object({ requestId: z.string(), secret: VaultSecretMetaSchema }),
});
export const VaultDeleteSecretResponseSchema = z.object({
  type: z.literal("vault.delete_secret.response"),
  payload: z.object({ requestId: z.string(), name: VaultSecretNameSchema }),
});
export const VaultListGrantsResponseSchema = z.object({
  type: z.literal("vault.list_grants.response"),
  payload: z.object({ requestId: z.string(), grants: z.array(VaultGrantSchema) }),
});
export const VaultSetGrantResponseSchema = z.object({
  type: z.literal("vault.set_grant.response"),
  payload: z.object({ requestId: z.string(), grant: VaultGrantSchema }),
});
export const VaultDeleteGrantResponseSchema = z.object({
  type: z.literal("vault.delete_grant.response"),
  payload: z.object({ requestId: z.string(), grantId: z.string() }),
});
export const VaultListRequestsResponseSchema = z.object({
  type: z.literal("vault.list_requests.response"),
  payload: z.object({ requestId: z.string(), requests: z.array(VaultRequestSchema) }),
});
export const VaultResolveRequestResponseSchema = z.object({
  type: z.literal("vault.resolve_request.response"),
  payload: z.object({ requestId: z.string(), vaultRequestId: z.string() }),
});
export const VaultListAuditResponseSchema = z.object({
  type: z.literal("vault.list_audit.response"),
  payload: z.object({ requestId: z.string(), entries: z.array(VaultAuditEntrySchema) }),
});
export const VaultEnvListCandidatesResponseSchema = z.object({
  type: z.literal("vault.env.list_candidates.response"),
  payload: z.object({ requestId: z.string(), candidates: z.array(VaultEnvCandidateSchema) }),
});
export const VaultEnvImportResponseSchema = z.object({
  type: z.literal("vault.env.import.response"),
  payload: z.object({
    requestId: z.string(),
    imported: z.array(z.string()),
    scrubbed: z.array(z.string()),
    skipped: z.array(VaultEnvImportSkipSchema),
  }),
});

// Bitwarden, through the user's own `bw` CLI. The master password travels inbound only and is
// used for one operation.
const MasterPasswordSchema = z.string().min(1).max(1024);

export const VaultSourceBitwardenGetStatusRequestSchema = z.object({
  type: z.literal("vault.source.bitwarden.get_status.request"),
  requestId: z.string(),
});
export const VaultSourceBitwardenUnlockRequestSchema = z.object({
  type: z.literal("vault.source.bitwarden.unlock.request"),
  requestId: z.string(),
  masterPassword: MasterPasswordSchema,
});
export const VaultSourceBitwardenLockRequestSchema = z.object({
  type: z.literal("vault.source.bitwarden.lock.request"),
  requestId: z.string(),
});
export const VaultSourceBitwardenSearchItemsRequestSchema = z.object({
  type: z.literal("vault.source.bitwarden.search_items.request"),
  requestId: z.string(),
  masterPassword: MasterPasswordSchema,
  query: z.string().min(1).max(200),
});

export const VaultSourceBitwardenGetStatusResponseSchema = z.object({
  type: z.literal("vault.source.bitwarden.get_status.response"),
  payload: z.object({ requestId: z.string(), status: VaultBitwardenStatusSchema }),
});
export const VaultSourceBitwardenUnlockResponseSchema = z.object({
  type: z.literal("vault.source.bitwarden.unlock.response"),
  payload: z.object({
    requestId: z.string(),
    status: VaultBitwardenStatusSchema,
    missing: z.array(VaultBitwardenMissingSchema),
  }),
});
export const VaultSourceBitwardenLockResponseSchema = z.object({
  type: z.literal("vault.source.bitwarden.lock.response"),
  payload: z.object({ requestId: z.string(), status: VaultBitwardenStatusSchema }),
});
export const VaultSourceBitwardenSearchItemsResponseSchema = z.object({
  type: z.literal("vault.source.bitwarden.search_items.response"),
  payload: z.object({ requestId: z.string(), items: z.array(VaultBitwardenItemSchema) }),
});
