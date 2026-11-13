import type { HostConnection } from "@/types/host-connection";

export interface ConnectionCandidate {
  connectionId: string;
  connection: HostConnection;
}

export type ConnectionProbeState =
  | { status: "pending"; latencyMs: null }
  | { status: "unavailable"; latencyMs: null }
  | { status: "available"; latencyMs: number };

export interface SelectBestConnectionInput {
  candidates: ConnectionCandidate[];
  probeByConnectionId: Map<string, ConnectionProbeState>;
}

function getAvailableLatency(input: {
  connectionId: string;
  probeByConnectionId: Map<string, ConnectionProbeState>;
}): number | null {
  const probe = input.probeByConnectionId.get(input.connectionId);
  return probe?.status === "available" ? probe.latencyMs : null;
}

/**
 * A routed connection goes through another host's daemon, so it is only a fallback: it is never
 * chosen while a direct connection is available, whatever the latencies say.
 */
export function selectBestConnection(input: SelectBestConnectionInput): string | null {
  const { candidates, probeByConnectionId } = input;
  let bestConnectionId: string | null = null;
  let bestRouted = true;
  let bestLatency: number | null = null;

  for (const candidate of candidates) {
    const latencyMs = getAvailableLatency({
      connectionId: candidate.connectionId,
      probeByConnectionId,
    });
    if (latencyMs === null) {
      continue;
    }
    const routed = candidate.connection.type === "routed";
    const better =
      bestLatency === null ||
      (bestRouted && !routed) ||
      (bestRouted === routed && latencyMs < bestLatency);
    if (better) {
      bestConnectionId = candidate.connectionId;
      bestRouted = routed;
      bestLatency = latencyMs;
    }
  }

  return bestConnectionId;
}
