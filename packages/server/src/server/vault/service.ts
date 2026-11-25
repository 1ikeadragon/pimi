import { randomBytes, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type pino from "pino";
import {
  VAULT_MIN_PASSPHRASE_LENGTH,
  VaultEnvNameSchema,
  VaultSecretNameSchema,
  type VaultAuditEntry,
  type VaultAuditEvent,
  type VaultEnvCandidate,
  type VaultEnvImportAction,
  type VaultGrant,
  type VaultGrantBinding,
  type VaultRequest,
  type VaultRequestDecision,
  type VaultSecretMeta,
  type VaultBitwardenItem,
  type VaultBitwardenMissing,
  type VaultBitwardenStatus,
  type VaultSecretSource,
  type VaultState,
  type VaultStatus,
} from "@pimi/protocol/vault/types";
import { VaultAudit } from "./audit.js";
import { BITWARDEN_CACHE_TTL_MS, type BitwardenCli } from "./sources/bitwarden-cli.js";
import {
  VAULT_FORMAT_VERSION,
  deriveVaultKey,
  keysEqual,
  newKdfParams,
  openPayload,
  sealPayload,
  type VaultHeader,
} from "./crypto.js";
import { removeEnvNames } from "./env-scrub.js";
import { VaultError } from "./errors.js";
import { bindingsForRun, isInside, matchGrant, runsProjectCode, runKey } from "./grants.js";
import type { OutputRedactor } from "./redact-deep.js";
import { RUN_MAX_TIMEOUT_MS, resolveExecutable, runProgram, type RunResult } from "./runner.js";
import { createExternalProcessEnv } from "../pimi-env.js";
import { Redactor, type RedactorSecret } from "./redactor.js";
import {
  VaultPayloadSchema,
  VaultStore,
  type VaultGrantRecord,
  type VaultPayload,
  type VaultSecretRecord,
} from "./store.js";

// ---

// The vault locks itself when nothing has used it for this long. 15 minutes covers a pause in an
// agent session without leaving decrypted secrets in daemon memory for an afternoon.
export const IDLE_LOCK_MS = 15 * 60 * 1000;

// Passphrase attempts (unlock and authorize share one budget). Five covers human typos. After
// that each failure doubles the wait, from 1 s up to 15 min, so a client that can only reach the
// WebSocket cannot grind guesses; scrypt's own ~0.5 s per attempt (measured, see crypto.ts) is
// the floor underneath. The budget is daemon-wide, so an agent that hammers it also delays the
// user: an accepted denial of service, since the alternative is unthrottled guessing.
export const AUTH_FREE_ATTEMPTS = 5;
export const AUTH_BACKOFF_BASE_MS = 1000;
export const AUTH_BACKOFF_MAX_MS = 15 * 60 * 1000;

// How long a request waits for the operator before it is dropped. A person can be away from the
// screen for a while; a request older than this is more likely stale than wanted.
export const REQUEST_TTL_MS = 10 * 60 * 1000;

// After "once" is chosen for a request whose tool call already gave up waiting, the agent's next
// identical call may use it for this long. Two minutes covers a model retrying; it is short
// because the approval is for one execution, not a standing grant.
export const APPROVAL_TICKET_TTL_MS = 2 * 60 * 1000;

// Names whose values are likely credentials. Used only to suggest candidates in the import list;
// nothing is removed or imported without the user selecting it.
const CREDENTIAL_NAME_PATTERN =
  /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL)/i;

// ---

type ApprovalWaiter = (outcome: VaultRequestDecision | "locked") => void;

interface PendingApproval {
  request: VaultRequest;
  runKey: string;
  waiters: Set<ApprovalWaiter>;
}

interface Unlocked {
  key: Buffer;
  header: VaultHeader;
  payload: VaultPayload;
}

export interface VaultServiceOptions {
  /** The user's `bw` CLI. Without it Bitwarden-backed secrets cannot be loaded. */
  bitwarden: BitwardenCli;
  pimiHome: string;
  /** The environment the daemon spawns children from; names the vault manages are removed from it. */
  env: NodeJS.ProcessEnv;
  logger: pino.Logger;
}

export interface SetSecretInput {
  name: string;
  envName: string;
  description: string | null;
  source: VaultSecretSource;
  /** Local secrets: the new value, or null to keep the stored one. Ignored for other sources. */
  value: string | null;
}

export interface SetGrantInput {
  id: string | null;
  executable: string;
  argvPrefix: string[];
  bindings: VaultGrantBinding[];
  projectId: string | null;
}

export interface ApprovalInput {
  agentId: string | null;
  projectId: string | null;
  cwd: string;
  /** argv[0] is the resolved executable. */
  argv: string[];
  secrets: VaultGrantBinding[];
}

export type ApprovalOutcome =
  | { kind: "decided"; decision: VaultRequestDecision }
  | { kind: "timeout"; requestId: string };

export interface ResolveRequestInput {
  requestId: string;
  decision: VaultRequestDecision;
  /** For "always": how many arguments after the executable the grant fixes. */
  argvPrefixLength: number;
  /** For "always": limit the grant to the request's project. */
  scopeToProject: boolean;
}

export interface RunInput {
  /** argv[0] is a name to look up on PATH or a path. */
  argv: string[];
  secrets: string[];
  cwd: string;
  agentId: string | null;
  projectId: string | null;
  timeoutMs: number;
  /** How long to wait for the operator before telling the caller to call again. */
  approvalWaitMs: number;
  signal?: AbortSignal;
}

export type RunOutcome =
  | { status: "completed"; result: RunResult }
  | { status: "awaiting_approval"; requestId: string }
  | { status: "denied" };

export interface EnvImportResult {
  imported: string[];
  scrubbed: string[];
  skipped: Array<{ name: string; reason: "not_set" | "invalid_name" | "name_taken" }>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function envNameKey(name: string): string {
  return process.platform === "win32" ? name.toUpperCase() : name;
}

export class VaultService implements OutputRedactor {
  private readonly store: VaultStore;
  private readonly audit: VaultAudit;
  private readonly env: NodeJS.ProcessEnv;
  private readonly bitwarden: BitwardenCli;
  private externalTimer: NodeJS.Timeout | null = null;
  private readonly logger: pino.Logger;
  private header: VaultHeader | null = null;
  private unreadable: VaultError | null = null;
  private unlocked: Unlocked | null = null;
  private redactor = new Redactor([]);
  private mutations: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;
  private idleLockAt: number | null = null;
  private epoch = 0;
  private failedAttempts = 0;
  private blockedUntil = 0;
  private readonly pending = new Map<string, PendingApproval>();
  private readonly tickets = new Map<string, number>();
  private readonly externalValues = new Map<string, { value: string; expiresAt: number }>();
  private readonly listeners = new Set<() => void>();

  constructor(options: VaultServiceOptions) {
    this.store = new VaultStore(options.pimiHome);
    this.audit = new VaultAudit(options.pimiHome);
    this.env = options.env;
    this.bitwarden = options.bitwarden;
    this.logger = options.logger.child({ module: "vault" });
  }

  /** Reads the file header. A corrupt file leaves the vault locked and reports on unlock. */
  async load(): Promise<void> {
    try {
      this.header = (await this.store.load())?.header ?? null;
    } catch (error) {
      if (!(error instanceof VaultError)) throw error;
      this.logger.error({ code: error.code }, "The vault file could not be read");
      this.header = null;
      this.unreadable = error;
    }
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emitChanged(): void {
    for (const listener of this.listeners) listener();
  }

  // --- state

  /** Changes on every lock, so operator marks made before it stop counting. */
  get lockEpoch(): number {
    return this.epoch;
  }

  get state(): VaultState {
    if (this.unlocked) return "unlocked";
    return this.header || this.unreadable ? "locked" : "uninitialized";
  }

  getStatus(operatorUntil: number | null): VaultStatus {
    this.pruneRequests();
    return {
      state: this.state,
      idleLockAt: this.idleLockAt === null ? null : new Date(this.idleLockAt).toISOString(),
      operatorUntil: operatorUntil === null ? null : new Date(operatorUntil).toISOString(),
      pendingRequests: this.pending.size,
    };
  }

  private requireUnlocked(): Unlocked {
    if (this.unlocked) return this.unlocked;
    if (this.state === "uninitialized") {
      throw new VaultError("not_initialized", "The vault has not been created yet.");
    }
    throw new VaultError("locked", "The vault is locked.");
  }

  /** Any use of an unlocked vault postpones the idle lock. */
  touch(): void {
    if (!this.unlocked) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleLockAt = Date.now() + IDLE_LOCK_MS;
    this.idleTimer = setTimeout(() => {
      this.lock("auto_locked").catch((error: unknown) => {
        this.logger.error({ err: error }, "Idle lock failed");
      });
    }, IDLE_LOCK_MS);
    this.idleTimer.unref();
  }

  // --- passphrase flows

  private assertAttemptAllowed(): void {
    const wait = this.blockedUntil - Date.now();
    if (wait > 0) {
      throw new VaultError(
        "rate_limited",
        "Too many wrong passphrases. Wait before trying again.",
        {
          retryAfterMs: wait,
        },
      );
    }
  }

  private recordFailure(): void {
    this.failedAttempts += 1;
    const excess = this.failedAttempts - AUTH_FREE_ATTEMPTS;
    if (excess > 0) {
      const backoff = Math.min(AUTH_BACKOFF_MAX_MS, AUTH_BACKOFF_BASE_MS * 2 ** (excess - 1));
      this.blockedUntil = Date.now() + backoff;
    }
  }

  private recordSuccess(): void {
    this.failedAttempts = 0;
    this.blockedUntil = 0;
  }

  async initialize(passphrase: string): Promise<void> {
    if (this.state !== "uninitialized") {
      throw new VaultError("already_initialized", "A vault already exists.");
    }
    if (passphrase.normalize("NFKC").length < VAULT_MIN_PASSPHRASE_LENGTH) {
      throw new VaultError(
        "weak_passphrase",
        `Use a passphrase of at least ${VAULT_MIN_PASSPHRASE_LENGTH} characters.`,
      );
    }
    const kdf = newKdfParams();
    const key = await deriveVaultKey(passphrase, kdf);
    const header: VaultHeader = { version: VAULT_FORMAT_VERSION, kdf, envScrubNames: [] };
    const payload: VaultPayload = { secrets: [], grants: [], scrubOnly: [] };
    const sealed = sealPayload({ key, header, plaintext: Buffer.from(JSON.stringify(payload)) });
    await this.store.save({ header, sealed });
    this.header = header;
    this.unlocked = { key, header, payload };
    this.rebuildRedactor();
    this.touch();
    await this.auditEvent("initialized", null, "Vault created");
    this.emitChanged();
  }

  async unlock(passphrase: string): Promise<void> {
    // The session marks the caller as operator after this returns, so an already-unlocked vault
    // must still check the passphrase, or any client could become operator with a wrong one.
    if (this.unlocked) return this.verifyPassphrase(passphrase);
    this.assertAttemptAllowed();
    const stored = await this.loadStoredOrThrow();
    const key = await deriveVaultKey(passphrase, stored.header.kdf);
    let plaintext: Buffer;
    try {
      plaintext = openPayload({ key, header: stored.header, sealed: stored.sealed });
    } catch (error) {
      key.fill(0);
      if (error instanceof VaultError && error.code === "bad_passphrase") {
        this.recordFailure();
        await this.auditEventBestEffort(
          "unlock_failed",
          null,
          `Failed attempt ${this.failedAttempts}`,
        );
      }
      throw error;
    }
    this.recordSuccess();
    const payload = this.parsePayload(plaintext);
    plaintext.fill(0);
    if (this.unlocked) {
      key.fill(0);
      return;
    }
    this.header = stored.header;
    this.unlocked = { key, header: stored.header, payload };
    this.rebuildRedactor();
    this.applyScrub(stored.header.envScrubNames);
    this.touch();
    await this.auditEventBestEffort("unlocked", null, "Vault unlocked");
    this.emitChanged();
  }

  /** Proves the caller knows the passphrase of the unlocked vault. Constant-time key comparison. */
  async verifyPassphrase(passphrase: string): Promise<void> {
    const current = this.requireUnlocked();
    this.assertAttemptAllowed();
    const candidate = await deriveVaultKey(passphrase, current.header.kdf);
    const matches = keysEqual(candidate, current.key);
    candidate.fill(0);
    if (!matches) {
      this.recordFailure();
      await this.auditEventBestEffort(
        "unlock_failed",
        null,
        `Failed operator attempt ${this.failedAttempts}`,
      );
      throw new VaultError("bad_passphrase", "Wrong passphrase.");
    }
    this.recordSuccess();
    this.touch();
  }

  async lock(reason: "locked" | "auto_locked" = "locked"): Promise<void> {
    await this.mutations;
    const current = this.unlocked;
    if (!current) return;
    this.unlocked = null;
    this.epoch += 1;
    current.key.fill(0);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.idleLockAt = null;
    this.dropExternalValues();
    this.tickets.clear();
    this.redactor = new Redactor([]);
    for (const entry of this.pending.values()) {
      for (const waiter of entry.waiters) waiter("locked");
    }
    this.pending.clear();
    await this.auditEventBestEffort(
      reason,
      null,
      reason === "locked" ? "Vault locked" : "Vault locked after idle",
    );
    this.emitChanged();
  }

  private async loadStoredOrThrow(): Promise<NonNullable<Awaited<ReturnType<VaultStore["load"]>>>> {
    if (this.unreadable) throw this.unreadable;
    const stored = await this.store.load();
    if (!stored) throw new VaultError("not_initialized", "The vault has not been created yet.");
    return stored;
  }

  private parsePayload(plaintext: Buffer): VaultPayload {
    let json: unknown;
    try {
      json = JSON.parse(plaintext.toString("utf8"));
    } catch (error) {
      throw new VaultError("corrupt", "The vault contents are not valid JSON.", { cause: error });
    }
    const parsed = VaultPayloadSchema.safeParse(json);
    if (!parsed.success) {
      throw new VaultError("corrupt", "The vault contents do not have the expected shape.", {
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  // --- persistence

  private mutate<T>(change: (draft: VaultPayload) => T): Promise<T> {
    const run = this.mutations.then(async () => {
      const current = this.requireUnlocked();
      const draft = structuredClone(current.payload);
      const result = change(draft);
      await this.persist(current, draft);
      return result;
    });
    this.mutations = run.catch(() => undefined);
    return run;
  }

  private scrubNamesOf(payload: VaultPayload): string[] {
    const names = new Set<string>(payload.scrubOnly);
    for (const secret of payload.secrets) names.add(secret.envName);
    for (const grant of payload.grants)
      for (const binding of grant.bindings) names.add(binding.envName);
    return [...names].sort();
  }

  private async persist(current: Unlocked, payload: VaultPayload): Promise<void> {
    const header: VaultHeader = { ...current.header, envScrubNames: this.scrubNamesOf(payload) };
    const sealed = sealPayload({
      key: current.key,
      header,
      plaintext: Buffer.from(JSON.stringify(payload)),
    });
    await this.store.save({ header, sealed });
    if (this.unlocked !== current)
      throw new VaultError("locked", "The vault was locked during the change.");
    current.header = header;
    current.payload = payload;
    this.header = header;
    this.rebuildRedactor();
    this.applyScrub(header.envScrubNames);
    this.touch();
    this.emitChanged();
  }

  private applyScrub(names: readonly string[]): void {
    const removed = removeEnvNames(this.env, names);
    if (removed.length > 0) {
      this.logger.info(
        { names: removed },
        "Removed vault-managed variables from the daemon environment",
      );
    }
  }

  private rebuildRedactor(): void {
    const secrets: RedactorSecret[] = [];
    for (const record of this.unlocked?.payload.secrets ?? []) {
      const value = this.valueOf(record);
      if (value !== null) secrets.push({ name: record.name, value });
    }
    this.redactor = new Redactor(secrets);
  }

  // --- secrets

  private valueOf(record: VaultSecretRecord): string | null {
    if (record.source.kind === "local") return record.value;
    const external = this.externalValues.get(record.name);
    return external && external.expiresAt > Date.now() ? external.value : null;
  }

  /** The value for injection into a child process. Never sent to a client. */
  secretValue(name: string): string {
    const current = this.requireUnlocked();
    const record = current.payload.secrets.find((candidate) => candidate.name === name);
    if (!record) throw new VaultError("not_found", `No secret named ${name}.`);
    const value = this.valueOf(record);
    if (value === null) {
      throw new VaultError(
        "source_unavailable",
        `The value of ${name} is not loaded. Unlock its source.`,
      );
    }
    return value;
  }

  private dropExternalValues(): void {
    if (this.externalTimer) clearTimeout(this.externalTimer);
    this.externalTimer = null;
    this.externalValues.clear();
  }

  // --- Bitwarden

  private bitwardenBindings(): Array<{ secretName: string; itemId: string; field: string }> {
    const bindings = [];
    for (const record of this.requireUnlocked().payload.secrets) {
      if (record.source.kind === "bitwarden") {
        bindings.push({
          secretName: record.name,
          itemId: record.source.itemId,
          field: record.source.field,
        });
      }
    }
    return bindings;
  }

  async bitwardenStatus(): Promise<VaultBitwardenStatus> {
    this.requireUnlocked();
    const auth = await this.bitwarden.getAuthState();
    const expiries = [...this.externalValues.values()].map((entry) => entry.expiresAt);
    return {
      installed: auth.installed,
      authState: auth.authState,
      loadedSecrets: [...this.externalValues.keys()],
      loadedUntil: expiries.length > 0 ? new Date(Math.min(...expiries)).toISOString() : null,
    };
  }

  /** Copies every Bitwarden-bound secret into memory for `BITWARDEN_CACHE_TTL_MS`. */
  async bitwardenUnlock(masterPassword: string): Promise<VaultBitwardenMissing[]> {
    const bindings = this.bitwardenBindings();
    this.touch();
    const fetched = await this.bitwarden.fetch(masterPassword, bindings);
    this.dropExternalValues();
    const expiresAt = Date.now() + BITWARDEN_CACHE_TTL_MS;
    for (const [name, value] of fetched.values) this.externalValues.set(name, { value, expiresAt });
    this.externalTimer = setTimeout(() => this.bitwardenLock(), BITWARDEN_CACHE_TTL_MS);
    this.externalTimer.unref();
    this.rebuildRedactor();
    await this.auditEventBestEffort(
      "bitwarden_unlocked",
      null,
      `loaded=${[...fetched.values.keys()].join(",")} missing=${fetched.missing.map((m) => m.secretName).join(",")}`,
    );
    this.emitChanged();
    return fetched.missing.map((entry) => ({ secret: entry.secretName, reason: entry.reason }));
  }

  bitwardenLock(): void {
    this.dropExternalValues();
    this.rebuildRedactor();
    this.emitChanged();
    this.auditEventBestEffort("bitwarden_locked", null, "Bitwarden values dropped").catch(
      (error: unknown) => this.logger.error({ err: error }, "Bitwarden lock audit failed"),
    );
  }

  async bitwardenSearch(masterPassword: string, query: string): Promise<VaultBitwardenItem[]> {
    this.requireUnlocked();
    this.touch();
    return this.bitwarden.searchItems(masterPassword, query);
  }

  listSecrets(): VaultSecretMeta[] {
    const current = this.requireUnlocked();
    this.touch();
    return current.payload.secrets.map((record) => this.toMeta(record));
  }

  private toMeta(record: VaultSecretRecord): VaultSecretMeta {
    return {
      name: record.name,
      envName: record.envName,
      description: record.description,
      source: record.source,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastUsedAt: record.lastUsedAt,
      redactable: this.redactor.isRegistered(record.name),
    };
  }

  async setSecret(input: SetSecretInput): Promise<VaultSecretMeta> {
    VaultSecretNameSchema.parse(input.name);
    VaultEnvNameSchema.parse(input.envName);
    const stored = await this.mutate((draft) => {
      const existing = draft.secrets.find((candidate) => candidate.name === input.name);
      const timestamp = nowIso();
      let value: string | null = null;
      if (input.source.kind === "local") {
        value = input.value ?? existing?.value ?? null;
        if (value === null || value.length === 0) {
          throw new VaultError("invalid_argument", "A local secret needs a value.");
        }
      }
      const record: VaultSecretRecord = {
        name: input.name,
        envName: input.envName,
        description: input.description,
        source: input.source,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        lastUsedAt: existing?.lastUsedAt ?? null,
        value,
      };
      draft.secrets = [
        ...draft.secrets.filter((candidate) => candidate.name !== input.name),
        record,
      ];
      for (const grant of draft.grants) {
        for (const binding of grant.bindings) {
          if (binding.secret === input.name) binding.envName = input.envName;
        }
      }
      return record;
    });
    await this.auditEventBestEffort(
      "secret_set",
      null,
      `${input.name} -> ${input.envName} (${input.source.kind})`,
    );
    return this.toMeta(stored);
  }

  async deleteSecret(name: string): Promise<void> {
    await this.mutate((draft) => {
      if (!draft.secrets.some((candidate) => candidate.name === name)) {
        throw new VaultError("not_found", `No secret named ${name}.`);
      }
      draft.secrets = draft.secrets.filter((candidate) => candidate.name !== name);
      for (const grant of draft.grants) {
        grant.bindings = grant.bindings.filter((binding) => binding.secret !== name);
      }
      draft.grants = draft.grants.filter((grant) => grant.bindings.length > 0);
    });
    this.externalValues.delete(name);
    this.rebuildRedactor();
    await this.auditEventBestEffort("secret_deleted", null, name);
  }

  /** Records a use. Persisting a timestamp must not fail a run that already happened. */
  async markUsed(secretNames: readonly string[], grantId: string | null): Promise<void> {
    const timestamp = nowIso();
    try {
      await this.mutate((draft) => {
        for (const secret of draft.secrets) {
          if (secretNames.includes(secret.name)) secret.lastUsedAt = timestamp;
        }
        const grant = draft.grants.find((candidate) => candidate.id === grantId);
        if (grant) grant.lastUsedAt = timestamp;
      });
    } catch (error) {
      this.logger.warn({ err: error }, "Could not record vault use");
    }
  }

  // --- grants

  private toGrant(record: VaultGrantRecord): VaultGrant {
    return { ...record, runsProjectCode: runsProjectCode(record.executable) };
  }

  listGrants(): VaultGrant[] {
    const current = this.requireUnlocked();
    this.touch();
    return current.payload.grants.map((record) => this.toGrant(record));
  }

  /** Grant records for matching. Internal to the daemon. */
  grantRecords(): readonly VaultGrantRecord[] {
    return this.requireUnlocked().payload.grants;
  }

  async setGrant(input: SetGrantInput): Promise<VaultGrant> {
    if (!path.isAbsolute(input.executable)) {
      throw new VaultError("invalid_argument", "The executable must be an absolute path.");
    }
    const executable = await realpath(input.executable).catch((error: unknown) => {
      throw new VaultError("invalid_argument", "The executable does not exist.", { cause: error });
    });
    const record = await this.mutate((draft) => {
      for (const binding of input.bindings) {
        const secret = draft.secrets.find((candidate) => candidate.name === binding.secret);
        if (!secret) throw new VaultError("not_found", `No secret named ${binding.secret}.`);
      }
      const existing = input.id
        ? draft.grants.find((candidate) => candidate.id === input.id)
        : null;
      if (input.id && !existing) throw new VaultError("not_found", "No such grant.");
      const next: VaultGrantRecord = {
        id: existing?.id ?? randomBytes(6).toString("hex"),
        executable,
        argvPrefix: input.argvPrefix,
        bindings: input.bindings,
        projectId: input.projectId,
        createdAt: existing?.createdAt ?? nowIso(),
        lastUsedAt: existing?.lastUsedAt ?? null,
      };
      draft.grants = [...draft.grants.filter((candidate) => candidate.id !== next.id), next];
      return next;
    });
    await this.auditEventBestEffort("grant_set", null, this.describeGrant(record));
    return this.toGrant(record);
  }

  async deleteGrant(id: string): Promise<void> {
    const removed = await this.mutate((draft) => {
      const grant = draft.grants.find((candidate) => candidate.id === id);
      if (!grant) throw new VaultError("not_found", "No such grant.");
      draft.grants = draft.grants.filter((candidate) => candidate.id !== id);
      return grant;
    });
    await this.auditEventBestEffort("grant_deleted", null, this.describeGrant(removed));
  }

  private describeGrant(grant: VaultGrantRecord): string {
    const secrets = grant.bindings.map((binding) => binding.secret).join(",");
    return `${[grant.executable, ...grant.argvPrefix].join(" ")} [${secrets}]${grant.projectId ? ` project=${grant.projectId}` : ""}`;
  }

  // --- approvals

  private pruneRequests(): void {
    const cutoff = Date.now() - REQUEST_TTL_MS;
    let changed = false;
    for (const [id, entry] of this.pending) {
      if (Date.parse(entry.request.createdAt) < cutoff && entry.waiters.size === 0) {
        this.pending.delete(id);
        changed = true;
      }
    }
    for (const [key, expiresAt] of this.tickets) {
      if (expiresAt <= Date.now()) this.tickets.delete(key);
    }
    if (changed) this.emitChanged();
  }

  listRequests(): VaultRequest[] {
    this.requireUnlocked();
    this.pruneRequests();
    return [...this.pending.values()].map((entry) => entry.request);
  }

  /** Consumes a one-time approval left by `resolveRequest` after the original call gave up. */
  consumeTicket(input: Pick<ApprovalInput, "agentId" | "cwd" | "argv" | "secrets">): boolean {
    this.pruneRequests();
    const key = runKey({ ...input, secrets: input.secrets.map((binding) => binding.secret) });
    return this.tickets.delete(key);
  }

  /**
   * Files a request for the operator and waits for the decision, up to `waitMs`. The same call
   * repeated while the request is pending joins it instead of filing another.
   */
  async requestApproval(
    input: ApprovalInput,
    options: { waitMs: number; signal?: AbortSignal },
  ): Promise<ApprovalOutcome> {
    this.requireUnlocked();
    this.pruneRequests();
    const key = runKey({ ...input, secrets: input.secrets.map((binding) => binding.secret) });
    let entry = [...this.pending.values()].find((candidate) => candidate.runKey === key);
    if (!entry) {
      entry = {
        request: {
          id: randomUUID(),
          createdAt: nowIso(),
          agentId: input.agentId,
          projectId: input.projectId,
          cwd: input.cwd,
          argv: input.argv,
          secrets: input.secrets,
          runsProjectCode: runsProjectCode(input.argv[0]) || isInside(input.argv[0], input.cwd),
        },
        runKey: key,
        waiters: new Set(),
      };
      this.pending.set(entry.request.id, entry);
      await this.auditEventBestEffort(
        "request_created",
        input.agentId,
        `${input.argv.join(" ")} [${input.secrets.map((binding) => binding.secret).join(",")}]`,
      );
      this.emitChanged();
    }
    const joined = entry;
    return new Promise<ApprovalOutcome>((resolve, reject) => {
      const finish = (): void => {
        clearTimeout(timer);
        joined.waiters.delete(waiter);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const waiter: ApprovalWaiter = (outcome) => {
        finish();
        if (outcome === "locked") reject(new VaultError("locked", "The vault was locked."));
        else resolve({ kind: "decided", decision: outcome });
      };
      const timer = setTimeout(() => {
        finish();
        resolve({ kind: "timeout", requestId: joined.request.id });
      }, options.waitMs);
      const onAbort = (): void => {
        finish();
        resolve({ kind: "timeout", requestId: joined.request.id });
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      joined.waiters.add(waiter);
    });
  }

  async resolveRequest(input: ResolveRequestInput): Promise<void> {
    this.requireUnlocked();
    const entry = this.pending.get(input.requestId);
    if (!entry) throw new VaultError("not_found", "That request is no longer pending.");
    const { request } = entry;
    if (input.decision === "always") {
      const args = request.argv.slice(1);
      if (input.argvPrefixLength > args.length) {
        throw new VaultError("invalid_argument", "The prefix is longer than the command.");
      }
      await this.setGrant({
        id: null,
        executable: request.argv[0],
        argvPrefix: args.slice(0, input.argvPrefixLength),
        bindings: request.secrets,
        projectId: input.scopeToProject ? request.projectId : null,
      });
    }
    this.pending.delete(input.requestId);
    if (entry.waiters.size > 0) {
      for (const waiter of entry.waiters) waiter(input.decision);
    } else if (input.decision === "once") {
      this.tickets.set(entry.runKey, Date.now() + APPROVAL_TICKET_TTL_MS);
    }
    await this.auditEventBestEffort(
      "request_resolved",
      request.agentId,
      `${input.decision}: ${request.argv.join(" ")}`,
    );
    this.touch();
    this.emitChanged();
  }

  // --- environment

  listEnvCandidates(): VaultEnvCandidate[] {
    const current = this.requireUnlocked();
    const scrubbed = new Set(current.header.envScrubNames.map(envNameKey));
    const names = new Set<string>(current.header.envScrubNames);
    for (const name of Object.keys(this.env)) {
      if (CREDENTIAL_NAME_PATTERN.test(name)) names.add(name);
    }
    return [...names].sort().map((name) => ({ name, scrubbed: scrubbed.has(envNameKey(name)) }));
  }

  async importEnv(input: {
    names: string[];
    action: VaultEnvImportAction;
  }): Promise<EnvImportResult> {
    this.requireUnlocked();
    const result: EnvImportResult = { imported: [], scrubbed: [], skipped: [] };
    const values = new Map<string, string>();
    for (const name of input.names) {
      if (!VaultEnvNameSchema.safeParse(name).success) {
        result.skipped.push({ name, reason: "invalid_name" });
        continue;
      }
      const value = this.env[name];
      if (input.action === "import" && (value === undefined || value.length === 0)) {
        result.skipped.push({ name, reason: "not_set" });
        continue;
      }
      if (value !== undefined) values.set(name, value);
    }
    await this.mutate((draft) => {
      for (const name of input.names) {
        if (result.skipped.some((skip) => skip.name === name)) continue;
        if (input.action === "scrub_only") {
          if (!draft.scrubOnly.includes(name)) draft.scrubOnly.push(name);
          result.scrubbed.push(name);
          continue;
        }
        const secretName = name.toLowerCase().replace(/^[^a-z]+/, "");
        const taken = draft.secrets.some((candidate) => candidate.name === secretName);
        if (!VaultSecretNameSchema.safeParse(secretName).success || taken) {
          result.skipped.push({ name, reason: taken ? "name_taken" : "invalid_name" });
          continue;
        }
        const timestamp = nowIso();
        draft.secrets.push({
          name: secretName,
          envName: name,
          description: "Imported from the daemon environment",
          source: { kind: "local" },
          createdAt: timestamp,
          updatedAt: timestamp,
          lastUsedAt: null,
          value: values.get(name) ?? null,
        });
        result.imported.push(name);
      }
    });
    await this.auditEventBestEffort(
      "env_imported",
      null,
      `imported=${result.imported.join(",")} scrubbed=${result.scrubbed.join(",")}`,
    );
    return result;
  }

  // --- redaction and audit

  /** Text that may contain secret values, made safe to hand to a client, log or agent. */
  redact(text: string): string {
    return this.redactor.redact(text);
  }

  /** Streaming form for output that arrives in pieces. */
  redactStream(): ReturnType<Redactor["stream"]> {
    return this.redactor.stream();
  }

  get redactionActive(): boolean {
    return !this.redactor.isEmpty;
  }

  async listAudit(limit: number): Promise<VaultAuditEntry[]> {
    return this.audit.list(limit);
  }

  /** Fails the caller when the record cannot be written: a use without a record must not happen. */
  async auditEvent(event: VaultAuditEvent, agentId: string | null, detail: string): Promise<void> {
    await this.audit.append({ at: nowIso(), event, agentId, detail: this.redactor.redact(detail) });
  }

  async auditEventBestEffort(
    event: VaultAuditEvent,
    agentId: string | null,
    detail: string,
  ): Promise<void> {
    try {
      await this.auditEvent(event, agentId, detail);
    } catch (error) {
      this.logger.warn({ err: error, event }, "Could not write a vault audit record");
    }
  }

  // --- running programs with secrets

  async run(input: RunInput): Promise<RunOutcome> {
    const unlocked = this.requireUnlocked();
    this.touch();
    const names = [...new Set(input.secrets)];
    const defaults: VaultGrantBinding[] = names.map((name) => {
      const record = unlocked.payload.secrets.find((candidate) => candidate.name === name);
      if (!record) throw new VaultError("not_found", `No secret named ${name}.`);
      return { secret: name, envName: record.envName };
    });
    const cwdInfo = await stat(input.cwd).catch((error: unknown) => {
      throw new VaultError("invalid_argument", "The working directory does not exist.", {
        cause: error,
      });
    });
    if (!cwdInfo.isDirectory()) {
      throw new VaultError("invalid_argument", "The working directory is not a directory.");
    }
    const executable = await resolveExecutable(input.argv[0], {
      cwd: input.cwd,
      searchPath: this.env.PATH ?? "",
    });
    const args = input.argv.slice(1);
    const argv = [executable, ...args];

    let bindings = defaults;
    let grantId: string | null = null;
    const grant = matchGrant(this.grantRecords(), {
      executable,
      args,
      projectId: input.projectId,
      secrets: names,
    });
    if (grant) {
      bindings = bindingsForRun(grant, names);
      grantId = grant.id;
    } else {
      const approval = {
        agentId: input.agentId,
        projectId: input.projectId,
        cwd: input.cwd,
        argv,
        secrets: defaults,
      };
      if (!this.consumeTicket(approval)) {
        const outcome = await this.requestApproval(approval, {
          waitMs: input.approvalWaitMs,
          signal: input.signal,
        });
        if (outcome.kind === "timeout")
          return { status: "awaiting_approval", requestId: outcome.requestId };
        if (outcome.decision === "deny") {
          await this.auditEventBestEffort(
            "run_refused",
            input.agentId,
            `denied: ${argv.join(" ")}`,
          );
          return { status: "denied" };
        }
      }
    }

    const envNames = new Set(bindings.map((binding) => envNameKey(binding.envName)));
    if (envNames.size !== bindings.length) {
      throw new VaultError(
        "invalid_argument",
        "Two requested secrets use the same environment variable.",
      );
    }
    const injected: Record<string, string> = {};
    for (const binding of bindings) injected[binding.envName] = this.secretValue(binding.secret);

    await this.auditEvent(
      "run",
      input.agentId,
      `${argv.join(" ")} [${names.join(",")}] cwd=${input.cwd}${grantId ? ` grant=${grantId}` : ""}`,
    );
    const result = await runProgram({
      executable,
      args,
      cwd: input.cwd,
      env: createExternalProcessEnv(this.env, injected),
      timeoutMs: Math.min(input.timeoutMs, RUN_MAX_TIMEOUT_MS),
      redact: () => this.redactStream(),
      signal: input.signal,
    });
    await this.markUsed(names, grantId);
    await this.auditEventBestEffort(
      "run",
      input.agentId,
      `finished ${path.basename(executable)} exit=${result.exitCode ?? "none"} signal=${result.signal ?? "none"} timedOut=${result.timedOut} truncated=${result.truncated.stdout || result.truncated.stderr}`,
    );
    return { status: "completed", result };
  }
}
