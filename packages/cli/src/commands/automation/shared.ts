import type { DaemonClient } from "@pimi/client/internal/daemon-client";
import type {
  Automation,
  AutomationActor,
  AutomationRun,
  AutomationRunCause,
} from "@pimi/protocol/automation/types";
import type { Heartbeat } from "@pimi/protocol/heartbeat/types";
import { everyMsToFiveFieldCron } from "@pimi/protocol/schedule/cadence";
import type { CommandError, CommandOptions, OutputSchema } from "../../output/index.js";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { DaemonTarget } from "../../utils/daemon-target.js";
import { parseDuration } from "../../utils/duration.js";

export type AutomationCommandOptions = CommandOptions;

export async function connectAutomationClient(target: DaemonTarget): Promise<DaemonClient> {
  const host = getDaemonHost({ target });
  try {
    return await connectToDaemon({ target });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
      details: "Start the daemon with: pimi daemon start",
    } satisfies CommandError;
  }
}

export async function withAutomationClient<T>(
  options: CommandOptions,
  errorCode: string,
  action: string,
  work: (client: DaemonClient) => Promise<T>,
): Promise<T> {
  const client = await connectAutomationClient(options.daemonTarget);
  try {
    return await work(client);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && !(error instanceof Error)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw { code: errorCode, message: `Failed to ${action}: ${message}` } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}

// The agent this command runs inside, if any. Automations made from inside an agent wait for
// the owner's approval, and an agent cannot approve one.
export function callerAgentId(): string | null {
  return process.env.PASEO_AGENT_ID?.trim() || null;
}

export function compileEveryPresetToCron(value: string): string {
  const cron = everyMsToFiveFieldCron(parseDuration(value));
  if (cron) {
    return cron;
  }
  throw {
    code: "UNREPRESENTABLE_CADENCE",
    message: `${value} cannot be represented faithfully by five-field cron`,
    details: "Use --cron for calendar schedules",
  } satisfies CommandError;
}

export function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || `${parsed}` !== value.trim()) {
    throw {
      code: "INVALID_INTEGER",
      message: `${flag} must be a positive integer`,
    } satisfies CommandError;
  }
  return parsed;
}

export function formatDurationMs(durationMs: number): string {
  const parts: string[] = [];
  let remaining = durationMs;
  for (const [unit, size] of [
    ["h", 3_600_000],
    ["m", 60_000],
    ["s", 1000],
  ] as const) {
    const count = Math.floor(remaining / size);
    if (count > 0) {
      parts.push(`${count}${unit}`);
      remaining -= count * size;
    }
  }
  return parts.length > 0 ? parts.join("") : "0s";
}

export function formatTrigger(automation: Automation): string {
  if (automation.trigger.kind === "manual") {
    return "manual";
  }
  if (automation.trigger.kind === "pull_request") {
    return `pr:${automation.trigger.repo} (${automation.trigger.events.join(",")})`;
  }
  const cadence = automation.trigger.cadence;
  if (cadence.type === "every") {
    return `every:${formatDurationMs(cadence.everyMs)}`;
  }
  return `cron:${cadence.expression}${cadence.timezone ? ` (${cadence.timezone})` : ""}`;
}

export function formatHeartbeatCadence(heartbeat: Heartbeat): string {
  const cadence = heartbeat.cadence;
  if (cadence.type === "once") {
    return `once:${cadence.at}`;
  }
  if (cadence.type === "every") {
    return `every:${formatDurationMs(cadence.everyMs)}`;
  }
  return `cron:${cadence.expression}${cadence.timezone ? ` (${cadence.timezone})` : ""}`;
}

export function formatActor(actor: AutomationActor): string {
  return actor.kind === "agent" ? `agent:${actor.agentId.slice(0, 7)}` : actor.kind;
}

function formatProvider(automation: Automation): string {
  const providers = new Set(
    automation.flow.nodes.flatMap((node) =>
      node.kind === "agent" ? [`${node.provider}${node.model ? `/${node.model}` : ""}`] : [],
    ),
  );
  return providers.size > 0 ? [...providers].join(", ") : "-";
}

export function formatRunCause(cause: AutomationRunCause): string {
  if (cause.kind === "manual") {
    return "manual";
  }
  if (cause.kind === "retry") {
    return `retry of ${cause.runId}`;
  }
  const event = cause.event;
  if (event.kind === "schedule") {
    return `schedule ${event.scheduledFor}`;
  }
  return `pr ${event.repo}#${event.number} ${event.action}`;
}

export interface AutomationRow {
  id: string;
  name: string;
  trigger: string;
  provider: string;
  status: string;
  origin: string;
  nextRunAt: string | null;
  lastRun: string | null;
}

export function toAutomationRow(automation: Automation): AutomationRow {
  const status =
    automation.status === "paused" && automation.pausedReason === "failures"
      ? "paused (failures)"
      : automation.status;
  return {
    id: automation.id,
    name: automation.name,
    trigger: formatTrigger(automation),
    provider: formatProvider(automation),
    status,
    origin: formatActor(automation.origin),
    nextRunAt: automation.nextRunAt,
    lastRun: automation.lastRun
      ? `${automation.lastRun.status} ${automation.lastRun.startedAt}`
      : null,
  };
}

export const automationSchema: OutputSchema<AutomationRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 10 },
    { header: "NAME", field: "name", width: 24 },
    { header: "TRIGGER", field: "trigger", width: 20 },
    { header: "PROVIDER", field: "provider", width: 18 },
    { header: "STATUS", field: "status", width: 18 },
    { header: "ORIGIN", field: "origin", width: 14 },
    { header: "NEXT RUN", field: "nextRunAt", width: 24 },
  ],
};

export interface AutomationRunRow {
  id: string;
  status: string;
  cause: string;
  startedAt: string;
  endedAt: string | null;
  agentId: string | null;
  error: string | null;
}

export function toAutomationRunRow(run: AutomationRun): AutomationRunRow {
  return {
    id: run.id,
    status: run.status,
    cause: formatRunCause(run.cause),
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    agentId: run.reportAgentId,
    error: run.error,
  };
}

export const automationRunSchema: OutputSchema<AutomationRunRow> = {
  idField: "id",
  columns: [
    { header: "RUN ID", field: "id", width: 38 },
    { header: "STATUS", field: "status", width: 10 },
    { header: "CAUSE", field: "cause", width: 34 },
    { header: "STARTED", field: "startedAt", width: 24 },
    { header: "AGENT", field: "agentId", width: 38 },
    { header: "ERROR", field: "error", width: 40 },
  ],
};

export interface HeartbeatRow {
  id: string;
  name: string | null;
  cadence: string;
  agentId: string;
  nextRunAt: string | null;
  runs: string;
  lastRun: string | null;
}

export function toHeartbeatRow(heartbeat: Heartbeat): HeartbeatRow {
  return {
    id: heartbeat.id,
    name: heartbeat.name,
    cadence: formatHeartbeatCadence(heartbeat),
    agentId: heartbeat.agentId,
    nextRunAt: heartbeat.nextRunAt,
    runs: heartbeat.maxRuns
      ? `${heartbeat.runCount}/${heartbeat.maxRuns}`
      : `${heartbeat.runCount}`,
    lastRun: heartbeat.lastRun
      ? `${heartbeat.lastRun.status}${heartbeat.lastRun.error ? `: ${heartbeat.lastRun.error}` : ""}`
      : null,
  };
}

export const heartbeatSchema: OutputSchema<HeartbeatRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 10 },
    { header: "NAME", field: "name", width: 20 },
    { header: "CADENCE", field: "cadence", width: 32 },
    { header: "NEXT RUN", field: "nextRunAt", width: 24 },
    { header: "RUNS", field: "runs", width: 8 },
    { header: "LAST RUN", field: "lastRun", width: 30 },
  ],
};
