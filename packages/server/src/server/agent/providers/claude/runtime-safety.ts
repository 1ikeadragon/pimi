import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentBackgroundWorkInput } from "../../background-work/index.js";
import { parseClaudeCodeVersion } from "./model-manifest.js";
import { toBackgroundWorkInputs, type ClaudeBackgroundTask } from "./background-work.js";
import { readBackgroundShellLaunch } from "./background-output.js";

/** Process-local background ownership. Completion delivery can follow an empty roster. */
export class ClaudeRuntimeSafety {
  private inventoryState: "unknown" | "supported" | "retired" = "unknown";
  // A process that has emitted nothing has run no turn and owns no background work.
  private observedMessage = false;
  private liveTasks: readonly ClaudeBackgroundTask[] = [];
  private published: AgentBackgroundWorkInput[] | undefined;
  private readonly awaitingNotifications = new Set<string>();
  private readonly monitorTools = new Set<string>();
  private readonly toolInputs = new Map<string, { description?: string; command?: string }>();
  private readonly taskTools = new Map<string, string>();
  // Background shells launched by a Bash call: where each writes its output, and when it began.
  private readonly shellLaunches = new Map<
    string,
    { toolUseId: string; outputFile: string; startedAt: string }
  >();
  // Scheduled wakeups (ScheduleWakeup, CronCreate, /loop) live only in this process.
  private scheduledWakeups = 0;

  /** The Stop hook reports the wakeups still scheduled when a turn ends. */
  observeStop(sessionCrons: readonly unknown[] | undefined): void {
    this.scheduledWakeups = sessionCrons?.length ?? 0;
  }

  reset(): void {
    this.scheduledWakeups = 0;
    this.inventoryState = "unknown";
    this.observedMessage = false;
    this.liveTasks = [];
    this.published = undefined;
    this.awaitingNotifications.clear();
    this.monitorTools.clear();
    this.toolInputs.clear();
    this.taskTools.clear();
    this.shellLaunches.clear();
  }

  retire(): void {
    this.reset();
    this.inventoryState = "retired";
  }

  /** Returns a full replacement only when the visible inventory changes. */
  observe(message: SDKMessage): AgentBackgroundWorkInput[] | undefined {
    if (this.inventoryState === "retired") return undefined;
    this.observedMessage = true;
    const changed = this.observeTools(message);
    const systemChanged = message.type === "system" ? this.observeSystem(message) : false;
    if ((!changed && !systemChanged) || this.inventoryState !== "supported") return undefined;
    const items = this.buildInventory();
    if (this.published && sameInventory(this.published, items)) return undefined;
    this.published = items;
    return items;
  }

  /** A background shell this process launched with a Bash call. */
  shellLaunch(taskId: string): { outputFile: string; startedAt: string } | undefined {
    return this.shellLaunches.get(taskId);
  }

  /** The background shell a Bash call started, once its launch result named an output file. */
  shellTaskOf(toolUseId: string): string | undefined {
    for (const [taskId, launch] of this.shellLaunches) {
      if (launch.toolUseId === toolUseId) return taskId;
    }
    return undefined;
  }

  private observeTools(message: SDKMessage): boolean {
    if (message.type === "user") return this.observeLaunch(message);
    if (message.type === "assistant") {
      let relevant = false;
      for (const block of message.message.content) {
        if (block.type === "tool_use" && (block.name === "Monitor" || block.name === "Bash")) {
          if (block.name === "Monitor") relevant = this.observeMonitor(block.id) || relevant;
          relevant = this.observeInput(block.id, block.input) || relevant;
        }
      }
      return relevant;
    }
    if (message.type === "stream_event" && message.event.type === "content_block_start") {
      const block = message.event.content_block;
      if (block.type === "tool_use" && block.name === "Monitor")
        return this.observeMonitor(block.id);
    }
    return false;
  }

  private observeLaunch(message: SDKMessage): boolean {
    const launch = readBackgroundShellLaunch(message);
    if (!launch || this.shellLaunches.has(launch.taskId)) return false;
    this.shellLaunches.set(launch.taskId, {
      toolUseId: launch.toolUseId,
      outputFile: launch.outputFile,
      startedAt: new Date().toISOString(),
    });
    return this.liveTasks.some((task) => task.task_id === launch.taskId);
  }

  private observeInput(id: string, value: unknown): boolean {
    const input = value as Record<string, unknown> | null;
    const description = typeof input?.description === "string" ? input.description.trim() : "";
    const command = typeof input?.command === "string" ? input.command.trim() : "";
    const previous = this.toolInputs.get(id);
    if (description === (previous?.description ?? "") && command === (previous?.command ?? ""))
      return false;
    this.toolInputs.set(id, {
      ...(description ? { description } : {}),
      ...(command ? { command } : {}),
    });
    return this.liveTasks.some((task) => this.taskTools.get(task.task_id) === id);
  }

  private observeMonitor(id: string): boolean {
    if (this.monitorTools.has(id)) return false;
    this.monitorTools.add(id);
    return this.liveTasks.some((task) => this.taskTools.get(task.task_id) === id);
  }

  private observeSystem(message: Extract<SDKMessage, { type: "system" }>): boolean {
    if (message.subtype === "task_started" && message.tool_use_id) {
      const previous = this.taskTools.get(message.task_id);
      this.taskTools.set(message.task_id, message.tool_use_id);
      return (
        previous !== message.tool_use_id &&
        (this.monitorTools.has(message.tool_use_id) ||
          this.toolInputs.has(message.tool_use_id) ||
          (previous !== undefined &&
            (this.monitorTools.has(previous) || this.toolInputs.has(previous)))) &&
        this.liveTasks.some((task) => task.task_id === message.task_id)
      );
    }
    if (message.subtype === "init") {
      const version = parseClaudeCodeVersion(message.claude_code_version ?? "");
      if (
        version &&
        (version[0] > 2 ||
          (version[0] === 2 && (version[1] > 1 || (version[1] === 1 && version[2] >= 292))))
      ) {
        const changed = this.inventoryState !== "supported";
        this.inventoryState = "supported";
        return changed;
      }
    }
    if (message.subtype === "background_tasks_changed") {
      this.inventoryState = "supported";
      this.liveTasks = message.tasks;
      for (const task of this.liveTasks) this.awaitingNotifications.add(task.task_id);
      return true;
    }
    if (message.subtype === "task_notification") this.awaitingNotifications.delete(message.task_id);
    return false;
  }

  canStopRuntime(): boolean {
    if (this.inventoryState === "unknown" && !this.observedMessage) return true;
    return (
      this.inventoryState === "supported" &&
      this.liveTasks.length === 0 &&
      this.awaitingNotifications.size === 0 &&
      this.scheduledWakeups === 0
    );
  }

  canStop(id: string): boolean {
    return this.buildInventory().some((item) => item.id === id && item.canStop);
  }

  isCurrentInventory(items: AgentBackgroundWorkInput[]): boolean {
    return this.inventoryState === "supported" && this.published === items;
  }

  private buildInventory(): AgentBackgroundWorkInput[] {
    return toBackgroundWorkInputs(this.liveTasks).map((item) => {
      const tool = this.taskTools.get(item.id) ?? "";
      if (this.monitorTools.has(tool)) item.kind = "monitor";
      if (item.kind === "shell" && this.shellLaunches.has(item.id)) item.hasOutput = true;
      const input = this.toolInputs.get(tool);
      if (input?.description) item.description = input.description;
      if (input?.command) item.command = input.command;
      return item;
    });
  }
}

function sameInventory(
  left: readonly AgentBackgroundWorkInput[],
  right: readonly AgentBackgroundWorkInput[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (item, index) =>
        item.id === right[index].id &&
        item.kind === right[index].kind &&
        item.description === right[index].description &&
        item.command === right[index].command &&
        item.canStop === right[index].canStop &&
        item.hasOutput === right[index].hasOutput,
    )
  );
}
