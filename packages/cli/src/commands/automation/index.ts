import { resolve } from "node:path";
import { Command } from "commander";
import type { AutomationDefinition, AutomationTrigger } from "@pimi/protocol/automation/types";
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
import { resolveProviderAndModel } from "../../utils/provider-model.js";
import {
  automationRunSchema,
  automationSchema,
  callerAgentId,
  compileEveryPresetToCron,
  parsePositiveInt,
  toAutomationRow,
  toAutomationRunRow,
  withAutomationClient,
  type AutomationRow,
  type AutomationRunRow,
} from "./shared.js";

interface AutomationCreateOptions extends CommandOptions {
  name?: string;
  every?: string;
  cron?: string;
  timezone?: string;
  provider?: string;
  mode?: string;
  thinking?: string;
  cwd?: string;
  worktree?: boolean;
  maxRuns?: string;
  expiresIn?: string;
}

interface AutomationRunsOptions extends CommandOptions {
  limit?: string;
}

interface InspectRow {
  key: string;
  value: string;
}

function buildTrigger(options: AutomationCreateOptions): AutomationTrigger {
  const cron = options.cron?.trim();
  const every = options.every?.trim();
  if (cron && every) {
    throw {
      code: "INVALID_CADENCE",
      message: "Use either --every or --cron, not both",
    } satisfies CommandError;
  }
  const timezone = options.timezone?.trim();
  if (timezone && !cron && !every) {
    throw {
      code: "INVALID_CADENCE",
      message: "--timezone needs --cron or --every",
    } satisfies CommandError;
  }
  const expression = cron || (every ? compileEveryPresetToCron(every) : null);
  if (!expression) {
    return { kind: "manual" };
  }
  return {
    kind: "schedule",
    cadence: { type: "cron", expression, ...(timezone ? { timezone } : {}) },
  };
}

// A remote daemon gets the path as typed; a local one gets it resolved against this shell.
function resolveProjectCwd(cwd: string | undefined, options: AutomationCreateOptions): string {
  if (!cwd) {
    return process.cwd();
  }
  return options.daemonTarget.kind === "endpoint" ? cwd : resolve(cwd);
}

function buildDefinition(prompt: string, options: AutomationCreateOptions): AutomationDefinition {
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) {
    throw { code: "INVALID_PROMPT", message: "Prompt cannot be empty" } satisfies CommandError;
  }
  const name = options.name?.trim();
  if (!name) {
    throw { code: "MISSING_NAME", message: "--name is required" } satisfies CommandError;
  }
  const cwd = options.cwd?.trim();
  if (options.daemonTarget.kind === "endpoint" && !cwd) {
    throw {
      code: "MISSING_CWD",
      message: "--cwd is required when --host is specified",
    } satisfies CommandError;
  }
  const { provider, model } = resolveProviderAndModel({ provider: options.provider });
  const mode = options.mode?.trim();
  const thinking = options.thinking?.trim();
  const expiresAt = options.expiresIn
    ? new Date(Date.now() + parseDuration(options.expiresIn)).toISOString()
    : undefined;
  return {
    name,
    project: { cwd: resolveProjectCwd(cwd, options) },
    trigger: buildTrigger(options),
    flow: {
      nodes: [
        {
          id: "agent",
          kind: "agent",
          title: "Agent",
          provider,
          ...(model ? { model } : {}),
          ...(mode ? { modeId: mode } : {}),
          ...(thinking ? { thinkingOptionId: thinking } : {}),
          workspace: options.worktree ? "worktree" : "project",
          prompt: trimmedPrompt,
        },
        { id: "chat", kind: "output", output: { type: "chat" } },
      ],
      edges: [{ from: "agent", to: "chat" }],
    },
    limits: {
      ...(options.maxRuns ? { maxRuns: parsePositiveInt(options.maxRuns, "--max-runs") } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    },
  };
}

function single(row: AutomationRow): SingleResult<AutomationRow> {
  return { type: "single", data: row, schema: automationSchema };
}

async function runCreate(
  prompt: string,
  options: AutomationCreateOptions,
  _command: Command,
): Promise<SingleResult<AutomationRow>> {
  const definition = buildDefinition(prompt, options);
  const agentId = callerAgentId();
  return withAutomationClient(
    options,
    "AUTOMATION_CREATE_FAILED",
    "create automation",
    async (client) => {
      const payload = await client.automationCreate({
        definition,
        ...(agentId ? { origin: { kind: "agent", agentId } } : {}),
      });
      return single(toAutomationRow(payload.automation));
    },
  );
}

async function runLs(
  options: CommandOptions,
  _command: Command,
): Promise<ListResult<AutomationRow>> {
  return withAutomationClient(
    options,
    "AUTOMATION_LIST_FAILED",
    "list automations",
    async (client) => {
      const payload = await client.automationList();
      return {
        type: "list",
        data: payload.automations.map(toAutomationRow),
        schema: automationSchema,
      };
    },
  );
}

async function runInspect(
  id: string,
  options: CommandOptions,
  _command: Command,
): Promise<ListResult<InspectRow>> {
  return withAutomationClient(
    options,
    "AUTOMATION_INSPECT_FAILED",
    "inspect automation",
    async (client) => {
      const { automation, audit } = await client.automationGet({ automationId: id });
      const node = automation.flow.nodes.find((candidate) => candidate.kind === "agent");
      const row = toAutomationRow(automation);
      const rows: InspectRow[] = [
        { key: "Id", value: automation.id },
        { key: "Name", value: automation.name },
        { key: "Status", value: row.status },
        { key: "Origin", value: row.origin },
        { key: "Project", value: automation.project.cwd },
        { key: "Trigger", value: row.trigger },
        { key: "Provider", value: row.provider },
        { key: "Mode", value: node?.kind === "agent" ? (node.modeId ?? "default") : "-" },
        { key: "Workspace", value: node?.kind === "agent" ? node.workspace : "-" },
        { key: "Prompt", value: node?.kind === "agent" ? node.prompt : "-" },
        { key: "Revision", value: `${automation.revision}` },
        { key: "NextRunAt", value: automation.nextRunAt ?? "null" },
        { key: "LastRun", value: row.lastRun ?? "null" },
        { key: "RunCount", value: `${automation.runCount}` },
        { key: "FailuresInARow", value: `${automation.consecutiveFailures}` },
        {
          key: "Limits",
          value: `runtime ${automation.limits.maxRuntimeMs / 60_000}m, ${automation.limits.maxRunsPerHour}/hour, ${automation.limits.maxConcurrentRuns} at once, maxRuns ${automation.limits.maxRuns ?? "none"}, expires ${automation.limits.expiresAt ?? "never"}`,
        },
        ...audit.slice(-10).map((entry) => ({
          key: `Audit ${entry.at}`,
          value: `${entry.action} by ${entry.actor.kind === "agent" ? `agent:${entry.actor.agentId.slice(0, 7)}` : entry.actor.kind}${entry.detail ? ` (${entry.detail})` : ""}`,
        })),
      ];
      const schema: OutputSchema<InspectRow> = {
        idField: "key",
        columns: [
          { header: "KEY", field: "key", width: 36 },
          { header: "VALUE", field: "value", width: 80 },
        ],
        serialize: () => ({ automation, audit }),
      };
      return { type: "list", data: rows, schema };
    },
  );
}

function stateCommand(
  action: "pause" | "resume" | "approve",
): (id: string, options: CommandOptions, command: Command) => Promise<SingleResult<AutomationRow>> {
  return async (id, options) => {
    if (action === "approve" && callerAgentId()) {
      throw {
        code: "APPROVAL_REQUIRES_OWNER",
        message: "Agents cannot approve automations. Ask the user to approve it in Pimi.",
      } satisfies CommandError;
    }
    return withAutomationClient(
      options,
      `AUTOMATION_${action.toUpperCase()}_FAILED`,
      `${action} automation`,
      async (client) => {
        const request = { automationId: id };
        let payload;
        if (action === "pause") {
          payload = await client.automationPause(request);
        } else if (action === "resume") {
          payload = await client.automationEnable(request);
        } else {
          payload = await client.automationApprove(request);
        }
        return single(toAutomationRow(payload.automation));
      },
    );
  };
}

async function runDelete(
  id: string,
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<{ id: string; status: string }>> {
  return withAutomationClient(
    options,
    "AUTOMATION_DELETE_FAILED",
    "delete automation",
    async (client) => {
      const payload = await client.automationDelete({ automationId: id });
      return {
        type: "single",
        data: { id: payload.automationId, status: "deleted" },
        schema: {
          idField: "id",
          columns: [
            { header: "ID", field: "id" },
            { header: "STATUS", field: "status" },
          ],
        },
      };
    },
  );
}

async function runRun(
  id: string,
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<AutomationRunRow>> {
  return withAutomationClient(
    options,
    "AUTOMATION_RUN_FAILED",
    "run automation",
    async (client) => {
      const payload = await client.automationRunStart({ automationId: id });
      return { type: "single", data: toAutomationRunRow(payload.run), schema: automationRunSchema };
    },
  );
}

async function runRuns(
  id: string,
  options: AutomationRunsOptions,
  _command: Command,
): Promise<ListResult<AutomationRunRow>> {
  const limit = options.limit ? parsePositiveInt(options.limit, "--limit") : 20;
  return withAutomationClient(
    options,
    "AUTOMATION_RUNS_FAILED",
    "list automation runs",
    async (client) => {
      const payload = await client.automationRunList({ automationId: id, limit });
      return {
        type: "list",
        data: payload.runs.map(toAutomationRunRow),
        schema: automationRunSchema,
      };
    },
  );
}

export function createAutomationCommand(): Command {
  const automation = new Command("automation").description("Manage automations");

  addJsonAndDaemonHostOptions(
    automation
      .command("create")
      .description(
        "Create an automation: a new agent runs the prompt on each run, on a cadence or (with no cadence) only by hand. Created inside an agent, it waits for the user's approval",
      )
      .argument("<prompt>", "Prompt for the automation's agent")
      .requiredOption("--name <name>", "Automation name")
      .option("--cron <expr>", "Five-field cron cadence")
      .option(
        "--every <duration>",
        "Interval that divides an hour or a day evenly (for example: 15m, 2h)",
      )
      .option("--timezone <iana>", "IANA time zone for the cadence (default: UTC)")
      .requiredOption("--provider <provider>", "Agent provider, or provider/model")
      .option(
        "--mode <mode>",
        "Provider mode (default: the provider's unattended mode if it has one, otherwise its default mode). A run that stops at a permission prompt fails",
      )
      .option("--thinking <id>", "Thinking option ID")
      .option("--cwd <path>", "Project directory (default: current; required with --host)")
      .option("--worktree", "Run each time in a new worktree instead of the project directory")
      .option("--max-runs <n>", "End after this many runs")
      .option("--expires-in <duration>", "End after this long"),
  ).action(withOutput(runCreate));

  addJsonAndDaemonHostOptions(automation.command("ls").description("List automations")).action(
    withOutput(runLs),
  );
  addJsonAndDaemonHostOptions(
    automation
      .command("inspect")
      .description("Show an automation and its last 10 audit entries, including skipped runs")
      .argument("<id>", "Automation ID"),
  ).action(withOutput(runInspect));
  addJsonAndDaemonHostOptions(
    automation
      .command("pause")
      .description("Stop an automation from firing until it is resumed")
      .argument("<id>", "Automation ID"),
  ).action(withOutput(stateCommand("pause")));
  addJsonAndDaemonHostOptions(
    automation
      .command("resume")
      .description("Resume a paused automation and clear its failure count")
      .argument("<id>", "Automation ID"),
  ).action(withOutput(stateCommand("resume")));
  addJsonAndDaemonHostOptions(
    automation
      .command("approve")
      .description("Approve an automation an agent created (refused inside an agent)")
      .argument("<id>", "Automation ID"),
  ).action(withOutput(stateCommand("approve")));
  addJsonAndDaemonHostOptions(
    automation
      .command("rm")
      .description("Delete an automation and its run history")
      .argument("<id>", "Automation ID"),
  ).action(withOutput(runDelete));
  addJsonAndDaemonHostOptions(
    automation
      .command("run")
      .description("Start a run now and return while it is running; read the result with `runs`")
      .argument("<id>", "Automation ID"),
  ).action(withOutput(runRun));
  addJsonAndDaemonHostOptions(
    automation
      .command("runs")
      .description("List an automation's runs, newest first")
      .argument("<id>", "Automation ID")
      .option("--limit <n>", "Number of runs (default: 20)"),
  ).action(withOutput(runRuns));

  return automation;
}
