import { z } from "zod";
import { PIMI_VISUALIZATION_GUIDE_TOOL } from "@pimi/protocol/chat-visualization";

import type { PimiToolCatalog, PimiToolDefinition, PimiToolResult } from "./types.js";

/**
 * Providers that send every tool schema on every turn (Codex, OpenCode, OMP, ACP agents) get only
 * these tools listed. Everything else sits behind `pimi_tools` and `call_pimi_tool`, so a chat that
 * never touches automations does not pay for their schemas.
 */
const DEFAULT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "create_agent",
  "send_agent_prompt",
  "list_agents",
  "get_agent_status",
  "cancel_agent",
  "list_providers",
  "list_workspaces",
  "create_workspace",
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
  list_hosts: "workspaces",
  archive_workspace: "workspaces",
  rename_workspace: "workspaces",
  list_workspace_scripts: "scripts",
  start_workspace_script: "scripts",
  stop_workspace_script: "scripts",
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
};

/** Group names a loader-fed agent can ask for, for the prompt. Tools outside the map fall under "other", so tools not named here still show up in the loader's own listing. */
export const LAZY_TOOL_GROUP_NAMES: readonly string[] = [
  ...new Set([...Object.values(GROUP_BY_TOOL), "automations", "heartbeats"]),
].sort();

export function toolGroupOf(name: string): string {
  const mapped = GROUP_BY_TOOL[name];
  if (mapped) return mapped;
  if (name.includes("automation")) return "automations";
  if (name.includes("heartbeat")) return "heartbeats";
  return "other";
}

export interface SplitTools {
  listed: PimiToolDefinition[];
  groups: Map<string, PimiToolDefinition[]>;
}

export function splitToolsForLazyLoading(tools: Iterable<PimiToolDefinition>): SplitTools {
  const listed: PimiToolDefinition[] = [];
  const groups = new Map<string, PimiToolDefinition[]>();
  for (const tool of tools) {
    if (DEFAULT_TOOL_NAMES.has(tool.name)) {
      listed.push(tool);
      continue;
    }
    const group = toolGroupOf(tool.name);
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
      description: `More Pimi tools exist beyond the ones listed. Call this with a group to get each tool's description and input schema, then run one with ${CALL_TOOL_NAME}. Groups: ${groupNames.join(", ")}. Call with no group to list the tool names in every group.`,
      inputSchema: { group: z.enum(groupNames as [string, ...string[]]).optional() },
      handler: async (input) => {
        const { group } = z.object({ group: z.string().optional() }).parse(input);
        if (!group) {
          return textResult(
            Object.fromEntries(
              groupNames.map((name) => [name, groups.get(name)!.map((tool) => tool.name)]),
            ),
          );
        }
        const members = groups.get(group);
        if (!members) return { ...textResult(`Unknown group: ${group}`), isError: true };
        return textResult(
          members.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: jsonSchemaOf(tool),
          })),
        );
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
 * The catalog a provider that sends every tool schema each turn sees: the core tools and the
 * loader. A tool outside them stays callable by name, so an agent that already knows it (resumed
 * history, a stale schema) is not refused.
 */
export function lazyPimiToolCatalog(catalog: PimiToolCatalog): PimiToolCatalog {
  const { listed, groups } = splitToolsForLazyLoading(catalog.tools.values());
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
