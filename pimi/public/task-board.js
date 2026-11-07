// Pimi addition to the Paseo fork. Apache-2.0.
export const taskStages = [
  ["backlog", "Backlog"],
  ["ready", "Ready"],
  ["in-progress", "In progress"],
  ["review", "Review"],
  ["done", "Done"],
];

export function taskStageLabel(stage) {
  return taskStages.find(([id]) => id === stage)?.[1] ?? "Backlog";
}

function linkedItemProgress(item, lane) {
  if (item.error || lane === "attention") return "attention";
  if (lane === "running") return "started";
  if (item.report || lane === "review") return "review";
  return item.path ? "started" : "draft";
}

function workItemProgress(item, card) {
  if (!item.launch) return linkedItemProgress(item, card?.lane);
  const agent = card?.agents.find(({ id }) => id === item.id);
  if (item.error || card?.unavailable || agent?.needsInput || agent?.status === "error")
    return "attention";
  if (agent?.status === "running" || agent?.status === "initializing") return "started";
  return item.report ? "review" : "started";
}

export function taskProgress(task, cardFor) {
  const items = task.experiments.map((item) => workItemProgress(item, cardFor(item)));
  const review = items.filter((item) => item === "review").length;
  const attention = items.includes("attention");
  let automatic = "backlog";
  if (items.length) {
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

export function createTaskBoard({ element, button, lanes, open, move, preserveFocus }) {
  let lastSignature;
  let dragging;
  let queued;

  function finishDrag() {
    dragging = undefined;
    if (!queued) return;
    const entries = queued;
    queued = undefined;
    render(entries);
  }

  function createCard({ task, progress, repositories, pending }, previousStage) {
    const card = element("article", "task-card");
    card.dataset.itemId = task.id;
    if (previousStage && previousStage !== progress.stage) card.classList.add("card-moved");
    card.draggable = !pending;
    card.addEventListener("dragstart", (event) => {
      if (!event.dataTransfer) return;
      dragging = task.id;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-pimi-task", task.id);
    });
    card.addEventListener("dragend", finishDrag);
    const title = button("task-card-title", task.title, () => open(task.id));
    title.setAttribute("aria-label", task.title);
    const details = [];
    const total = task.experiments.length;
    if (repositories)
      details.push(repositories === 1 ? "1 repository" : repositories + " repositories");
    if (total) details.push(progress.review + " of " + total + " ready for review");
    const select = document.createElement("select");
    select.className = "task-stage-select";
    select.setAttribute("aria-label", "Stage for " + task.title);
    select.append(
      new Option("Auto · " + taskStageLabel(progress.automatic), ""),
      ...taskStages.map(([id, label]) => new Option(label, id)),
    );
    select.value = task.stage ?? (task.done ? "done" : "");
    select.disabled = pending;
    select.addEventListener("change", () => move(task.id, select.value || null));
    card.append(title, element("p", "task-card-meta", details.join(" · ") || "Brief only"));
    if (progress.attention)
      card.append(element("p", "task-card-meta task-card-attention", "Needs attention"));
    card.append(select);
    return card;
  }

  function createLane(id, title, entries, previous) {
    const lane = element("section", "lane task-lane");
    const heading = element("div", "lane-heading");
    heading.append(element("h2", "", title), element("span", "count", entries.length));
    lane.append(heading, ...entries.map((entry) => createCard(entry, previous.get(entry.task.id))));
    if (!entries.length) lane.append(element("p", "empty", "No tasks"));
    lane.addEventListener("dragover", (event) => {
      if (!dragging || !event.dataTransfer?.types.includes("application/x-pimi-task")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    });
    lane.addEventListener("drop", (event) => {
      if (!dragging || event.dataTransfer?.getData("application/x-pimi-task") !== dragging) return;
      event.preventDefault();
      if (!entries.some(({ task }) => task.id === dragging)) move(dragging, id);
      finishDrag();
    });
    return lane;
  }

  function render(entries) {
    if (dragging) {
      queued = entries;
      return;
    }
    const signature = JSON.stringify(
      entries.map(({ task, progress, pending, repositories }) => [
        task.id,
        task.title,
        task.stage,
        task.done,
        task.experiments.length,
        progress,
        pending,
        repositories,
      ]),
    );
    if (signature === lastSignature) return;
    lastSignature = signature;
    const restore = preserveFocus(lanes);
    const previous = new Map(
      [...lanes.querySelectorAll(".task-card")].map((card) => [
        card.dataset.itemId,
        card.parentElement.dataset.stage,
      ]),
    );
    lanes.replaceChildren(
      ...taskStages.map(([id, label]) => {
        const lane = createLane(
          id,
          label,
          entries.filter(({ progress }) => progress.stage === id),
          previous,
        );
        lane.dataset.stage = id;
        return lane;
      }),
    );
    restore();
  }

  return render;
}
