// Pimi. Apache-2.0.
import { PimiVoiceView, type PimiVoiceNavigation } from "@pimi/protocol/pimi-task";

export type PimiVoiceCommand = PimiVoiceNavigation | { action: "stop" };

export function parsePimiVoiceCommand(transcript: string): PimiVoiceCommand | null {
  const command = transcript
    .trim()
    .replace(/^(?:(?:ok(?:ay)?|hey pimi|pimi|please)[\s,.:]+)+/i, "");
  const instruction = command.replace(/[.!?]+$/, "").trimEnd();

  if (/^(?:stop listening|stop voice commands)$/i.test(instruction)) return { action: "stop" };

  if (/^(?:open|start|create) (?:a )?new (?:chat|conversation|thread)$/i.test(instruction)) {
    return { action: "new-chat" };
  }
  const chat = command.match(
    /^(?:open|start|create) (?:a )?new (?:chat|conversation|thread)[,.:]? (?:and )?(?:type|write)(?: in)?[\s,:]+(\S[\s\S]*)$/i,
  );
  if (chat) return { action: "new-chat", text: chat[1] };
  if (/^(?:create|open|start) (?:a )?(?:new )?space(?: note| card)?$/i.test(instruction))
    return { action: "new-space" };

  const prs = instruction.match(/^(?:open|show(?: me)?) (my )?(?:open )?(?:prs|pull requests)$/i);
  if (prs) return { action: "review-prs", filter: prs[1] ? "mine" : "all" };

  if (/^(?:open|show(?: me)?) (?:my )?(?:session usage|context(?: window)?)$/i.test(instruction))
    return { action: "usage", tab: "sessions" };

  if (/^(?:open|start|create) (?:a )?new task$/i.test(instruction)) {
    return { action: "new-task" };
  }
  const task = command.match(
    /^(?:open|start) (?:a )?new task (?:called|titled)[\s,:]+(.+?)(?:[,.:]? (?:with (?:a |the )?brief|and (?:write|type)(?: in)?)[\s,:]+(\S[\s\S]*))?$/i,
  );
  if (task) return { action: "new-task", title: task[1].replace(/[.!?]+$/, ""), brief: task[2] };
  const brief = command.match(
    /^(?:open|start) (?:a )?new task[,.:]? (?:to|for|with (?:a |the )?brief|and (?:write|type)(?: in)?)[\s,:]+(\S[\s\S]*)$/i,
  );
  if (brief) return { action: "new-task", brief: brief[1] };

  const view = instruction.match(
    /^(?:open|show(?: me)?|go to|switch to) (?:(?:my|the) )?([a-z]+)(?: (?:view|screen|page|tab))?$/i,
  );
  const parsed = PimiVoiceView.safeParse(view?.[1].toLowerCase());
  return parsed.success ? { action: "show", view: parsed.data } : null;
}
