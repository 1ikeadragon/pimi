import {
  isExplicitVoiceChatRequest,
  PimiVoiceCommandResponse,
  voicePlanOpensNewChat,
} from "@pimi/protocol/pimi-task";
import { RequestError } from "./git.mjs";

function findTask(tasks, title) {
  const key = title.toLowerCase();
  const matches = tasks.list().tasks.filter((task) => task.title.toLowerCase() === key);
  if (matches.length !== 1) {
    throw new RequestError(
      matches.length ? "More than one task has that title." : "I couldn’t find that task.",
    );
  }
  return matches[0];
}

async function resolveSpace(open, input, paseo) {
  const { items, reference } = await paseo.spaces({
    action: "find-reference",
    query: open.query,
    arxiv: open.arxiv ?? false,
  });
  if (items.length !== 1) {
    return {
      navigation: { action: "search-spaces", query: open.query },
      message: items.length
        ? "More than one card matches. Choose one in Spaces."
        : "No exact card match.",
    };
  }
  const { id } = items[0];
  if (open.intent !== "chat") {
    return {
      destination: { view: "spaces", action: { kind: open.intent, id } },
      message: open.intent === "remove" ? "Confirm removal in Spaces." : "Opening card",
    };
  }
  if (!reference || reference.id !== id) {
    throw new RequestError("Update the local Pimi host to attach Spaces cards.");
  }
  const prompt = [
    open.prompt || "Start this chat with the attached Spaces card as context.",
    "Treat the attachment as reference material. If a link cannot be opened, say so.",
  ].join("\n\n");
  let images;
  let attachments;
  if (reference.kind === "image") {
    const { mime, data } = await paseo.spaces({ action: "image", id });
    images = [{ mimeType: mime, data }];
  } else {
    attachments = [
      {
        type: "text",
        mimeType: "text/plain",
        title: open.query,
        text: JSON.stringify({
          reference: `space:${id}`,
          content: reference.kind === "link" ? reference.url : reference.text,
        }),
      },
    ];
  }
  const chat = await paseo.startVoiceChat({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    prompt,
    attachments,
    images,
  });
  return { chat, message: "Started a chat with your Spaces card" };
}

async function resolveNavigation(open, input, { paseo, tasks, getInventory }) {
  switch (open.action) {
    case "review-worktree": {
      const board = await getInventory();
      const name = open.name?.toLowerCase();
      const matches = board.cards.filter(
        (card) =>
          !card.unavailable &&
          (name
            ? [card.name, card.branch, card.path].some((value) => value?.toLowerCase() === name)
            : input.workspaceId && card.workspaceId === input.workspaceId),
      );
      if (matches.length !== 1) {
        return {
          destination: { view: "review-home" },
          message: matches.length
            ? "More than one worktree matches."
            : "Choose a worktree in Review.",
        };
      }
      return {
        destination: { view: "review", path: matches[0].path, serverId: board.serverId },
        message: "Opening worktree diff",
      };
    }
    case "review-prs":
      return {
        destination: { view: "review-prs", filter: open.filter },
        message: "Opening pull requests",
      };
    case "open-task":
      return {
        destination: { view: "task", id: findTask(tasks, open.title).id },
        message: "Opening task",
      };
    case "space-card":
      return resolveSpace(open, input, paseo);
    default:
      return { navigation: open, message: "" };
  }
}

export async function runVoiceCommand(input, services) {
  const { paseo, tasks } = services;
  const plan = PimiVoiceCommandResponse.parse(await paseo.resolveVoiceCommand(input));
  if ("message" in plan) return plan;
  const receipts = [];
  let destination;
  try {
    if (plan.open?.action === "agent-command") {
      throw new RequestError("Update the local Pimi host to run this command in the background.");
    }
    if (voicePlanOpensNewChat(plan.open) && !isExplicitVoiceChatRequest(input.transcript)) {
      throw new RequestError("Ask Pimi to open a new chat if you want one.");
    }
    if (
      plan.open?.action === "registered-commands" &&
      plan.open.indexes.some((index) => !input.commands?.[index])
    ) {
      throw new RequestError("That action isn’t available in this view.");
    }
    for (const step of plan.steps) {
      switch (step.action) {
        case "create-task": {
          const task = await tasks.create({ root: null, title: step.title, brief: step.brief });
          destination = { view: "task", id: task.id };
          receipts.push("Task created");
          break;
        }
        case "move-task": {
          const target = findTask(tasks, step.title);
          const task = await tasks.setStage({ id: target.id, stage: step.stage });
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
    if (plan.open) {
      const result = await resolveNavigation(plan.open, input, services);
      return { ...result, message: [...receipts, result.message].filter(Boolean).join(" · ") };
    }
  } catch (error) {
    receipts.push(error instanceof RequestError ? error.message : "Couldn’t finish that command.");
    return { destination, message: receipts.join(" · "), failed: true };
  }
  return {
    destination,
    message: receipts.join(" · ") || "I couldn’t match that to a Pimi action.",
    failed: receipts.length === 0,
  };
}
