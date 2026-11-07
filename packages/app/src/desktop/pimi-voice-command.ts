// Pimi addition to the Paseo fork. Apache-2.0.
import type { PimiDestination } from "@getpaseo/protocol/pimi-task";

export type PimiVoiceCommand =
  | { action: "new-chat"; text?: string }
  | { action: "new-task"; title?: string; brief?: string }
  | { action: "show"; destination: PimiDestination | "chat"; label: string }
  | { action: "stop" };

export function parsePimiVoiceCommand(transcript: string): PimiVoiceCommand | null {
  const command = transcript
    .trim()
    .replace(/^(?:(?:ok(?:ay)?|hey pimi|pimi|please)[\s,.:]+)+/i, "");
  const instruction = command.replace(/[.!?]+$/, "").trimEnd();

  if (/^(?:stop listening|stop voice commands)$/i.test(instruction)) return { action: "stop" };

  if (/^(?:open|start|create) (?:a )?new chat$/i.test(instruction)) {
    return { action: "new-chat" };
  }
  const chat = command.match(
    /^(?:open|start|create) (?:a )?new chat[,.:]? (?:and )?(?:type|write)(?: in)?[\s,:]+(\S[\s\S]*)$/i,
  );
  if (chat) return { action: "new-chat", text: chat[1] };

  if (/^(?:open|start|create) (?:a )?new task$/i.test(instruction)) {
    return { action: "new-task" };
  }
  const task = command.match(
    /^(?:open|start|create) (?:a )?new task (?:called|titled)[\s,:]+(.+?)(?:[,.:]? (?:with (?:a |the )?brief|and (?:write|type)(?: in)?)[\s,:]+(\S[\s\S]*))?$/i,
  );
  if (task) return { action: "new-task", title: task[1].replace(/[.!?]+$/, ""), brief: task[2] };
  const brief = command.match(
    /^(?:open|start|create) (?:a )?new task[,.:]? (?:to|for|with (?:a |the )?brief|and (?:write|type)(?: in)?)[\s,:]+(\S[\s\S]*)$/i,
  );
  if (brief) return { action: "new-task", brief: brief[1] };

  const view = instruction.match(
    /^(?:open|show(?: me)?|go to|switch to) (chat|tasks|work|review|memory)$/i,
  );
  switch (view?.[1].toLowerCase()) {
    case "chat":
      return { action: "show", destination: "chat", label: "Chat" };
    case "tasks":
      return { action: "show", destination: { view: "tasks" }, label: "Tasks" };
    case "work":
      return { action: "show", destination: { view: "worktrees" }, label: "Work" };
    case "review":
      return { action: "show", destination: { view: "review-home" }, label: "Review" };
    case "memory":
      return { action: "show", destination: { view: "memory" }, label: "Memory" };
    default:
      return null;
  }
}
