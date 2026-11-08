import { PimiVoicePlan } from "@getpaseo/protocol/pimi-task";
import { RequestError } from "./git.mjs";

export async function runVoiceCommand(input, { paseo, tasks }) {
  const plan = PimiVoicePlan.parse(await paseo.classifyVoiceCommand(input));
  const receipts = [];
  let destination;
  try {
    for (const step of plan.steps) {
      switch (step.action) {
        case "create-task": {
          const task = await tasks.create({ root: null, title: step.title, brief: step.brief });
          destination = { view: "task", id: task.id };
          receipts.push("Task created");
          break;
        }
        case "move-task": {
          const title = step.title.toLowerCase();
          const matches = tasks.list().tasks.filter((task) => task.title.toLowerCase() === title);
          if (matches.length !== 1) {
            throw new RequestError(
              matches.length ? "More than one task has that title." : "I couldn’t find that task.",
            );
          }
          const task = await tasks.setStage({ id: matches[0].id, stage: step.stage });
          destination = { view: "task", id: task.id };
          receipts.push("Task moved");
          break;
        }
        case "save-space": {
          await paseo.spaces({ action: "add-note", text: step.text });
          destination = { view: "spaces", action: { kind: "saved" } };
          receipts.push("Saved to Spaces");
          break;
        }
      }
    }
  } catch (error) {
    receipts.push(error instanceof RequestError ? error.message : "Couldn’t finish that command.");
    return { destination, message: receipts.join(" · ") };
  }
  return {
    destination: plan.open ? undefined : destination,
    navigation: plan.open,
    message: receipts.join(" · ") || (plan.open ? "" : "I couldn’t match that to a Pimi action."),
  };
}
