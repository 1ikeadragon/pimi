// Pimi. Apache-2.0.
import { labelChips, labelPicker } from "./labels.js";
import { createTasksView } from "./tasks.js";
import { replaceBoardLanes } from "./board-motion.js";
import { createMemoryView } from "./memory.js";
import { createSpacesView } from "./spaces.js";
import { connectLiveUpdates } from "./live-updates.js";

const $ = (id) => document.getElementById(id);

function popVoiceBubble(bubble) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  bubble.animate(
    [
      { opacity: 0, transform: "translateY(5px) scale(.97)" },
      { opacity: 1, transform: "none" },
    ],
    { duration: 160, easing: "ease-out" },
  );
}

if (window.pimiWorkspace?.onVoiceState) {
  const dock = $("pimi-voice-dock");
  const toggle = $("pimi-voice-toggle");
  const badge = $("pimi-voice-status");
  const copy = $("pimi-voice-message");
  const wave = $("pimi-voice-wave");
  const receiptCard = $("pimi-voice-receipt");
  const transcript = $("pimi-voice-transcript");
  const result = $("pimi-voice-result");
  const resultBubble = result.parentElement;
  const bars = [...wave.querySelectorAll("rect")];
  window.pimiWorkspace.onVoiceState(({ visible, active, status, level, receipt }) => {
    dock.hidden = !visible;
    toggle.setAttribute("aria-pressed", String(active));
    toggle.setAttribute("aria-label", active ? "Pimi · Stop listening" : "Pimi · Start listening");
    toggle.title = active ? "Pimi · Stop listening" : "Pimi · Start listening";
    $("pimi-voice-glyph").setAttribute("href", active ? "#glyph-stop" : "#glyph-mic");
    if (copy.textContent !== status) copy.textContent = status;
    badge.hidden = !status;
    wave.toggleAttribute("hidden", !active);
    receiptCard.hidden = !receipt;
    if (receipt) {
      if (transcript.textContent !== receipt.transcript) {
        transcript.textContent = receipt.transcript;
        popVoiceBubble(transcript);
      }
      if (result.textContent !== receipt.message || receiptCard.dataset.state !== receipt.state) {
        result.textContent = receipt.message;
        receiptCard.dataset.state = receipt.state;
        popVoiceBubble(resultBubble);
      }
    } else {
      transcript.textContent = "";
      result.textContent = "";
    }
    bars.forEach((bar, index) => {
      const height = 4 + level * [8, 13, 10][index];
      bar.setAttribute("height", String(height));
      bar.setAttribute("y", String((18 - height) / 2));
    });
  });
}
const laneDefinitions = [
  ["ready", "Ready", "No clean worktrees"],
  ["running", "In progress", "No agents running"],
  ["review", "Review", "Nothing to review"],
  ["attention", "Needs attention", "Nothing needs attention"],
];
let boardRequest;
let boardSignature;
let boardData;
let viewRequest = 0;
const tasksView = createTasksView({
  $,
  api,
  button,
  element,
  message,
  agentChatLinks: agentChatActions,
  openReview: openCheckoutReview,
  pullRequestActions,
  refreshBoard,
});
const memoryView = createMemoryView({ $, api, button, element, message });
const spacesView = createSpacesView({ $, api, button, element, message });
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

async function openTask(id) {
  const request = view("tasks");
  await tasksView.load();
  if (request === viewRequest) tasksView.openTask(id);
}

function openCheckoutReview(card, baseRef = "") {
  window.pimiWorkspace?.openReview({
    kind: "checkout",
    path: card.path,
    ...(baseRef ? { baseRef } : {}),
  });
}

function openPullRequest(url) {
  window.pimiWorkspace?.openReview({ kind: "pull-request", url });
}

function pullRequestActions(...requests) {
  const pr = requests.find(Boolean);
  if (!pr) return [];
  const label = { open: "View PR", closed: "Closed PR", merged: "Merged PR" }[pr.state];
  return [button("button quiet", label, () => openPullRequest(pr.url))];
}

function button(className, label, click) {
  const node = element("button", className, label);
  node.type = "button";
  node.addEventListener("click", click);
  return node;
}

async function api(route, body, signal) {
  const options =
    body === undefined
      ? { signal }
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal,
        };
  const response = await fetch("/api/" + route, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}

function message(id, text) {
  $(id).textContent = text || "";
  $(id).hidden = !text;
}

function view(name) {
  const request = ++viewRequest;
  if (name !== "tasks") tasksView.cancelDictation();
  if (name !== "spaces") spacesView.suspend();
  for (const section of ["tasks", "board", "memory", "spaces"]) {
    $(section).hidden = section !== name;
    const nav = $("show-" + section);
    if (section === name) nav.setAttribute("aria-current", "page");
    else nav.removeAttribute("aria-current");
  }
  window.pimiWorkspace?.setSection(name);
  return request;
}

function describeAgent(agent, worktreeName) {
  return [
    agent.title === worktreeName ? null : agent.title,
    agent.provider,
    agent.needsInput ? "awaiting approval" : agent.status,
  ]
    .filter(Boolean)
    .join(" · ");
}

function agentChatLinks(agents) {
  const active = agents.filter((agent) => agent.chatUrl);
  return active.map((agent) => {
    const label = active.length === 1 ? "Open chat" : `Chat with ${agent.title}`;
    const link = element("a", "button secondary", label);
    link.href = agent.chatUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    return link;
  });
}

function agentChatActions(agents) {
  const links = agentChatLinks(agents);
  if (links.length !== 1) return links;
  const copy = button("button quiet", "Copy chat link", async () => {
    try {
      await navigator.clipboard.writeText(links[0].href);
      copy.textContent = "Copied";
      setTimeout(() => {
        copy.textContent = "Copy chat link";
      }, 1500);
    } catch {
      message("task-warning", "Could not copy the chat link.");
    }
  });
  return [...links, copy];
}

function matchesSearch(query, ...values) {
  return values.some((value) => value?.toLowerCase().includes(query));
}

function renderBoard(data) {
  boardData = data;
  const query = $("board-search").value.trim().toLowerCase();
  const signature = JSON.stringify([query, data], (key, value) =>
    key === "updatedAt" ? undefined : value,
  );
  if (signature === boardSignature) return;
  boardSignature = signature;
  tasksView.setBoard(data);
  $("show-agents").hidden = !data.native;
  message(
    "board-warning",
    [
      ...(data.daemonError
        ? [
            "Agent activity is unavailable. Showing last known activity; reconnecting automatically.",
          ]
        : []),
      ...data.warnings,
    ].join(" "),
  );
  const cardsMatchingQuery = data.cards.filter(
    (card) =>
      matchesSearch(
        query,
        card.repo,
        card.name,
        card.branch,
        card.path,
        ...(card.labels ?? []),
        ...(card.linkedLabels ?? []),
      ) || card.agents.some((agent) => matchesSearch(query, describeAgent(agent))),
  );
  const otherAgents = data.otherAgents.filter((agent) =>
    matchesSearch(query, describeAgent(agent), agent.cwd),
  );
  const lanes = laneDefinitions.map(([id, title, empty]) => {
    const lane = element("section", "lane " + id);
    lane.dataset.stage = id;
    const header = element("div", "lane-heading");
    const cards = cardsMatchingQuery.filter((card) => card.lane === id);
    header.append(element("h2", "", title), element("span", "count", cards.length));
    lane.append(header);
    for (const card of cards) {
      const item = element("article", "card");
      const open = button("work-card-open", "", () =>
        openCheckoutReview(card, tasksView.baseForWorktree(card)),
      );
      open.disabled = Boolean(card.unavailable);
      item.dataset.path = card.path;
      item.title = card.path;
      const gitStatus = [
        card.unavailable ? "Worktree missing" : card.error,
        card.dirty ? "Working changes" : "",
        card.ahead ? `${card.ahead} ahead of base` : "",
      ].filter(Boolean);
      open.append(
        element("span", "card-name", card.name),
        element("span", "card-repo", card.repo),
        element("span", "card-detail", gitStatus.join(" · ") || "No pending changes"),
        ...card.agents.map((agent) =>
          element("span", "card-agent", describeAgent(agent, card.name)),
        ),
      );
      item.append(open, labelChips(card.labels, data.labels, card.linkedLabels));
      if (card.pullRequest || card.taskLinks?.length) {
        const links = element("div", "experiment-actions");
        links.append(...pullRequestActions(card.pullRequest));
        for (const task of card.taskLinks ?? []) {
          links.append(button("button quiet", task.title, () => openTask(task.id)));
        }
        item.append(links);
      }
      if (card.workspaceId)
        item.append(
          labelPicker({
            names: card.labels,
            catalog: data.labels,
            error: data.labelsError,
            onChange: async (_names, name, assigned) => {
              await api("work/label", { workspaceId: card.workspaceId, name, assigned });
              await refreshBoard();
            },
          }),
        );
      lane.append(item);
    }
    if (!cards.length) lane.append(element("p", "empty", query ? "No matching worktrees" : empty));
    return lane;
  });
  const focused = document.activeElement;
  const focusedPath = focused?.closest(".card")?.dataset.path;
  const openLabels = new Set(
    [...$("lanes").querySelectorAll(".card:has(.label-picker[open])")].map(
      (card) => card.dataset.path,
    ),
  );
  replaceBoardLanes($("lanes"), lanes, "data-path");
  for (const card of $("lanes").querySelectorAll(".card")) {
    const picker = card.querySelector(".label-picker");
    if (picker && openLabels.has(card.dataset.path)) picker.open = true;
    if (card.dataset.path !== focusedPath) continue;
    const target =
      focused?.tagName === "INPUT"
        ? [...card.querySelectorAll("input")].find((input) => input.value === focused.value)
        : card.querySelector(focused?.tagName === "SUMMARY" ? "summary" : ".work-card-open");
    target?.focus({ preventScroll: true });
  }
  $("other-agents").hidden = !otherAgents.length;
  $("agent-list").replaceChildren(
    ...otherAgents.map((agent) => {
      const row = element("div", "agent-row", describeAgent(agent));
      row.title = agent.cwd;
      return row;
    }),
  );
}

async function refreshBoard() {
  if (boardRequest) return boardRequest;
  boardRequest = api("board")
    .then((data) => {
      renderBoard(data);
      return true;
    })
    .catch((error) => {
      boardSignature = undefined;
      message("board-warning", error.message);
      return false;
    })
    .finally(() => {
      boardRequest = undefined;
    });
  return boardRequest;
}

async function watchRepository(event) {
  event.preventDefault();
  const path = $("repo-path").value.trim();
  $("add-repo").disabled = true;
  message("watch-error", "");
  try {
    await boardRequest;
    renderBoard(await api("repositories", { path }));
    $("repo-path").value = "";
    $("watch-repo").closest("details").open = false;
  } catch (error) {
    message("watch-error", error.message);
  } finally {
    $("add-repo").disabled = false;
  }
}

$("show-board").addEventListener("click", () => {
  view("board");
  void refreshBoard();
});
$("show-tasks").addEventListener("click", () => {
  view("tasks");
  tasksView.showBoard();
  void tasksView.load();
  void refreshBoard();
});
$("show-memory").addEventListener("click", () => {
  view("memory");
  void memoryView.load();
});
$("show-spaces").addEventListener("click", () => {
  view("spaces");
  void spacesView.load();
});
const appearance = $("appearance");
appearance.value = document.documentElement.dataset.appearance;
if (window.pimiWorkspace) {
  $("show-agents").hidden = false;
  $("show-memory").hidden = false;
  $("show-spaces").hidden = false;
  document.documentElement.dataset.workspaceChrome = window.pimiWorkspace.chrome;
  window.pimiWorkspace.onLayoutChange((mode) => {
    if (mode === "hidden") {
      ++viewRequest;
      spacesView.suspend();
    } else if (!$("spaces").hidden) spacesView.resume();
    document.documentElement.dataset.workspaceLayout = mode;
    window.dispatchEvent(new Event("pimi-layout-change"));
  });
  window.pimiWorkspace.onAppearanceChange((mode) => {
    document.documentElement.dataset.appearance = mode;
  });
} else {
  $("open-settings").hidden = false;
  $("open-settings").addEventListener("click", () => {
    $("settings-dialog").showModal();
  });
}
appearance.addEventListener("change", async () => {
  const root = document.documentElement;
  const previous = root.dataset.appearance;
  root.dataset.appearance = appearance.value;
  appearance.disabled = true;
  message("appearance-error", "");
  try {
    await api("appearance", { mode: appearance.value });
  } catch (error) {
    appearance.value = previous;
    root.dataset.appearance = previous;
    message("appearance-error", error.message);
  } finally {
    appearance.disabled = false;
  }
});
window.pimiWorkspace?.onNavigate(async (destination) => {
  if (destination.view === "spaces") {
    view("spaces");
    await spacesView.load(destination.action);
    return;
  }
  if (destination.view === "memory") {
    view("memory");
    await memoryView.load(destination.projectId);
    return;
  }
  if (destination.view === "tasks") {
    $("show-tasks").click();
    return;
  }
  if (destination.view === "task") {
    await openTask(destination.id);
    return;
  }
  if (destination.view === "task-draft" || destination.view === "new-task") {
    const request = view("tasks");
    await Promise.all([refreshBoard(), tasksView.load()]);
    if (request !== viewRequest) return;
    if (destination.view === "task-draft") tasksView.openProposal(destination.proposal);
    else tasksView.openDraft(destination);
    return;
  }
  $("show-board").click();
});
$("board-search").addEventListener("input", () => {
  if (boardData) renderBoard(boardData);
});
$("board-search").addEventListener("keydown", (event) => {
  if (event.key === "Enter") $("lanes").querySelector(".work-card-open:not(:disabled)")?.click();
});
$("watch-repo").addEventListener("submit", watchRepository);
function focusViewSearch(event) {
  const search = $($("tasks").hidden ? "board-search" : "task-search");
  if (!search || search.closest("[hidden]") || !search.getClientRects().length) return;
  event.preventDefault();
  search.focus();
}
document.addEventListener("keydown", (event) => {
  if (
    event.defaultPrevented ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    event.isComposing ||
    event.target?.closest?.("input, select, textarea, [contenteditable]")
  )
    return;
  if (event.key === "/") focusViewSearch(event);
});
connectLiveUpdates({
  refreshBoard,
  refreshTasks: tasksView.load,
  status: (text) => message("live-status", text),
});
