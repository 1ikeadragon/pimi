import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import {
  AutomationFlowSchema,
  PullRequestEventSchema,
  type Automation,
  type AutomationDefinition,
  type AutomationFlow,
  type AutomationNode,
  type AutomationRunStep,
  type AutomationTrigger,
} from "@pimi/protocol/automation/types";
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
  formatActor,
  formatRunCause,
  parsePositiveInt,
  toAutomationRow,
  toAutomationRunRow,
  withAutomationClient,
  type AutomationRow,
  type AutomationRunRow,
} from "./shared.js";

interface AutomationTriggerOptions {
  every?: string;
  cron?: string;
  timezone?: string;
  pr?: string;
  prEvents?: string;
}

interface AutomationAgentOptions {
  provider?: string;
  profile?: string;
  mode?: string;
  thinking?: string;
  worktree?: boolean;
}

interface AutomationCreateOptions
  extends CommandOptions, AutomationTriggerOptions, AutomationAgentOptions {
  name?: string;
  flow?: string;
  cwd?: string;
  maxRuns?: string;
  expiresIn?: string;
}

interface AutomationUpdateOptions
  extends CommandOptions, AutomationTriggerOptions, AutomationAgentOptions {
  name?: string;
  prompt?: string;
  flow?: string;
  manual?: boolean;
  maxRuns?: string;
  expiresIn?: string;
}

interface AutomationCompileOptions extends CommandOptions {
  cwd?: string;
  save?: boolean;
}

interface AutomationRunsOptions extends CommandOptions {
  limit?: string;
}

interface InspectRow {
  key: string;
  value: string;
}

function invalid(code: string, message: string): CommandError {
  return { code, message };
}

function buildTrigger(options: AutomationTriggerOptions): AutomationTrigger | null {
  const cron = options.cron?.trim();
  const every = options.every?.trim();
  const repo = options.pr?.trim();
  if ([cron, every, repo].filter(Boolean).length > 1) {
    throw invalid("INVALID_TRIGGER", "Use one of --every, --cron, or --pr");
  }
  const timezone = options.timezone?.trim();
  if (timezone && !cron && !every) {
    throw invalid("INVALID_CADENCE", "--timezone needs --cron or --every");
  }
  if (options.prEvents && !repo) {
    throw invalid("INVALID_TRIGGER", "--pr-events needs --pr");
  }
  if (repo) {
    const events = (options.prEvents ?? "opened,synchronize")
      .split(",")
      .map((event) => event.trim())
      .filter(Boolean)
      .map((event) => {
        const parsed = PullRequestEventSchema.safeParse(event);
        if (!parsed.success) {
          throw invalid(
            "INVALID_TRIGGER",
            `Unknown pull request event ${event}; use opened, synchronize, review_requested`,
          );
        }
        return parsed.data;
      });
    return { kind: "pull_request", repo, events };
  }
  const expression = cron || (every ? compileEveryPresetToCron(every) : null);
  if (!expression) {
    return null;
  }
  return {
    kind: "schedule",
    cadence: { type: "cron", expression, ...(timezone ? { timezone } : {}) },
  };
}

// A remote daemon gets the path as typed; a local one gets it resolved against this shell.
function resolveProjectCwd(cwd: string | undefined, options: CommandOptions): string {
  if (!cwd) {
    if (options.daemonTarget.kind === "endpoint") {
      throw invalid("MISSING_CWD", "--cwd is required when --host is specified");
    }
    return process.cwd();
  }
  return options.daemonTarget.kind === "endpoint" ? cwd : resolve(cwd);
}

// A --flow file holds {nodes, edges} as the automation stores them; the daemon validates the
// graph itself (cycles, references, branches) when it is saved.
function readFlowFile(path: string): AutomationFlow {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(path), "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw invalid("INVALID_FLOW", `Cannot read ${path}: ${message}`);
  }
  const parsed = AutomationFlowSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw invalid(
      "INVALID_FLOW",
      `${path}: ${issue?.path.join(".") || "flow"}: ${issue?.message ?? "invalid"}`,
    );
  }
  return parsed.data;
}

function buildAgentNode(prompt: string, options: AutomationAgentOptions): AutomationNode {
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) {
    throw invalid("INVALID_PROMPT", "Prompt cannot be empty");
  }
  if (!options.provider?.trim()) {
    throw invalid("MISSING_PROVIDER", "--provider is required with a prompt");
  }
  const { provider, model } = resolveProviderAndModel({ provider: options.provider });
  const mode = options.mode?.trim();
  const thinking = options.thinking?.trim();
  const profile = options.profile?.trim();
  return {
    id: "agent",
    kind: "agent",
    title: "Agent",
    provider,
    ...(model ? { model } : {}),
    ...(mode ? { modeId: mode } : {}),
    ...(thinking ? { thinkingOptionId: thinking } : {}),
    ...(profile ? { profileId: profile } : {}),
    workspace: options.worktree ? "worktree" : "project",
    prompt: trimmedPrompt,
  };
}

function buildFlow(
  prompt: string | undefined,
  options: AutomationAgentOptions & { flow?: string },
): AutomationFlow | null {
  if (prompt?.trim() && options.flow) {
    throw invalid("INVALID_FLOW", "Pass a prompt or --flow, not both");
  }
  if (options.flow) {
    return readFlowFile(options.flow);
  }
  if (prompt === undefined) {
    return null;
  }
  return { nodes: [buildAgentNode(prompt, options)], edges: [] };
}

function expiresAt(options: { expiresIn?: string }): string | undefined {
  return options.expiresIn
    ? new Date(Date.now() + parseDuration(options.expiresIn)).toISOString()
    : undefined;
}

function buildDefinition(
  prompt: string | undefined,
  options: AutomationCreateOptions,
): AutomationDefinition {
  const name = options.name?.trim();
  if (!name) {
    throw invalid("MISSING_NAME", "--name is required");
  }
  const flow = buildFlow(prompt, options);
  if (!flow) {
    throw invalid("MISSING_FLOW", "Pass a prompt or --flow <file>");
  }
  const expiry = expiresAt(options);
  return {
    name,
    project: { cwd: resolveProjectCwd(options.cwd?.trim(), options) },
    trigger: buildTrigger(options) ?? { kind: "manual" },
    flow,
    limits: {
      ...(options.maxRuns ? { maxRuns: parsePositiveInt(options.maxRuns, "--max-runs") } : {}),
      ...(expiry ? { expiresAt: expiry } : {}),
    },
  };
}

function callerOrigin(): { origin: { kind: "agent"; agentId: string } } | Record<string, never> {
  const agentId = callerAgentId();
  return agentId ? { origin: { kind: "agent", agentId } } : {};
}

function single(row: AutomationRow): SingleResult<AutomationRow> {
  return { type: "single", data: row, schema: automationSchema };
}

const inspectSchema = (serialize: () => unknown): OutputSchema<InspectRow> => ({
  idField: "key",
  columns: [
    { header: "KEY", field: "key", width: 36 },
    { header: "VALUE", field: "value", width: 80 },
  ],
  serialize,
});

async function runCreate(
  prompt: string | undefined,
  options: AutomationCreateOptions,
  _command: Command,
): Promise<SingleResult<AutomationRow>> {
  const definition = buildDefinition(prompt, options);
  return withAutomationClient(
    options,
    "AUTOMATION_CREATE_FAILED",
    "create automation",
    async (client) => {
      const payload = await client.automationCreate({ definition, ...callerOrigin() });
      return single(toAutomationRow(payload.automation));
    },
  );
}

function replacePrompt(automation: Automation, prompt: string): AutomationFlow {
  const agents = automation.flow.nodes.filter((node) => node.kind === "agent");
  if (agents.length !== 1) {
    throw invalid(
      "INVALID_FLOW",
      "--prompt only edits an automation with one agent step; pass --flow for a graph",
    );
  }
  const trimmed = prompt.trim();
  if (!trimmed) {
    throw invalid("INVALID_PROMPT", "Prompt cannot be empty");
  }
  return {
    ...automation.flow,
    nodes: automation.flow.nodes.map((node) =>
      node.kind === "agent" ? { ...node, prompt: trimmed } : node,
    ),
  };
}

async function runUpdate(
  id: string,
  options: AutomationUpdateOptions,
  _command: Command,
): Promise<SingleResult<AutomationRow>> {
  if (options.prompt !== undefined && options.flow) {
    throw invalid("INVALID_FLOW", "Pass --prompt or --flow, not both");
  }
  const trigger = buildTrigger(options);
  if (trigger && options.manual) {
    throw invalid("INVALID_TRIGGER", "--manual cannot be combined with another trigger");
  }
  const expiry = expiresAt(options);
  return withAutomationClient(
    options,
    "AUTOMATION_UPDATE_FAILED",
    "update automation",
    async (client) => {
      const { automation } = await client.automationGet({ automationId: id });
      let flow = automation.flow;
      if (options.flow) {
        flow = readFlowFile(options.flow);
      } else if (options.prompt !== undefined) {
        flow = replacePrompt(automation, options.prompt);
      }
      const definition: AutomationDefinition = {
        name: options.name?.trim() || automation.name,
        ...(automation.description ? { description: automation.description } : {}),
        project: automation.project,
        trigger: options.manual ? { kind: "manual" } : (trigger ?? automation.trigger),
        flow,
        limits: {
          ...automation.limits,
          ...(options.maxRuns ? { maxRuns: parsePositiveInt(options.maxRuns, "--max-runs") } : {}),
          ...(expiry ? { expiresAt: expiry } : {}),
        },
      };
      const payload = await client.automationUpdate({
        automationId: id,
        definition,
        ...callerOrigin(),
      });
      return single(toAutomationRow(payload.automation));
    },
  );
}

async function runCompile(
  description: string,
  options: AutomationCompileOptions,
  _command: Command,
): Promise<ListResult<InspectRow>> {
  if (!description.trim()) {
    throw invalid("INVALID_DESCRIPTION", "Description cannot be empty");
  }
  const cwd = resolveProjectCwd(options.cwd?.trim(), options);
  return withAutomationClient(
    options,
    "AUTOMATION_COMPILE_FAILED",
    "compile automation",
    async (client) => {
      const { definition } = await client.automationCompile({ description, cwd });
      const agentId = callerAgentId();
      const saved = options.save
        ? (
            await client.automationCreate({
              definition,
              origin: agentId ? { kind: "agent", agentId } : { kind: "compiled" },
            })
          ).automation
        : null;
      const rows: InspectRow[] = [
        { key: "Name", value: definition.name },
        { key: "Trigger", value: JSON.stringify(definition.trigger) },
        ...describeFlow(definition.flow),
        {
          key: "Saved",
          value: saved ? `${saved.id} (${saved.status})` : "no (pass --save to save it)",
        },
      ];
      return {
        type: "list",
        data: rows,
        schema: inspectSchema(() => ({ definition, automation: saved })),
      };
    },
  );
}

function describeFlow(flow: AutomationFlow): InspectRow[] {
  return [
    ...flow.nodes.map((node) => ({
      key: `Step ${node.id}`,
      value:
        node.kind === "agent"
          ? `agent ${node.provider}${node.model ? `/${node.model}` : ""} in ${node.workspace}: ${node.prompt}`
          : `condition ${node.input} ${node.operator}${node.value ? ` ${node.value}` : ""}`,
    })),
    ...flow.edges.map((edge) => ({
      key: `Edge ${edge.from} -> ${edge.to}`,
      value: edge.branch ? `when ${edge.branch}` : "always",
    })),
  ];
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
      const row = toAutomationRow(automation);
      const rows: InspectRow[] = [
        { key: "Id", value: automation.id },
        { key: "Name", value: automation.name },
        { key: "Status", value: row.status },
        { key: "Origin", value: row.origin },
        { key: "Project", value: automation.project.cwd },
        { key: "Trigger", value: row.trigger },
        ...(automation.triggerCheck
          ? [
              {
                key: "TriggerCheck",
                value: `${automation.triggerCheck.at}${automation.triggerCheck.error ? ` error: ${automation.triggerCheck.error}` : " ok"}`,
              },
            ]
          : []),
        ...describeFlow(automation.flow),
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
          value: `${entry.action} by ${formatActor(entry.actor)}${entry.detail ? ` (${entry.detail})` : ""}`,
        })),
      ];
      return { type: "list", data: rows, schema: inspectSchema(() => ({ automation, audit })) };
    },
  );
}

function stateCommand(
  action: "pause" | "resume" | "approve",
): (id: string, options: CommandOptions, command: Command) => Promise<SingleResult<AutomationRow>> {
  return async (id, options) => {
    if (action === "approve" && callerAgentId()) {
      throw invalid(
        "APPROVAL_REQUIRES_OWNER",
        "Agents cannot approve automations. Ask the user to approve it in Pimi.",
      );
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

async function runRetry(
  id: string,
  runId: string,
  options: CommandOptions,
  _command: Command,
): Promise<SingleResult<AutomationRunRow>> {
  return withAutomationClient(
    options,
    "AUTOMATION_RETRY_FAILED",
    "retry automation run",
    async (client) => {
      const payload = await client.automationRunRetry({ automationId: id, runId });
      return { type: "single", data: toAutomationRunRow(payload.run), schema: automationRunSchema };
    },
  );
}

async function runCheck(
  id: string,
  options: CommandOptions,
  _command: Command,
): Promise<ListResult<InspectRow>> {
  return withAutomationClient(
    options,
    "AUTOMATION_CHECK_FAILED",
    "check automation trigger",
    async (client) => {
      const { automation, started } = await client.automationTriggerCheck({ automationId: id });
      const check = automation.triggerCheck;
      const rows: InspectRow[] = [
        { key: "Trigger", value: toAutomationRow(automation).trigger },
        {
          key: "Checked",
          value: check ? `${check.at}${check.error ? ` error: ${check.error}` : " ok"}` : "never",
        },
        { key: "Started", value: `${started.length} run(s)` },
        ...started.map((run) => ({ key: `Run ${run.id}`, value: formatRunCause(run.cause) })),
      ];
      return {
        type: "list",
        data: rows,
        schema: inspectSchema(() => ({ automation, started })),
      };
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

interface StepRow {
  step: string;
  status: string;
  agentId: string | null;
  detail: string | null;
}

function toStepRow(step: AutomationRunStep): StepRow {
  const detail = step.error ?? step.output;
  return {
    step: step.nodeId,
    status: step.reusedFrom ? `${step.status} (reused)` : step.status,
    agentId: step.agentId,
    detail: detail ? detail.replace(/\s+/g, " ").slice(0, 200) : null,
  };
}

async function runSteps(
  id: string,
  runId: string,
  options: CommandOptions,
  _command: Command,
): Promise<ListResult<StepRow>> {
  return withAutomationClient(
    options,
    "AUTOMATION_STEPS_FAILED",
    "read automation run",
    async (client) => {
      const { run } = await client.automationRunGet({ automationId: id, runId });
      return {
        type: "list",
        data: run.steps.map(toStepRow),
        schema: {
          idField: "step",
          columns: [
            { header: "STEP", field: "step", width: 16 },
            { header: "STATUS", field: "status", width: 20 },
            { header: "AGENT", field: "agentId", width: 38 },
            { header: "OUTPUT / ERROR", field: "detail", width: 60 },
          ],
          serialize: () => ({ run, cause: formatRunCause(run.cause) }),
        },
      };
    },
  );
}

function addTriggerOptions(command: Command): Command {
  return command
    .option("--cron <expr>", "Five-field cron cadence")
    .option(
      "--every <duration>",
      "Interval that divides an hour or a day evenly (for example: 15m, 2h)",
    )
    .option("--timezone <iana>", "IANA time zone for the cadence (default: the host's time zone)")
    .option(
      "--pr <owner/name>",
      "Run on pull requests in this GitHub repository, polled each minute with gh",
    )
    .option(
      "--pr-events <list>",
      "Comma-separated: opened, synchronize, review_requested (default: opened,synchronize)",
    );
}

function addAgentOptions(command: Command): Command {
  return command
    .option("--provider <provider>", "Agent provider, or provider/model (required with a prompt)")
    .option(
      "--profile <name>",
      "Agent profile id or name. Each run's agent starts with its instructions, and with its model and thinking where --provider names the profile's provider and gives none",
    )
    .option(
      "--mode <mode>",
      "Provider mode (default: the provider's unattended mode if it has one, otherwise its default mode). A run that stops at a permission prompt fails",
    )
    .option("--thinking <id>", "Thinking option ID")
    .option("--worktree", "Run each time in a new worktree instead of the project directory");
}

const FLOW_HELP =
  "JSON file with {nodes, edges}: agent steps {id, kind: agent, title, provider, model?, workspace, prompt} and condition steps {id, kind: condition, title, input, operator, value}; edges {from, to, branch?}. Prompts may use {{steps.<id>.output}} and {{trigger.<field>}}";

export function createAutomationCommand(): Command {
  const automation = new Command("automation").description("Manage automations");

  addJsonAndDaemonHostOptions(
    addAgentOptions(
      addTriggerOptions(
        automation
          .command("create")
          .description(
            "Create an automation: new agents run its prompt or step graph on each run, on a cadence, on pull requests, or (with neither) only by hand. Created inside an agent, it waits for the user's approval",
          )
          .argument("[prompt]", "Prompt for a single-step automation's agent")
          .requiredOption("--name <name>", "Automation name")
          .option("--flow <file>", FLOW_HELP),
      ),
    )
      .option("--cwd <path>", "Project directory (default: current; required with --host)")
      .option("--max-runs <n>", "End after this many runs")
      .option("--expires-in <duration>", "End after this long"),
  ).action(withOutput(runCreate));

  addJsonAndDaemonHostOptions(
    addAgentOptions(
      addTriggerOptions(
        automation
          .command("update")
          .description(
            "Change an automation. Options you pass replace the stored values. Updated inside an agent, it waits for the user's approval again",
          )
          .argument("<id>", "Automation ID")
          .option("--name <name>", "New name")
          .option("--prompt <prompt>", "New prompt for an automation with one agent step")
          .option("--flow <file>", `Replace the step graph. ${FLOW_HELP}`)
          .option("--manual", "Run only by hand, dropping the cadence or pull request trigger"),
      ),
    )
      .option("--max-runs <n>", "End after this many runs")
      .option("--expires-in <duration>", "End after this long"),
  ).action(withOutput(runUpdate));

  addJsonAndDaemonHostOptions(
    automation
      .command("compile")
      .description(
        "Turn a plain-text description into an automation with an LLM. Prints the draft; --save saves it to wait for approval",
      )
      .argument("<description>", "What the automation should do, and when")
      .option("--cwd <path>", "Project directory (default: current; required with --host)")
      .option("--save", "Save the draft as a pending automation"),
  ).action(withOutput(runCompile));

  addJsonAndDaemonHostOptions(automation.command("ls").description("List automations")).action(
    withOutput(runLs),
  );
  addJsonAndDaemonHostOptions(
    automation
      .command("inspect")
      .description("Show an automation, its steps, and its last 10 audit entries")
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
      .command("retry")
      .description(
        "Rerun a failed or cancelled run's unfinished steps, reusing the outputs of the steps that succeeded",
      )
      .argument("<id>", "Automation ID")
      .argument("<runId>", "Run ID"),
  ).action(withOutput(runRetry));
  addJsonAndDaemonHostOptions(
    automation
      .command("check")
      .description("Poll a pull request trigger now and show the result")
      .argument("<id>", "Automation ID"),
  ).action(withOutput(runCheck));
  addJsonAndDaemonHostOptions(
    automation
      .command("runs")
      .description("List an automation's runs, newest first")
      .argument("<id>", "Automation ID")
      .option("--limit <n>", "Number of runs (default: 20)"),
  ).action(withOutput(runRuns));
  addJsonAndDaemonHostOptions(
    automation
      .command("steps")
      .description("Show each step of a run with its status and output")
      .argument("<id>", "Automation ID")
      .argument("<runId>", "Run ID"),
  ).action(withOutput(runSteps));

  return automation;
}
