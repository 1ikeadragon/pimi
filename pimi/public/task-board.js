// Pimi addition to the Paseo fork. Apache-2.0.
import { replaceBoardLanes } from "./board-motion.js";

export const taskStages = [
  ["backlog", "To Do"],
  ["ready", "Ready"],
  ["in-progress", "In progress"],
  ["review", "Review"],
  ["done", "Done"],
];

export function taskStageLabel(stage) {
  return taskStages.find(([id]) => id === stage)?.[1] ?? taskStages[0][1];
}

export function taskRepositoryName(root) {
  return root.split(/^[A-Za-z]:[\\/]|^\\\\/.test(root) ? /[\\/]/ : "/").at(-1);
}

function linkedItemProgress(item, lane) {
  if (item.error || lane === "attention") return "attention";
  if (lane === "running") return "started";
  if (item.report || lane === "review") return "review";
  return item.path ? "started" : "draft";
}

function workItemProgress(item, card, agent) {
  if (!item.launch) return linkedItemProgress(item, card?.lane);
  if (item.error || card?.unavailable || agent?.needsInput || agent?.status === "error")
    return "attention";
  if (agent?.status === "running" || agent?.status === "initializing") return "started";
  return item.report ? "review" : "started";
}

export function taskProgress(task, cardFor, agentFor) {
  const items = task.experiments.map((item) =>
    workItemProgress(item, cardFor(item), agentFor(item)),
  );
  const review = items.filter((item) => item === "review").length;
  const attention = items.includes("attention");
  let automatic = "backlog";
  if (task.completedByPullRequest) {
    automatic = "done";
  } else if (items.length) {
    if (review === items.length) automatic = "review";
    else if (items.every((item) => item === "draft")) automatic = "ready";
    else automatic = "in-progress";
  }
  return {
    automatic,
    stage: task.done ? "done" : (task.stage ?? automatic),
    review,
    attention,
  };
}

function taskGlyph(name) {
  const namespace = "http://www.w3.org/2000/svg";
  const icon = document.createElementNS(namespace, "svg");
  const use = document.createElementNS(namespace, "use");
  icon.classList.add("glyph");
  icon.setAttribute("aria-hidden", "true");
  use.setAttribute("href", `#glyph-${name}`);
  icon.append(use);
  return icon;
}

export function createTaskBoard({
  element,
  button,
  lanes,
  open,
  move,
  create,
  createLabel,
  preserveFocus,
}) {
  let lastSignature;
  let dragging;
  let pressing;
  let queued;

  function finishDrag() {
    dragging = undefined;
    lanes.querySelector(".task-lane-target")?.classList.remove("task-lane-target");
    flush();
  }

  function flush() {
    if (pressing || dragging) return;
    if (!queued) return;
    const entries = queued;
    queued = undefined;
    render(entries);
  }

  lanes.addEventListener("pointerdown", (event) => {
    if (pressing || !event.isPrimary || event.button !== 0 || !event.target.closest("button"))
      return;
    const { pointerId } = event;
    const listeners = new AbortController();
    pressing = true;
    function release() {
      listeners.abort();
      // Keep the pressed control attached until the browser dispatches its click.
      setTimeout(() => {
        pressing = false;
        flush();
      }, 0);
    }
    function end(pointer) {
      if (pointer.pointerId === pointerId) release();
    }
    const options = { capture: true, signal: listeners.signal };
    window.addEventListener("pointerup", end, options);
    window.addEventListener("pointercancel", end, options);
    window.addEventListener("blur", release, { signal: listeners.signal });
  });

  function createCard({ task, progress, repositories, pending, labels }) {
    const card = element("article", "task-card");
    card.dataset.itemId = task.id;
    card.draggable = !pending;
    card.addEventListener("dragstart", (event) => {
      if (!event.dataTransfer) return;
      dragging = task.id;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-pimi-task", task.id);
    });
    card.addEventListener("dragend", finishDrag);
    const content = button("task-card-open", "", () => open(task.id));
    content.setAttribute("aria-label", task.title);
    const title = element("span", "task-card-title", task.title);
    const context = element("span", "task-card-context");
    const repo = repositories[0] && taskRepositoryName(repositories[0]);
    context.append(
      element(
        "span",
        "",
        repo
          ? `${repo}${repositories.length > 1 ? ` +${repositories.length - 1}` : ""}`
          : "Brief only",
      ),
    );
    if (repo) {
      context.prepend(taskGlyph("branch"));
      context.title = repositories.join("\n");
    }
    const total = task.experiments.length;
    let progressText = total ? `${total} work ${total === 1 ? "item" : "items"}` : "";
    if (progress.review) progressText = `${progress.review}/${total} to review`;
    if (progress.attention) progressText = "Needs attention";
    const progressLabel = element("span", "task-card-meta", progressText);
    context.id = `task-context-${task.id}`;
    progressLabel.id = `task-progress-${task.id}`;
    content.setAttribute(
      "aria-describedby",
      progressText ? `${context.id} ${progressLabel.id}` : context.id,
    );
    progressLabel.hidden = !progressText;
    progressLabel.classList.toggle("task-card-attention", progress.attention);
    content.append(title, context, labels, progressLabel);
    const select = document.createElement("select");
    select.className = "task-card-stage-picker";
    select.setAttribute("aria-label", "Stage for " + task.title);
    select.append(
      new Option("Auto · " + taskStageLabel(progress.automatic), ""),
      ...taskStages.map(([id, label]) => new Option(label, id)),
    );
    const manual = !task.completedByPullRequest && Boolean(task.stage || task.done);
    select.value = manual ? (task.stage ?? "done") : "";
    select.disabled = pending;
    select.addEventListener("change", () => move(task.id, select.value || null));
    const stage = element("span", "task-card-stage");
    stage.title = manual ? "Move task · manual stage" : "Move task · automatic stage";
    stage.dataset.manual = String(manual);
    stage.append(taskGlyph("more"), select);
    card.append(content, stage);
    return card;
  }

  function createLane(id, title, entries, addLabel) {
    const lane = element("section", "lane task-lane");
    const heading = element("div", "lane-heading");
    heading.append(element("h2", "", title), element("span", "count", entries.length));
    if (id === "backlog") {
      const add = button("button quiet glyph-button task-lane-add", "", create);
      add.id = "task-lane-add";
      add.title = addLabel;
      add.setAttribute("aria-label", `${addLabel} in To Do`);
      add.append(taskGlyph("compose"));
      heading.append(add);
    }
    lane.append(heading, ...entries.map(createCard));
    lane.dataset.stage = id;
    lane.dataset.empty = String(!entries.length);
    lane.addEventListener("dragover", (event) => {
      if (!dragging || !event.dataTransfer?.types.includes("application/x-pimi-task")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      lane.classList.add("task-lane-target");
    });
    lane.addEventListener("dragleave", (event) => {
      if (!lane.contains(event.relatedTarget)) lane.classList.remove("task-lane-target");
    });
    lane.addEventListener("drop", (event) => {
      if (!dragging || event.dataTransfer?.getData("application/x-pimi-task") !== dragging) return;
      event.preventDefault();
      lane.classList.remove("task-lane-target");
      if (!entries.some(({ task }) => task.id === dragging)) move(dragging, id);
      finishDrag();
    });
    return lane;
  }

  function render(entries) {
    if (pressing || dragging) {
      queued = entries;
      return;
    }
    const addLabel = createLabel();
    const signature = JSON.stringify([
      addLabel,
      entries.map(({ task, progress, pending, repositories, labelSignature }) => [
        task.id,
        task.title,
        labelSignature,
        task.stage,
        task.done,
        task.completedByPullRequest,
        task.experiments.length,
        progress,
        pending,
        repositories,
      ]),
    ]);
    if (signature === lastSignature) return;
    lastSignature = signature;
    const restore = preserveFocus(lanes);
    const next = taskStages.map(([id, label]) =>
      createLane(
        id,
        label,
        entries.filter(({ progress }) => progress.stage === id),
        addLabel,
      ),
    );
    replaceBoardLanes(lanes, next, "data-item-id");
    restore();
  }

  return render;
}
