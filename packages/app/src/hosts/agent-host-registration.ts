import {
  normalizeHostPort,
  parseHostPort,
  serializeConnectionUriForStorage,
  serializeRelayConnectionUri,
} from "@pimi/protocol/daemon-endpoints";
import type { HostSummary } from "@pimi/protocol/hosts";
import {
  closeRemoteSshAgentEndpoint,
  ensureRemoteSshAgentEndpoint,
  getDesktopDaemonStatus,
} from "@/desktop/daemon/desktop-daemon";
import type { DaemonClient } from "@pimi/client/internal/daemon-client";
import type { HostRuntimeStore } from "@/runtime/host-runtime";
import type { HostConnection, HostProfile } from "@/types/host-connection";

/**
 * The desktop app puts the hosts it has saved into the daemon it manages, so an agent on this
 * computer can start agents on them. A registration is keyed `app-host:<serverId>`; rows other
 * producers wrote (CLI, plugins) are never touched.
 */
const SOURCE_KEY_PREFIX = "app-host:";

export function agentHostSourceKey(serverId: string): string {
  return `${SOURCE_KEY_PREFIX}${serverId}`;
}

export type AgentHostTarget =
  | { kind: "ssh"; host: string; sshPort?: number; daemonPort?: number }
  | { kind: "uri"; connection: string };

/**
 * The connection the local daemon should use for this profile, or null when it has no usable one.
 * Order: SSH (through the desktop's endpoint socket), direct TCP, relay. A `routed` connection is
 * this app's own discovery of a host the daemon already knows, so it is never registered back.
 */
export function agentHostTarget(profile: HostProfile): AgentHostTarget | null {
  const first = <T extends HostConnection["type"]>(type: T) =>
    profile.connections.find(
      (connection): connection is Extract<HostConnection, { type: T }> => connection.type === type,
    );
  const ssh = first("remoteSsh");
  if (ssh) {
    return {
      kind: "ssh",
      host: ssh.host,
      ...(ssh.sshPort !== undefined ? { sshPort: ssh.sshPort } : {}),
      ...(ssh.daemonPort !== undefined ? { daemonPort: ssh.daemonPort } : {}),
    };
  }
  const tcp = first("directTcp");
  if (tcp) {
    const parts = parseHostPort(normalizeHostPort(tcp.endpoint));
    return {
      kind: "uri",
      connection: serializeConnectionUriForStorage({
        ...parts,
        useTls: tcp.useTls ?? false,
        ...(profile.password ? { password: profile.password } : {}),
      }),
    };
  }
  const relay = first("relay");
  if (relay) {
    return {
      kind: "uri",
      connection: serializeRelayConnectionUri({
        offer: {
          v: 2,
          serverId: profile.serverId,
          daemonPublicKeyB64: relay.daemonPublicKeyB64,
          relay: { endpoint: relay.relayEndpoint, useTls: relay.useTls ?? false },
          ...(relay.minimumSecurityMode ? { minimumSecurityMode: relay.minimumSecurityMode } : {}),
        },
        ...(profile.password ? { password: profile.password } : {}),
      }),
    };
  }
  return null;
}

export function isAgentHostEligible(profile: HostProfile, localServerId: string): boolean {
  return (
    profile.serverId !== localServerId &&
    profile.agentAccess !== false &&
    agentHostTarget(profile) !== null
  );
}

/** The directory row this app registered for `serverId`, if any. */
export function findAgentHostRow(
  hosts: readonly HostSummary[],
  serverId: string,
): HostSummary | null {
  const key = agentHostSourceKey(serverId);
  return hosts.find((row) => row.source.key === key) ?? null;
}

type SshTarget = Extract<AgentHostTarget, { kind: "ssh" }>;

function sshEndpointTarget(target: SshTarget) {
  return {
    host: target.host,
    ...(target.sshPort !== undefined ? { sshPort: target.sshPort } : {}),
    ...(target.daemonPort !== undefined ? { daemonPort: target.daemonPort } : {}),
  };
}

class AgentHostRegistrar {
  /** The directory never returns a connection string, so remember what this launch last sent. */
  private sent = new Map<string, string>();
  private sshTargets = new Map<string, SshTarget>();
  /** The app connection generation for which a stuck sign-in row was already restarted. */
  private restartedAt = new Map<string, number>();
  private localServerId: string | null = null;
  private running = false;
  private dirty = false;
  private disposed = false;
  private readonly unsubscribes: Array<() => void> = [];

  constructor(private readonly store: HostRuntimeStore) {}

  start(): () => void {
    const trigger = () => this.schedule();
    this.unsubscribes.push(
      this.store.subscribeHostList(trigger),
      this.store.subscribeHostDirectory(trigger),
      this.store.subscribeAll(trigger),
    );
    this.schedule();
    return () => {
      this.disposed = true;
      for (const unsubscribe of this.unsubscribes) unsubscribe();
    };
  }

  private schedule(): void {
    if (this.disposed) return;
    this.dirty = true;
    if (this.running) return;
    this.running = true;
    void this.drain();
  }

  private async drain(): Promise<void> {
    try {
      while (this.dirty && !this.disposed) {
        this.dirty = false;
        await this.reconcile().catch((error) => {
          console.warn("[agent-hosts] reconcile failed", error);
        });
      }
    } finally {
      this.running = false;
    }
  }

  private async resolveLocalServerId(): Promise<string | null> {
    if (this.localServerId) return this.localServerId;
    const status = await getDesktopDaemonStatus().catch(() => null);
    const serverId = status?.serverId.trim();
    if (!serverId) {
      // The managed daemon is still starting; look again shortly.
      setTimeout(() => this.schedule(), 1000);
      return null;
    }
    this.localServerId = serverId;
    return serverId;
  }

  private async reconcile(): Promise<void> {
    if (!this.store.isHostRegistryLoaded()) return;
    const localServerId = await this.resolveLocalServerId();
    if (!localServerId) return;
    const client = this.store.getClient(localServerId);
    const directory = this.store.getHostDirectory(localServerId);
    if (!client?.isConnected || !directory) return;

    const profiles = this.store.getHosts();
    const eligible = profiles.filter((profile) => isAgentHostEligible(profile, localServerId));
    const eligibleIds = new Set(eligible.map((profile) => profile.serverId));
    const ownRows = directory.hosts.filter((row) => row.source.key.startsWith(SOURCE_KEY_PREFIX));

    for (const row of ownRows) {
      const serverId = row.source.key.slice(SOURCE_KEY_PREFIX.length);
      if (eligibleIds.has(serverId)) continue;
      await client.removeHost(row.registrationId);
      this.sent.delete(row.source.key);
      await this.closeSshEndpoint(serverId, profiles);
    }

    for (const profile of eligible) {
      const key = agentHostSourceKey(profile.serverId);
      const row = ownRows.find((candidate) => candidate.source.key === key) ?? null;
      const claimedElsewhere = directory.hosts.some(
        (other) => other.serverId === profile.serverId && other.source.key !== key,
      );
      // Another producer registered this daemon; a second row would only fail as a duplicate.
      if (!row && claimedElsewhere) continue;
      const connection = await this.connectionFor(profile);
      if (connection) await this.apply(client, profile, row, connection);
    }
  }

  private async apply(
    client: DaemonClient,
    profile: HostProfile,
    row: HostSummary | null,
    connection: string,
  ): Promise<void> {
    const key = agentHostSourceKey(profile.serverId);
    if (!row) {
      await client.addHost({ connection, label: profile.label, sourceKey: key });
      this.sent.set(key, connection);
      return;
    }
    if (row.error?.code === "server_id_mismatch") return;
    const generation = this.store.getSnapshot(profile.serverId)?.clientGeneration ?? 0;
    const signInStuck = this.isSignInStuck(row, key, profile.serverId, generation);
    const patch: { label?: string; connection?: string } = {};
    if (row.label !== profile.label) patch.label = profile.label;
    if (this.sent.get(key) !== connection || signInStuck) patch.connection = connection;
    if (signInStuck) this.restartedAt.set(key, generation);
    if (patch.label === undefined && patch.connection === undefined) return;
    await client.updateHost(row.registrationId, patch);
    this.sent.set(key, connection);
  }

  private isSignInStuck(
    row: HostSummary,
    key: string,
    serverId: string,
    generation: number,
  ): boolean {
    return (
      row.status === "error" &&
      row.error?.code === "authentication_failed" &&
      this.store.getSnapshot(serverId)?.connectionStatus === "online" &&
      this.restartedAt.get(key) !== generation
    );
  }

  private async connectionFor(profile: HostProfile): Promise<string | null> {
    const target = agentHostTarget(profile);
    if (!target) return null;
    if (target.kind === "uri") return target.connection;
    try {
      const connection = await ensureRemoteSshAgentEndpoint(sshEndpointTarget(target));
      this.sshTargets.set(profile.serverId, target);
      return connection;
    } catch (error) {
      console.warn("[agent-hosts] ssh endpoint unavailable", profile.serverId, error);
      return null;
    }
  }

  private async closeSshEndpoint(serverId: string, profiles: HostProfile[]): Promise<void> {
    const target =
      this.sshTargets.get(serverId) ??
      (() => {
        const profile = profiles.find((candidate) => candidate.serverId === serverId);
        const next = profile ? agentHostTarget(profile) : null;
        return next?.kind === "ssh" ? next : undefined;
      })();
    if (!target) return;
    this.sshTargets.delete(serverId);
    await closeRemoteSshAgentEndpoint(sshEndpointTarget(target)).catch(() => undefined);
  }
}

export function startAgentHostRegistration(store: HostRuntimeStore): () => void {
  return new AgentHostRegistrar(store).start();
}
