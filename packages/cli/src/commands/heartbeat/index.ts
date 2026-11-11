import { Command } from "commander";
import type { HeartbeatCadence } from "@pimi/protocol/heartbeat/types";
import type {
  CommandError,
  CommandOptions,
  ListResult,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { parseDuration } from "../../utils/duration.js";
import {
  callerAgentId,
  heartbeatSchema,
  parsePositiveInt,
  toHeartbeatRow,
  withAutomationClient,
  type HeartbeatRow,
} from "../automation/shared.js";

interface HeartbeatCadenceOptions extends CommandOptions {
  cron?: string;
  timezone?: string;
  every?: string;
  in?: string;
  at?: string;
}

interface HeartbeatCreateOptions extends HeartbeatCadenceOptions {
  name?: string;
  maxRuns?: string;
  expiresIn?: string;
}

interface HeartbeatDeleteRow {
  id: string;
  status: "deleted";
}

const heartbeatDeleteSchema: OutputSchema<HeartbeatDeleteRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id" },
    { header: "STATUS", field: "status" },
  ],
};

function requireCallerAgentId(): string {
  const agentId = callerAgentId();
  if (!agentId) {
    throw new Error("Heartbeat commands must run inside a Pimi agent");
  }
  return agentId;
}

function parseCadence(options: HeartbeatCadenceOptions): HeartbeatCadence {
  const cron = options.cron?.trim();
  const timezone = options.timezone?.trim();
  const given = [cron, options.every, options.in, options.at].filter(Boolean);
  if (given.length !== 1) {
    throw {
      code: "INVALID_CADENCE",
      message: "Give exactly one of --cron, --every, --in, or --at",
    } satisfies CommandError;
  }
  if (timezone && !cron) {
    throw { code: "INVALID_CADENCE", message: "--timezone needs --cron" } satisfies CommandError;
  }
  if (cron) {
    return { type: "cron", expression: cron, ...(timezone ? { timezone } : {}) };
  }
  if (options.every) {
    return { type: "every", everyMs: parseDuration(options.every) };
  }
  if (options.in) {
    return { type: "once", at: new Date(Date.now() + parseDuration(options.in)).toISOString() };
  }
  const at = new Date(options.at!);
  if (Number.isNaN(at.getTime())) {
    throw {
      code: "INVALID_TIME",
      message: `Invalid --at time: ${options.at}`,
    } satisfies CommandError;
  }
  return { type: "once", at: at.toISOString() };
}

async function requireOwnedHeartbeat(
  client: Parameters<Parameters<typeof withAutomationClient>[3]>[0],
  id: string,
  agentId: string,
): Promise<void> {
  const { heartbeats } = await client.heartbeatList({ agentId });
  if (!heartbeats.some((heartbeat) => heartbeat.id === id)) {
    throw new Error(`Heartbeat ${id} does not belong to agent ${agentId}`);
  }
}

async function runCreateHeartbeat(
  prompt: string,
  options: HeartbeatCreateOptions,
  _command: Command,
): Promise<SingleResult<HeartbeatRow>> {
  const agentId = requireCallerAgentId();
  const cadence = parseCadence(options);
  const maxRuns = options.maxRuns ? parsePositiveInt(options.maxRuns, "--max-runs") : undefined;
  const expiresAt = options.expiresIn
    ? new Date(Date.now() + parseDuration(options.expiresIn)).toISOString()
    : undefined;
  return withAutomationClient(
    options,
    "HEARTBEAT_CREATE_FAILED",
    "create heartbeat",
    async (client) => {
      const { heartbeat } = await client.heartbeatCreate({
        agentId,
        prompt: prompt.trim(),
        cadence,
        ...(options.name?.trim() ? { name: options.name.trim() } : {}),
        ...(maxRuns ? { maxRuns } : {}),
        ...(expiresAt ? { expiresAt } : {}),
      });
      return { type: "single", data: toHeartbeatRow(heartbeat), schema: heartbeatSchema };
    },
  );
}

async function runUpdateHeartbeat(
  id: string,
  options: HeartbeatCadenceOptions,
  _command: Command,
): Promise<SingleResult<HeartbeatRow>> {
  const agentId = requireCallerAgentId();
  const cadence = parseCadence(options);
  return withAutomationClient(
    options,
    "HEARTBEAT_UPDATE_FAILED",
    "update heartbeat",
    async (client) => {
      await requireOwnedHeartbeat(client, id, agentId);
      const { heartbeat } = await client.heartbeatUpdate({ heartbeatId: id, cadence });
      return { type: "single", data: toHeartbeatRow(heartbeat), schema: heartbeatSchema };
    },
  );
}

async function runDeleteHeartbeat(
  id: string,
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<HeartbeatDeleteRow>> {
  const agentId = requireCallerAgentId();
  return withAutomationClient(
    options,
    "HEARTBEAT_DELETE_FAILED",
    "delete heartbeat",
    async (client) => {
      await requireOwnedHeartbeat(client, id, agentId);
      const payload = await client.heartbeatDelete({ heartbeatId: id });
      return {
        type: "single",
        data: { id: payload.heartbeatId, status: "deleted" },
        schema: heartbeatDeleteSchema,
      };
    },
  );
}

async function runListHeartbeats(
  options: CommandOptions,
  _command: Command,
): Promise<ListResult<HeartbeatRow>> {
  const agentId = callerAgentId();
  return withAutomationClient(
    options,
    "HEARTBEAT_LIST_FAILED",
    "list heartbeats",
    async (client) => {
      const { heartbeats } = await client.heartbeatList(agentId ? { agentId } : {});
      return { type: "list", data: heartbeats.map(toHeartbeatRow), schema: heartbeatSchema };
    },
  );
}

function addCadenceOptions(command: Command): Command {
  return command
    .option("--cron <expr>", "Five-field cron cadence")
    .option("--timezone <iana>", "IANA time zone for --cron")
    .option("--every <duration>", "Repeat at this interval, at least 30s (for example: 90s, 15m)")
    .option("--in <duration>", "Fire once after this long (for example: 20m)")
    .option("--at <time>", "Fire once at this ISO 8601 time");
}

export function createHeartbeatCommand(): Command {
  const heartbeat = new Command("heartbeat").description("Manage this agent's heartbeats");
  addJsonAndDaemonHostOptions(
    addCadenceOptions(
      heartbeat
        .command("create")
        .description("Send this agent a prompt later: on a cadence, at an interval, or once")
        .argument("<prompt>", "Prompt to send"),
    )
      .option("--name <name>", "Heartbeat name; creating one with the same name replaces it")
      .option("--max-runs <n>", "Maximum number of runs")
      .option("--expires-in <duration>", "Time to live"),
  ).action(withOutput(runCreateHeartbeat));
  addJsonAndDaemonHostOptions(
    addCadenceOptions(
      heartbeat
        .command("update")
        .description("Change when a heartbeat fires")
        .argument("<id>", "Heartbeat ID"),
    ),
  ).action(withOutput(runUpdateHeartbeat));
  addJsonAndDaemonHostOptions(
    heartbeat.command("delete").description("Delete a heartbeat").argument("<id>", "Heartbeat ID"),
  ).action(withOutput(runDeleteHeartbeat));
  addJsonAndDaemonHostOptions(
    heartbeat
      .command("ls")
      .description("List heartbeats (this agent's inside an agent, all otherwise)"),
  ).action(withOutput(runListHeartbeats));
  return heartbeat;
}
