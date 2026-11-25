import { z } from "zod";
import { PIMI_VISUALIZATION_GUIDE_TOOL } from "@pimi/protocol/chat-visualization";

import type { PimiToolCatalog, PimiToolDefinition, PimiToolResult } from "./types.js";

/**
 * Every agent session lists only these tools. Everything else sits behind `pimi_tools` and
 * `call_pimi_tool`, so a chat that never touches automations pays for neither their schemas (a
 * provider that sends every schema each turn) nor their names (a provider that defers schemas).
 */
const DEFAULT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "create_agent",
  "delegate",
  "send_agent_prompt",
  "list_agents",
  "get_agent_status",
  "cancel_agent",
  "list_providers",
  "list_chats",
  "create_chat",
  "list_projects",
  "recall_project_memory",
  "recall_global_memory",
  "create_pimi_task",
  "suggest_pimi_review",
  "browser_show",
  PIMI_VISUALIZATION_GUIDE_TOOL,
]);

const LOADER_TOOL_NAME = "pimi_tools";
const CALL_TOOL_NAME = "call_pimi_tool";

const GROUP_BY_TOOL: Readonly<Record<string, string>> = {
  get_agent_activity: "agents",
  update_agent: "agents",
  set_agent_mode: "agents",
  archive_agent: "agents",
  kill_agent: "agents",
  list_profiles: "profiles",
  inspect_provider: "profiles",
  list_models: "profiles",
  list_hosts: "chats",
  archive_chat: "chats",
  rename_chat: "chats",
  list_scripts: "scripts",
  start_script: "scripts",
  stop_script: "scripts",
  list_terminals: "terminals",
  create_terminal: "terminals",
  kill_terminal: "terminals",
  capture_terminal: "terminals",
  send_terminal_keys: "terminals",
  list_pending_permissions: "permissions",
  respond_to_permission: "permissions",
  search_pimi_codebase: "search",
  search_pimi_spaces: "search",
  read_pimi_space_item: "search",
  list_pimi_tasks: "tasks",
  get_pimi_task: "tasks",
  update_pimi_task: "tasks",
  list_pimi_labels: "tasks",
  create_pimi_label: "tasks",
  set_pimi_label: "tasks",
  remember_project_note: "memory",
  forget_project_note: "memory",
  remember_global_note: "memory",
  forget_global_note: "memory",
  vault_list: "vault",
  vault_run: "vault",
  list_flows: "flows",
  run_flow: "flows",
  save_flow: "flows",
  submit_verdict: "flows",
  submit_finding: "attack",
  finish_attack_run: "attack",
  get_annotation: "attack",
  report_annotation_result: "attack",
};

/** The groups that exist only for an agent of an Attack run, plus the browser it drives. */
const ATTACK_RUN_GROUPS: ReadonlySet<string> = new Set(["attack", "desktop", "browser"]);

/** Group names a loader-fed agent can ask for, for the prompt. Attack groups are left out: an Attack run's own prompt names its tools. */
export const LAZY_TOOL_GROUP_NAMES: readonly string[] = [
  ...new Set([...Object.values(GROUP_BY_TOOL), "automations", "heartbeats", "browser"]),
]
  .filter((group) => group !== "attack")
  .sort();

export function toolGroupOf(name: string): string {
  const mapped = GROUP_BY_TOOL[name];
  if (mapped) return mapped;
  if (name.startsWith("browser_")) return "browser";
  if (name.startsWith("desktop_")) return "desktop";
  if (name.includes("automation")) return "automations";
  if (name.includes("heartbeat")) return "heartbeats";
  return "other";
}

export interface LazyListing {
  /** List an Attack run's tools directly: for a provider that defers schemas, a name costs little and the run's prompt calls them by name. */
  listAttackRunTools?: boolean;
}

export interface SplitTools {
  listed: PimiToolDefinition[];
  groups: Map<string, PimiToolDefinition[]>;
}

export function splitToolsForLazyLoading(
  tools: Iterable<PimiToolDefinition>,
  listing: LazyListing = {},
): SplitTools {
  const listed: PimiToolDefinition[] = [];
  const groups = new Map<string, PimiToolDefinition[]>();
  for (const tool of tools) {
    const group = toolGroupOf(tool.name);
    if (
      DEFAULT_TOOL_NAMES.has(tool.name) ||
      (listing.listAttackRunTools && ATTACK_RUN_GROUPS.has(group))
    ) {
      listed.push(tool);
      continue;
    }
    const members = groups.get(group) ?? [];
    members.push(tool);
    groups.set(group, members);
  }
  return { listed, groups };
}

function jsonSchemaOf(tool: PimiToolDefinition): unknown {
  const schema = tool.inputSchema;
  if (!schema) return { type: "object", properties: {} };
  const zodSchema = schema instanceof z.ZodType ? schema : z.object(schema);
  return z.toJSONSchema(zodSchema, { io: "input", unrepresentable: "any" });
}

function textResult(value: unknown): PimiToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function describe(tools: PimiToolDefinition[]): PimiToolResult {
  return textResult(
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: jsonSchemaOf(tool),
    })),
  );
}

const LoaderInput = z.object({
  group: z.string().optional(),
  tools: z.array(z.string()).optional(),
});

export function createLazyLoaderTools(
  groups: Map<string, PimiToolDefinition[]>,
  listedNames: ReadonlySet<string>,
  execute: (name: string, args: unknown, signal?: AbortSignal) => Promise<PimiToolResult>,
): PimiToolDefinition[] {
  if (groups.size === 0) return [];
  const groupNames = [...groups.keys()].sort();
  const byName = new Map<string, PimiToolDefinition>();
  for (const members of groups.values()) {
    for (const tool of members) byName.set(tool.name, tool);
  }
  return [
    {
      name: LOADER_TOOL_NAME,
      title: "Load Pimi tools",
      description: `More Pimi tools exist beyond the ones listed. Call this with a group to get each tool's description and input schema, or with tools to get only the ones you name, then run one with ${CALL_TOOL_NAME}. Groups: ${groupNames.join(", ")}. Call with no arguments to list the tool names in every group.`,
      inputSchema: {
        group: z.enum(groupNames as [string, ...string[]]).optional(),
        tools: z.array(z.string()).optional(),
      },
      handler: async (input) => {
        const { group, tools } = LoaderInput.parse(input);
        if (tools?.length) {
          const unknown = tools.filter((name) => !byName.has(name));
          if (unknown.length) {
            return { ...textResult(`Unknown tools: ${unknown.join(", ")}`), isError: true };
          }
          return describe(tools.map((name) => byName.get(name)!));
        }
        if (!group) {
          return textResult(
            Object.fromEntries(
              groupNames.map((name) => [name, groups.get(name)!.map((tool) => tool.name)]),
            ),
          );
        }
        const members = groups.get(group);
        if (!members) return { ...textResult(`Unknown group: ${group}`), isError: true };
        return describe(members);
      },
    },
    {
      name: CALL_TOOL_NAME,
      title: "Call a Pimi tool",
      description: `Run a Pimi tool loaded with ${LOADER_TOOL_NAME}. Pass its name and arguments exactly as its schema describes.`,
      inputSchema: { name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() },
      handler: async (input, context) => {
        const { name, arguments: args } = z
          .object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() })
          .parse(input);
        if (!byName.has(name) && !listedNames.has(name)) {
          return {
            ...textResult(
              `${name} is not a loadable Pimi tool. Call ${LOADER_TOOL_NAME} to list them.`,
            ),
            isError: true,
          };
        }
        return execute(name, args ?? {}, context.signal);
      },
    },
  ];
}

/**
 * The catalog an agent session sees: the core tools and the loader. A tool outside them stays
 * callable by name, so an agent that already knows it (resumed history, a stale schema) is not
 * refused.
 */
export function lazyPimiToolCatalog(
  catalog: PimiToolCatalog,
  listing: LazyListing = {},
): PimiToolCatalog {
  const { listed, groups } = splitToolsForLazyLoading(catalog.tools.values(), listing);
  const loaderTools = new Map(
    createLazyLoaderTools(groups, new Set(listed.map((tool) => tool.name)), (name, args, signal) =>
      catalog.executeTool(name, args, { signal }),
    ).map((tool) => [tool.name, tool]),
  );
  const tools = new Map<string, PimiToolDefinition>([
    ...listed.map((tool): [string, PimiToolDefinition] => [tool.name, tool]),
    ...loaderTools,
  ]);
  return {
    tools,
    getTool: (name) => tools.get(name) ?? catalog.getTool(name),
    executeTool: (name, input, context) => {
      const loaderTool = loaderTools.get(name);
      return loaderTool
        ? loaderTool.handler(input, context ?? {})
        : catalog.executeTool(name, input, context);
    },
  };
}
