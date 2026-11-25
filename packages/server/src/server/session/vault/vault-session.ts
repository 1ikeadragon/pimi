import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import { VaultError } from "../../vault/errors.js";
import type { VaultService } from "../../vault/service.js";

// How long a connection counts as the operator after it proves the passphrase. Operator actions
// are the ones an agent must not be able to take for itself: changing secrets or grants and
// answering approval requests. Ten minutes covers a configuration session; a longer pause asks
// for the passphrase again. The mark is per physical socket (the `source` object), kept in memory
// only, so reconnecting, resuming a session or restarting the daemon all drop it.
export const OPERATOR_TTL_MS = 10 * 60 * 1000;

interface VaultSessionOptions {
  host: { emit(msg: SessionOutboundMessage): void };
  vault: VaultService;
  logger: pino.Logger;
}

interface OperatorMark {
  until: number;
  lockEpoch: number;
}

type VaultRequestType = Extract<SessionInboundMessage["type"], `vault.${string}`>;
type VaultRequest = Extract<SessionInboundMessage, { type: VaultRequestType }>;
type BitwardenRequest = Extract<VaultRequest, { type: `vault.source.bitwarden.${string}` }>;

export class VaultSession {
  private readonly host: VaultSessionOptions["host"];
  private readonly vault: VaultService;
  private readonly logger: pino.Logger;
  private readonly operators = new WeakMap<object, OperatorMark>();

  constructor(options: VaultSessionOptions) {
    this.host = options.host;
    this.vault = options.vault;
    this.logger = options.logger;
  }

  dispatch(msg: SessionInboundMessage, source?: object): Promise<void> | undefined {
    if (!isVaultRequest(msg)) return undefined;
    if (!this.vault.enabled) {
      this.emitFailure(
        msg,
        new VaultError("disabled", "The vault is turned off. Turn it on in Settings, Vault."),
      );
      return Promise.resolve();
    }
    return this.handle(msg, source);
  }

  private operatorUntil(source: object | undefined): number | null {
    if (!source) return null;
    const mark = this.operators.get(source);
    if (!mark || mark.until <= Date.now() || mark.lockEpoch !== this.vault.lockEpoch) return null;
    return mark.until;
  }

  private markOperator(source: object | undefined): void {
    if (!source)
      throw new VaultError("not_operator", "This connection cannot hold operator status.");
    this.operators.set(source, {
      until: Date.now() + OPERATOR_TTL_MS,
      lockEpoch: this.vault.lockEpoch,
    });
  }

  private requireOperator(source: object | undefined): void {
    if (this.operatorUntil(source) === null) {
      throw new VaultError(
        "not_operator",
        "Enter the vault passphrase to continue. Agents cannot do this.",
      );
    }
  }

  private status(source: object | undefined) {
    return this.vault.getStatus(this.operatorUntil(source));
  }

  private async handle(msg: VaultRequest, source: object | undefined): Promise<void> {
    try {
      this.host.emit(await this.respond(msg, source));
    } catch (error) {
      this.emitFailure(msg, error);
    }
  }

  private emitFailure(msg: VaultRequest, error: unknown): void {
    let message = "The vault request failed.";
    let code = "vault_failed";
    if (error instanceof VaultError) {
      message = error.message;
      code = `vault_${error.code}`;
      if (error.retryAfterMs !== undefined) {
        message = `${message} Try again in ${Math.ceil(error.retryAfterMs / 1000)} s.`;
      }
      this.logger.warn({ requestType: msg.type, code }, "Vault request refused");
    } else {
      this.logger.error({ err: error, requestType: msg.type }, "Vault request failed");
    }
    this.host.emit({
      type: "rpc_error",
      payload: { requestId: msg.requestId, requestType: msg.type, error: message, code },
    });
  }

  private async respond(
    msg: VaultRequest,
    source: object | undefined,
  ): Promise<SessionOutboundMessage> {
    switch (msg.type) {
      case "vault.get_status.request":
        return {
          type: "vault.get_status.response",
          payload: { requestId: msg.requestId, status: this.status(source) },
        };
      case "vault.initialize.request":
        await this.vault.initialize(msg.passphrase);
        this.markOperator(source);
        return {
          type: "vault.initialize.response",
          payload: { requestId: msg.requestId, status: this.status(source) },
        };
      case "vault.unlock.request":
        await this.vault.unlock(msg.passphrase);
        this.markOperator(source);
        return {
          type: "vault.unlock.response",
          payload: { requestId: msg.requestId, status: this.status(source) },
        };
      case "vault.lock.request":
        await this.vault.lock();
        return {
          type: "vault.lock.response",
          payload: { requestId: msg.requestId, status: this.status(source) },
        };
      case "vault.authorize.request":
        await this.vault.verifyPassphrase(msg.passphrase);
        this.markOperator(source);
        await this.vault.auditEventBestEffort("operator_granted", null, "Connection authorized");
        return {
          type: "vault.authorize.response",
          payload: { requestId: msg.requestId, status: this.status(source) },
        };
      case "vault.list_secrets.request":
        return {
          type: "vault.list_secrets.response",
          payload: { requestId: msg.requestId, secrets: this.vault.listSecrets() },
        };
      case "vault.set_secret.request":
        this.requireOperator(source);
        return {
          type: "vault.set_secret.response",
          payload: {
            requestId: msg.requestId,
            secret: await this.vault.setSecret({
              name: msg.name,
              envName: msg.envName,
              description: msg.description,
              source: msg.source,
              value: msg.value,
            }),
          },
        };
      case "vault.delete_secret.request":
        this.requireOperator(source);
        await this.vault.deleteSecret(msg.name);
        return {
          type: "vault.delete_secret.response",
          payload: { requestId: msg.requestId, name: msg.name },
        };
      case "vault.list_grants.request":
        return {
          type: "vault.list_grants.response",
          payload: { requestId: msg.requestId, grants: this.vault.listGrants() },
        };
      case "vault.set_grant.request":
        this.requireOperator(source);
        return {
          type: "vault.set_grant.response",
          payload: {
            requestId: msg.requestId,
            grant: await this.vault.setGrant({
              id: msg.grantId,
              executable: msg.executable,
              argvPrefix: msg.argvPrefix,
              bindings: msg.bindings,
              projectId: msg.projectId,
            }),
          },
        };
      case "vault.delete_grant.request":
        this.requireOperator(source);
        await this.vault.deleteGrant(msg.grantId);
        return {
          type: "vault.delete_grant.response",
          payload: { requestId: msg.requestId, grantId: msg.grantId },
        };
      case "vault.list_requests.request":
        return {
          type: "vault.list_requests.response",
          payload: { requestId: msg.requestId, requests: this.vault.listRequests() },
        };
      case "vault.resolve_request.request":
        this.requireOperator(source);
        await this.vault.resolveRequest({
          requestId: msg.vaultRequestId,
          decision: msg.decision,
          argvPrefixLength: msg.argvPrefixLength,
          scopeToProject: msg.scopeToProject,
        });
        return {
          type: "vault.resolve_request.response",
          payload: { requestId: msg.requestId, vaultRequestId: msg.vaultRequestId },
        };
      case "vault.list_audit.request":
        return {
          type: "vault.list_audit.response",
          payload: { requestId: msg.requestId, entries: await this.vault.listAudit(msg.limit) },
        };
      case "vault.env.list_candidates.request":
        return {
          type: "vault.env.list_candidates.response",
          payload: { requestId: msg.requestId, candidates: this.vault.listEnvCandidates() },
        };
      case "vault.env.import.request": {
        this.requireOperator(source);
        const result = await this.vault.importEnv({ names: msg.names, action: msg.action });
        return {
          type: "vault.env.import.response",
          payload: { requestId: msg.requestId, ...result },
        };
      }
      default:
        return this.respondBitwarden(msg, source);
    }
  }

  private async respondBitwarden(
    msg: BitwardenRequest,
    source: object | undefined,
  ): Promise<SessionOutboundMessage> {
    switch (msg.type) {
      case "vault.source.bitwarden.get_status.request":
        return {
          type: "vault.source.bitwarden.get_status.response",
          payload: { requestId: msg.requestId, status: await this.vault.bitwardenStatus() },
        };
      case "vault.source.bitwarden.unlock.request": {
        this.requireOperator(source);
        const missing = await this.vault.bitwardenUnlock(msg.masterPassword);
        return {
          type: "vault.source.bitwarden.unlock.response",
          payload: {
            requestId: msg.requestId,
            status: await this.vault.bitwardenStatus(),
            missing,
          },
        };
      }
      case "vault.source.bitwarden.lock.request":
        this.vault.bitwardenLock();
        return {
          type: "vault.source.bitwarden.lock.response",
          payload: { requestId: msg.requestId, status: await this.vault.bitwardenStatus() },
        };
      case "vault.source.bitwarden.search_items.request":
        this.requireOperator(source);
        return {
          type: "vault.source.bitwarden.search_items.response",
          payload: {
            requestId: msg.requestId,
            items: await this.vault.bitwardenSearch(msg.masterPassword, msg.query),
          },
        };
      default:
        return assertNever(msg);
    }
  }
}

function isVaultRequest(msg: SessionInboundMessage): msg is VaultRequest {
  return msg.type.startsWith("vault.");
}

function assertNever(value: never): never {
  throw new Error(`Unhandled vault request ${JSON.stringify(value)}`);
}
