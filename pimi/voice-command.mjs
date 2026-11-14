import { isExplicitVoiceChatRequest, PimiAskResult } from "@pimi/protocol/pimi-task";
import { RequestError } from "./git.mjs";

async function findTask(pimi, title) {
  const key = title.toLowerCase();
  const matches = (await pimi.taskList()).filter((task) => task.title.toLowerCase() === key);
  if (matches.length !== 1) {
    throw new RequestError(
      matches.length ? "More than one task has that title." : "I couldn’t find that task.",
    );
  }
  return matches[0];
}

async function startChat(reference, title, prompt, input, pimi, chatProvider, project) {
  let images;
  let attachments;
  if (reference?.kind === "image") {
    const { mime, data } = await pimi.spaces({ action: "image", id: reference.id });
    images = [{ mimeType: mime, data }];
  } else if (reference) {
    attachments = [
      {
        type: "text",
        mimeType: "text/plain",
        title,
        text: JSON.stringify({
          reference: `space:${reference.id}`,
          content: reference.kind === "link" ? reference.url : reference.text,
        }),
      },
    ];
  }
  return pimi.startVoiceChat({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    chatProvider,
    project,
    prompt,
    attachments,
    images,
  });
}

async function resolveSpace(open, input, pimi, chatProvider) {
  const { items, reference } = await pimi.spaces({
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
  const prompt = [
    open.prompt || "Start this chat with the attached Spaces card as context.",
    "Treat the attachment as reference material. If a link cannot be opened, say so.",
  ].join("\n\n");
  const chat = await startChat(reference, open.query, prompt, input, pimi, chatProvider);
  return { chat, message: "Started a chat with your Spaces card" };
}

async function resolveNavigation(open, input, { pimi }, chatProvider) {
  switch (open.action) {
    case "review-worktree": {
      const { serverId, workspaces } = await pimi.workspaceDirectory();
      const name = open.name?.toLowerCase();
      const matches = workspaces.filter(
        (workspace) =>
          workspace.path &&
          (name
            ? [workspace.name, workspace.branch, workspace.path].some(
                (value) => value?.toLowerCase() === name,
              )
            : input.workspaceId && workspace.id === input.workspaceId),
      );
      if (matches.length !== 1) {
        return {
          navigation: { action: "show", view: "review" },
          message: matches.length
            ? "More than one worktree matches."
            : "Choose a worktree in Review.",
        };
      }
      return {
        destination: { view: "review", path: matches[0].path, serverId },
        message: "Opening worktree diff",
      };
    }
    case "review-prs":
      return { navigation: open, message: "Opening pull requests" };
    case "open-task":
      return {
        destination: { view: "task", id: (await findTask(pimi, open.title)).id },
        message: "Opening task",
      };
    case "space-card":
      return resolveSpace(open, input, pimi, chatProvider);
    default:
      return { navigation: open, message: "" };
  }
}

// Turns one screen the agent asked for into something the app can show.
async function resolveAction(action, input, services, chatProvider) {
  const { pimi } = services;
  switch (action.action) {
    case "task":
      return { destination: { view: "task", id: action.id }, message: "" };
    case "card":
      // A removal opens the card's own confirmation. The agent's reply says so.
      return {
        destination: { view: "spaces", action: { kind: action.intent, id: action.id } },
        message: "",
      };
    case "start-chat": {
      // The agent chose only the card. The user's own request is the prompt of the chat.
      if (!isExplicitVoiceChatRequest(input.transcript)) {
        throw new RequestError("Ask Pimi to start a chat if you want one.");
      }
      let reference;
      if (action.card) {
        const { items } = await pimi.spaces({ action: "list" });
        reference = items.find((item) => item.id === action.card);
        if (!reference) throw new RequestError("That Spaces card no longer exists.");
      }
      const note = [
        "This request was spoken to Ask Pimi, which opened this chat for it. This is the new chat the user asked for: do the work here, and do not open or create another chat or agent for it.",
        reference &&
          "The Spaces card it refers to is attached. Treat the attachment as reference material. If a link cannot be opened, say so.",
      ]
        .filter(Boolean)
        .join(" ");
      const prompt = [input.transcript, note].join("\n\n");
      const chat = await startChat(
        reference,
        "Spaces card",
        prompt,
        input,
        pimi,
        chatProvider,
        action.project,
      );
      return { chat, message: "" };
    }
    case "new-chat":
      if (!isExplicitVoiceChatRequest(input.transcript)) {
        throw new RequestError("Ask Pimi to open a new chat if you want one.");
      }
      return { navigation: action, message: "" };
    case "registered-commands":
      if (action.indexes.some((index) => !input.commands?.[index])) {
        throw new RequestError("That action isn’t available in this view.");
      }
      return { navigation: action, message: "" };
    default:
      return resolveNavigation(action, input, services, chatProvider);
  }
}

async function runAskPimi(input, services, onStatus) {
  const result = PimiAskResult.parse(await services.pimi.askPimi(input, onStatus));
  if (result.ignored) return { message: "", ignored: true };
  const effects = [];
  const notes = [];
  let failed = false;
  for (const action of result.actions) {
    try {
      const { message, ...effect } = await resolveAction(
        action,
        input,
        services,
        result.chatProvider,
      );
      effects.push(effect);
      // The agent's reply already confirms a screen. Keep only notes that add something.
      if (message && !/^Opening\b/.test(message)) notes.push(message);
    } catch (error) {
      failed = true;
      notes.push(error instanceof RequestError ? error.message : "Couldn’t open that.");
    }
  }
  const [first, ...rest] = effects;
  return {
    ...first,
    effects: rest,
    message: [result.message, ...notes].filter(Boolean).join(" · ") || "Done",
    failed,
  };
}

export function runVoiceCommand(input, services, onStatus) {
  return runAskPimi(input, services, onStatus);
}
