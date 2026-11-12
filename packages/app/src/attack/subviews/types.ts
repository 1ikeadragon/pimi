import type { AttackRun } from "@pimi/protocol/attack/types";
import type { AttackRunAgent } from "../use-attack-run-agents";

/** What the board hands every subview. `live` is whether the run is running or paused. */
export interface AttackSubviewProps {
  serverId: string;
  workspaceId: string;
  run: AttackRun;
  agents: AttackRunAgent[];
  live: boolean;
}
