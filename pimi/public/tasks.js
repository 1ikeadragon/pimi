// Pimi. Apache-2.0.
import {
  createTaskBoard,
  taskProgress,
  taskRepositoryName,
  taskStageLabel,
  taskStages,
} from "./task-board.js";
import { labelChips, labelPicker } from "./labels.js";

export function createTasksView({
  $,
  api,
  button,
  element,
  message,
  agentChatLinks,
  openReview,
  pullRequestActions,
  compareReview,
  refreshBoard,
}) {
  let tasks = [];
  let hasLoadedTasks = false;
  let inventory = { cards: [], repositories: [] };
  let selectedId;
  let taskDetailView = "work";
  let reportWorkerId;
  let reportDocumentKey;
  let reportActionKey;
  let renderedExperiments;
  let cardsByWorkspace = new Map();
  let cardsByPath = new Map();
  let agentsById = new Map();
  const stageRequests = new Set();
  let creating = false;
  let draft;
  let dictation;
  let request = 0;
  const models = new Map();
  let modelRevision = 0;
  const taskDefaults = new Map();
  const modelRequests = new Set();
  const modelErrors = new Map();
  const launches = new Set();
  const planning = new Set();
  const reportRequests = new Set();
  const reportErrors = new Map();
  const autoCollected = new Set();
  const busyControls = new Set();

  const selected = () => tasks.find((task) => task.id === selectedId);
  const visible = () => !$("tasks").hidden;
  const drafts = (task) => task.experiments.filter((item) => !item.path && !item.report);
  const agentFor = (item) => agentsById.get(item.id);
  const repositoriesFor = (task) =>
    task.repositories ?? (task.root ? [{ root: task.root, base: task.base }] : []);
  const repositoryFor = (task, item) =>
    repositoriesFor(task).find(({ root }) => root === (item.root ?? task.root));

  function modelForItem(item, choices) {
    const requested = item.launch?.config.provider ?? item.provider ?? $("task-model").value;
    const id = Object.hasOwn(choices?.defaults ?? {}, requested)
      ? choices.defaults[requested]
      : requested;
    return { id, model: choices?.models.find((model) => model.id === id) };
  }

  function preserveFocus(container) {
    const active = document.activeElement;
    if (active?.id === "task-lane-add") {
      return () => $("task-lane-add")?.focus({ preventScroll: true });
    }
    const row = active?.closest("[data-item-id]");
    if (!row || !container.contains(row)) return () => {};
    const label = active.getAttribute("aria-label") || active.textContent;
    return () => {
      const replacement = [...container.querySelectorAll("[data-item-id]")].find(
        (item) => item.dataset.itemId === row.dataset.itemId,
      );
      const control =
        replacement &&
        [replacement, ...replacement.querySelectorAll("button, a, select, summary")].find(
          (item) =>
            item.tagName === active.tagName &&
            (item.getAttribute("aria-label") || item.textContent) === label,
        );
      control?.focus({ preventScroll: true });
    };
  }

  function sourceChat({ serverId, agentId }) {
    return `pimi://h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(agentId)}`;
  }

  function cardFor(experiment) {
    const workspace = cardsByWorkspace.get(experiment.workspaceId);
    const byPath = cardsByPath.get(experiment.path);
    return workspace ?? (experiment.workspaceId && byPath?.workspaceId ? undefined : byPath);
  }

  function experimentStatus(item, agent) {
    if (item.report) return "Report ready";
    if (reportRequests.has(item.id)) return "Getting report…";
    if (agent?.needsInput) return "Needs approval";
    if (agent?.status === "error" || item.error) return "Needs attention";
    if (["running", "initializing"].includes(agent?.status)) return "Running";
    if (agent?.status === "idle") return "Agent finished";
    if (item.path) return "Linked worktree";
    return item.launch ? "Launch pending" : "Draft";
  }

  function options(select, entries, placeholder, preferred) {
    const signature = JSON.stringify([entries, placeholder, preferred]);
    if (signature === select.dataset.options) return;
    select.dataset.options = signature;
    const previous = select.value;
    const empty = new Option(placeholder, "");
    select.replaceChildren(empty, ...entries.map(({ id, label }) => new Option(label, id)));
    const value = entries.find(
      (entry) => entry.id === previous || (previous === "" && entry.id === preferred),
    );
    if (value) select.value = value.id;
  }

  const renderTaskBoard = createTaskBoard({
    button,
    element,
    lanes: $("task-list"),
    open(id) {
      choose(id);
      $("task-title").focus();
    },
    move: moveTask,
    create: () => beginCreate(),
    createLabel: () => (draft ? "Resume draft" : "New task"),
    preserveFocus,
  });

  function renderList() {
    const query = $("task-search").value.trim().toLowerCase();
    const attentionOnly = $("task-attention").getAttribute("aria-pressed") === "true";
    const entries = tasks
      .map((task) => ({
        task,
        progress: taskProgress(task, cardFor, agentFor),
        repositories: repositoriesFor(task).map(({ root }) => root),
        pending: stageRequests.has(task.id),
        linkedLabels: inventory.taskLabels?.[task.id] ?? [],
        labels: labelChips(task.labels, inventory.labels, inventory.taskLabels?.[task.id]),
        labelSignature: JSON.stringify([
          task.labels,
          inventory.labels,
          inventory.taskLabels?.[task.id],
        ]),
      }))
      .filter(
        ({ task, progress, repositories, linkedLabels }) =>
          (!attentionOnly || (!task.done && progress.attention)) &&
          `${task.title} ${task.brief} ${[...(task.labels ?? []), ...linkedLabels].join(" ")} ${repositories.join(" ")}`
            .toLowerCase()
            .includes(query),
      );
    const noMatches = !entries.length && Boolean(query || attentionOnly);
    $("task-list").hidden = !hasLoadedTasks || noMatches;
    $("task-board-empty").hidden = !hasLoadedTasks || !noMatches;
    if (noMatches) {
      $("task-empty-title").textContent = "No matching tasks";
      $("task-empty-description").textContent = "Change your search or clear the attention filter.";
    }
    renderTaskBoard(entries);
    $("new-task-label").textContent = draft ? "Resume draft" : "New task";
  }

  function renderLabels(container, names = [], onChange, linked = []) {
    const signature = JSON.stringify([
      names,
      linked,
      inventory.labels,
      inventory.labelsError,
      selectedId,
    ]);
    if (container.dataset.labels === signature) return;
    container.dataset.labels = signature;
    const wasOpen = container.querySelector("details")?.open;
    const focused = container.contains(document.activeElement)
      ? document.activeElement.value
      : undefined;
    container.replaceChildren(
      labelChips(names, inventory.labels, linked),
      labelPicker({
        names,
        catalog: inventory.labels,
        error: inventory.labelsError,
        onChange,
      }),
    );
    container.querySelector("details").open = Boolean(wasOpen);
    if (focused)
      [...container.querySelectorAll("input")]
        .find((input) => input.value === focused)
        ?.focus({ preventScroll: true });
  }

  function renderDraftLabels() {
    renderLabels($("task-create-labels"), draft.labels, async (names) => {
      draft.labels = names;
      $("task-create-labels")
        .querySelector(".label-chips")
        .replaceWith(labelChips(names, inventory.labels));
    });
  }

  function showTaskStage(task) {
    const picker = $("task-stage");
    const progress = taskProgress(task, cardFor, agentFor);
    options(
      picker,
      taskStages.map(([id, label]) => ({ id, label })),
      "Auto · " + taskStageLabel(progress.automatic),
    );
    picker.value = task.completedByPullRequest ? "" : (task.stage ?? (task.done ? "done" : ""));
    picker.disabled = stageRequests.has(task.id);
    $("task-close").textContent = task.done ? "Reopen task" : "Mark done";
    $("task-close").disabled =
      stageRequests.has(task.id) || launches.has(task.id) || planning.has(task.id);
  }

  async function moveTask(id, stage) {
    if (stageRequests.has(id)) return;
    const restore = preserveFocus($("task-list"));
    const detailFocused = document.activeElement === $("task-stage");
    stageRequests.add(id);
    renderList();
    renderDetails();
    message("task-warning", "");
    try {
      const updated = await api("tasks/stage", { id, stage });
      tasks = tasks.map((task) => (task.id === id ? updated : task));
      await load();
    } catch (error) {
      message("task-warning", error.message);
    } finally {
      stageRequests.delete(id);
      renderList();
      renderDetails();
      if (detailFocused && selectedId === id) $("task-stage").focus();
      else restore();
    }
  }

  function showModelControls(task) {
    const pending = drafts(task);
    const choices = models.get(task.id);
    const active = launches.has(task.id) || planning.has(task.id);
    const plan = $("task-plan-details");
    plan.hidden = task.done || (!task.root && task.mode !== "chat");
    if (!plan.hidden && pending.length && plan.dataset.hasDrafts !== "true") plan.open = true;
    plan.dataset.hasDrafts = String(Boolean(pending.length));
    $("task-model").disabled = active || !choices?.models.length;
    const blocked = pending.slice(0, 4).find((item) => !modelForItem(item, choices).model);
    $("task-models").hidden =
      !modelErrors.has(task.id) && choices?.models.length !== 0 && !(choices && blocked);
    $("task-models").disabled = active || modelRequests.has(task.id);
    const modelChosen = Boolean($("task-model").value && choices?.models.length);
    $("run-task").disabled = active || Boolean(blocked) || !pending.length;
    $("run-task").hidden = !pending.length;
    $("suggest-experiments").disabled = active || !modelChosen || task.experiments.length > 6;
    $("run-task").textContent = launchLabel(pending);
    $("task-run-note").textContent = modelControlNote(task, choices, active, blocked);
  }

  function launchLabel(pending) {
    if (pending.length > 4) return "Start next 4";
    return pending.every((item) => item.launch) ? "Retry launches" : "Start agents";
  }

  function modelControlNote({ id, mode, source }, choices, active, blocked) {
    if (planning.has(id)) return "Drafting two work items from the brief…";
    if (active) return "Checking the assigned models and starting agents…";
    if (modelRequests.has(id)) return "Finding available models…";
    if (modelErrors.has(id)) return modelErrors.get(id);
    if (choices?.models.length === 0) return "No ready models. Check Agent Console settings.";
    if (blocked && choices) {
      if (blocked.launch)
        return `Restore ${blocked.launch.modelLabel ?? blocked.launch.config.provider} to retry “${blocked.title}”.`;
      return `Choose an available model for “${blocked.title}”.`;
    }
    const location = mode === "chat" ? "in separate folders" : "in separate Git worktrees";
    return source
      ? `Agents work ${location}. They use context from the original chat and report back there.`
      : `Agents work ${location} and report to the task.`;
  }

  function discoverModels(task) {
    const plan = $("task-plan-details");
    if (visible() && plan.open && !plan.hidden && !models.has(task.id) && !modelErrors.has(task.id))
      void loadModels(task);
  }

  function selectReportView(view, workerId) {
    taskDetailView = view;
    if (workerId) reportWorkerId = workerId;
    renderDetails();
  }

  $("show-task-reports").addEventListener("click", () => selectReportView("reports"));
  $("show-task-work").addEventListener("click", () => selectReportView("work"));
  $("task-report-worker").addEventListener("change", (event) =>
    selectReportView("reports", event.currentTarget.value),
  );

  async function renderReportDocument(task, item) {
    const document = $("task-report-document");
    const key = item?.report ? item.id : undefined;
    if (key === reportDocumentKey) return;
    reportDocumentKey = key;
    document.replaceChildren();
    document.dataset.taskId = task.id;
    document.dataset.reportId = key ?? "";
    if (!key) return;
    const query = new URLSearchParams({ id: task.id, experimentId: item.id });
    try {
      const { html } = await api("tasks/report-document?" + query);
      if (reportDocumentKey === key) document.innerHTML = html;
    } catch {
      if (reportDocumentKey === key)
        document.append(element("p", "experiment-hypothesis", item.report));
    }
  }

  const reportLinkErrors = new Map();
  window.pimiWorkspace?.onReportLinkError?.(({ reportId, message: linkError }) => {
    reportLinkErrors.set(reportId, linkError);
    if (reportId === reportWorkerId) renderDetails();
  });

  function renderReportActions(task, item, agent) {
    const card = cardFor(item);
    const reviewable = card && !card.unavailable && (card.dirty || card.ahead || card.prUrl);
    const actionKey = JSON.stringify([
      task.id,
      task.done,
      item.id,
      Boolean(item.report),
      agent?.chatUrl,
      reportErrors.get(item.id),
      reportRequests.has(item.id),
      reviewable,
    ]);
    if (actionKey === reportActionKey) return;
    reportActionKey = actionKey;
    const actions = $("task-report-actions");
    actions.replaceChildren(...agentChatLinks(agent ? [agent] : []));
    if (item.report) {
      const copy = button("button quiet", "Copy report", async () => {
        try {
          await navigator.clipboard.writeText(item.report);
          copy.textContent = "Copied";
        } catch {
          copy.textContent = "Copy failed";
        }
      });
      actions.prepend(copy);
    } else if (!task.done && reportErrors.has(item.id) && !reportRequests.has(item.id)) {
      actions.prepend(
        button("button secondary", "Retry report", () => void collectReport(task, item)),
      );
    }
    if (reviewable)
      actions.append(
        button("button quiet", "Review changes", () =>
          openReview(card, repositoryFor(task, item)?.base || ""),
        ),
      );
  }

  function renderReports(task) {
    const items = task.experiments;
    const ready = items.filter((item) => item.report);
    const show = taskDetailView === "reports" && items.length > 0;
    $("task-detail-views").hidden = !items.length;
    $("show-task-reports").textContent = ready.length ? `Reports · ${ready.length}` : "Reports";
    $("show-task-reports").setAttribute("aria-pressed", String(show));
    $("show-task-work").setAttribute("aria-pressed", String(!show));
    $("task-reports").hidden = !show;
    $("task-work").hidden = show;
    if (!show) return;
    const item = items.find(({ id }) => id === reportWorkerId) ?? ready[0] ?? items[0];
    reportWorkerId = item.id;
    const picker = $("task-report-worker");
    options(
      picker,
      items.map((worker) => ({
        id: worker.id,
        label: `${worker.title} · ${reportStatus(worker, agentFor(worker))}`,
      })),
      "Choose a worker",
    );
    picker.value = item.id;
    $("task-report-progress").textContent = `${ready.length} of ${items.length} ready`;
    $("task-report-title").textContent = item.title;
    const agent = agentFor(item);
    const warning = item.reportTruncated
      ? "Report shortened. Open chat for the full response."
      : "";
    message(
      "task-report-status",
      reportLinkErrors.get(item.id) ||
        warning ||
        (!item.report ? (reportErrors.get(item.id) ?? reportStatus(item, agent)) : ""),
    );
    $("task-report-instructions").textContent = item.hypothesis;
    renderReportActions(task, item, agent);
    void renderReportDocument(task, item);
  }

  function reportStatus(item, agent) {
    if (item.report) return "Ready";
    if (reportErrors.has(item.id)) return "Report unavailable";
    if (agent?.status === "closed") return "No saved report";
    return experimentStatus(item, agent);
  }

  function workItemActions(task, { item, card, agent, chatAgents }) {
    const actions = element("div", "experiment-actions");
    if (item.report)
      actions.append(
        button("button secondary", "Read report", () => selectReportView("reports", item.id)),
      );
    actions.append(
      ...agentChatLinks(chatAgents),
      ...pullRequestActions(item.pullRequest, card?.pullRequest),
    );
    if (card && !card.unavailable) {
      const base = repositoryFor(task, item)?.base || "";
      actions.append(
        button("button secondary", "Review changes", () => openReview(card, base)),
        button("button quiet", "Compare alongside", () => compareReview(card, base)),
      );
    }
    if (!task.done && !item.launch && !item.path && !item.report) {
      actions.append(workItemModelPicker(task, item));
      const repositories = repositoriesFor(task);
      if (repositories.length > 1)
        actions.append(workItemRepositoryPicker(task, item, repositories));
      const discard = button("button secondary", "Discard draft", () => {
        void perform(discard, async () => {
          await api("tasks/discard", { id: task.id, experimentId: item.id });
          await load();
        });
      });
      discard.disabled = launches.has(task.id) || planning.has(task.id);
      actions.append(discard);
    }
    if (
      (!task.done || task.completedByPullRequest) &&
      item.launch &&
      !item.report &&
      reportErrors.has(item.id)
    ) {
      const retry = button(
        "button secondary",
        "Retry report",
        () => void collectReport(task, item),
      );
      retry.disabled =
        reportRequests.has(item.id) || ["initializing", "running"].includes(agent?.status);
      actions.append(retry);
    }
    return actions;
  }

  function workItemModelPicker(task, item) {
    const choices = models.get(task.id);
    const picker = element("select", "work-item-model");
    picker.setAttribute("aria-label", `Model for ${item.title}`);
    const { id: modelId, model } = modelForItem(item, choices);
    const fallback = choices?.models.find(({ id }) => id === $("task-model").value);
    const defaultLabel = fallback ? `Default · ${fallback.label}` : "Use task default";
    picker.replaceChildren(new Option(defaultLabel, ""));
    if (item.provider && !model) {
      const unavailable = new Option(
        choices ? `Unavailable · ${item.provider}` : item.provider,
        modelId,
      );
      unavailable.disabled = true;
      picker.append(unavailable);
    }
    for (const { id, label } of choices?.models ?? []) picker.append(new Option(label, id));
    picker.value = item.provider ? modelId : "";
    picker.disabled = launches.has(task.id) || planning.has(task.id) || !choices?.models.length;
    picker.addEventListener("change", () => {
      void perform(picker, async () => {
        try {
          await api("tasks/assign-model", {
            id: task.id,
            experimentId: item.id,
            model: picker.value || null,
          });
          await load();
        } catch (error) {
          picker.value = item.provider ? modelId : "";
          throw error;
        }
      });
    });
    return picker;
  }

  function workerLaunchDetails(item, choices) {
    if (!item.launch) return null;
    const { id, model } = modelForItem(item, choices);
    const label = item.launch.modelLabel ?? model?.label ?? id;
    const details = element("div", "experiment-model-details");
    details.append(element("span", "experiment-model-label", label));
    if (item.launch.contextStatus) {
      const subject = item.launch.contextStatus === "excerpt" ? "Chat excerpt" : "Chat context";
      details.append(element("span", "subtitle", `${subject} ${item.path ? "attached" : "ready"}`));
    }
    return details;
  }

  function workItemRepositoryPicker(task, item, repositories) {
    const picker = element("select", "work-item-repository");
    picker.setAttribute("aria-label", `Repository for ${item.title}`);
    picker.replaceChildren(
      ...repositories.map(({ root }) => new Option(taskRepositoryName(root), root)),
    );
    picker.value = repositoryFor(task, item)?.root ?? "";
    picker.disabled = launches.has(task.id) || planning.has(task.id);
    picker.addEventListener("change", () => {
      void perform(picker, async () => {
        try {
          await api("tasks/assign-repository", {
            id: task.id,
            experimentId: item.id,
            root: picker.value,
          });
          await load();
        } catch (error) {
          picker.value = repositoryFor(task, item)?.root ?? "";
          throw error;
        }
      });
    });
    return picker;
  }

  function renderExperiments(task) {
    const choices = models.get(task.id);
    const entries = task.experiments.map((item) => {
      const card = cardFor(item);
      const workspaceAgents = card?.agents ?? [];
      const agent = item.launch && agentFor(item);
      return {
        item,
        card,
        agent,
        chatAgents: item.launch ? [agent].filter(Boolean) : workspaceAgents,
      };
    });
    const signature = JSON.stringify([
      task.id,
      task.done,
      task.mode,
      task.repositories,
      visible(),
      launches.has(task.id),
      planning.has(task.id),
      choices?.revision,
      $("task-model").value,
      entries,
      [...reportRequests],
      [...reportErrors],
    ]);
    if (signature === renderedExperiments) return;
    renderedExperiments = signature;
    const list = $("experiment-list");
    const expanded = new Set(
      [...list.querySelectorAll("details[open]")].map(
        (detail) => detail.closest("article").dataset.itemId,
      ),
    );
    const restoreFocus = preserveFocus(list);
    list.replaceChildren(
      ...entries.map((entry) => {
        const { item, card, agent } = entry;
        const row = element("article", "experiment");
        row.dataset.itemId = item.id;
        const heading = element("div", "experiment-heading");
        heading.append(
          element("h3", "", item.title),
          element("span", "task-status", experimentStatus(item, agent)),
        );
        row.append(heading);
        const root = repositoryFor(task, item)?.root;
        const repo = root ? taskRepositoryName(root) : "";
        const mode = item.launch ? item.launch.mode : task.mode;
        const chat = mode === "chat" || mode === "research";
        let context = "No repository";
        if (chat) context = repo ? `Chat · ${repo} reference` : "Chat";
        else if (repo) context = `${repo} · ${card?.branch || "New worktree"}`;
        row.append(element("p", "subtitle", context));
        const launchDetails = workerLaunchDetails(item, choices);
        if (launchDetails) row.append(launchDetails);
        const error = agent?.error || item.error;
        if (error) row.append(element("p", "warning", error));
        if (reportErrors.has(item.id))
          row.append(element("p", "subtitle", reportErrors.get(item.id)));
        const actions = workItemActions(task, entry);
        if (actions.childElementCount) row.append(actions);
        const details = element("details", "experiment-details");
        details.open = expanded.has(item.id);
        details.append(
          element("summary", "", "Work brief"),
          element("p", "experiment-hypothesis", item.hypothesis),
        );
        row.append(details);
        return row;
      }),
    );
    if (!entries.length) list.append(element("p", "task-work-empty", "No delegated work"));
    restoreFocus();
  }

  function renderTaskProperties(task, repositories) {
    const context = $("task-context");
    const repositorySignature = JSON.stringify(repositories);
    if (context.dataset.repositories !== repositorySignature) {
      context.dataset.repositories = repositorySignature;
      context.replaceChildren(
        ...repositories.map(({ root, base }) => {
          const repo = element("div", "task-repository-row");
          repo.title = `${root} @ ${base}`;
          repo.append(
            element("span", "", taskRepositoryName(root)),
            element("code", "", base.slice(0, 8)),
          );
          return repo;
        }),
      );
      if (!repositories.length) context.append(element("p", "subtitle", "No repository attached"));
    }
    const attachable = inventory.repositories.filter(
      ({ path }) => !repositories.some(({ root }) => root === path),
    );
    $("task-attach-details").hidden =
      task.done || Boolean(inventory.repositories.length && !attachable.length);
    $("task-repository-next").hidden =
      task.done || task.mode === "chat" || Boolean(repositories.length);
    options(
      $("task-attach-root"),
      attachable.map(({ path, name }) => ({
        id: path,
        label: `${name} — ${path}`,
      })),
      "Add another repository",
    );
    $("attach-task-repository").disabled =
      !attachable.length || busyControls.has($("attach-task-repository"));
    const sourceLink = $("task-source-chat");
    sourceLink.hidden = !task.source;
    if (task.source) sourceLink.href = sourceChat(task.source);
    else sourceLink.removeAttribute("href");
    showTaskStage(task);
  }

  function renderDetails({ fill = false } = {}) {
    const task = selected();
    const showingBoard = !creating && !task;
    const showingTask = !creating && Boolean(task);
    $("task-create").hidden = !creating;
    $("task-board").hidden = !showingBoard;
    $("task-content").hidden = showingBoard;
    $("task-board-back").hidden = !showingTask;
    $("task-view-title").hidden = showingTask;
    $("task-board-controls").hidden = !showingBoard;
    $("task-detail").hidden = !showingTask;
    if (!showingTask) return;
    $("task-title").textContent = task.title;
    $("task-brief").textContent = task.brief;
    renderReports(task);
    renderLabels(
      $("task-labels"),
      task.labels,
      async (labels) => {
        const updated = await api("tasks/save", { id: task.id, labels });
        tasks = tasks.map((entry) => (entry.id === updated.id ? updated : entry));
        renderList();
        renderDetails();
      },
      inventory.taskLabels?.[task.id],
    );
    const managed = task.experiments.filter((item) => item.launch);
    const reports = managed.filter((item) => item.reportSource === "agent").length;
    const progress = managed.length ? `${reports} of ${managed.length} agent reports ready` : "";
    if ($("task-progress").textContent !== progress) $("task-progress").textContent = progress;
    const repositories = repositoriesFor(task);
    renderTaskProperties(task, repositories);
    $("add-experiment").hidden = task.done;
    const form = $("task-edit");
    if (fill || !$("task-edit-details").open) {
      form.elements.title.defaultValue = form.elements.title.value = task.title;
      form.elements.brief.defaultValue = form.elements.brief.value = task.brief;
      form.elements.mode.value = task.mode ?? "chat";
    }
    renderWorkItemForm(task, repositories);
    const choice = models.get(task.id);
    const picker = $("task-model");
    const preferred = taskDefaults.get(task.id) ?? choice?.preferred;
    options(picker, choice?.models ?? [], "Choose a model", preferred);
    picker.value = choice?.models.some(({ id }) => id === preferred) ? preferred : "";
    showModelControls(task);
    renderExperiments(task);
    discoverModels(task);
  }

  function renderWorkItemForm(task, repositories) {
    const attached = new Set(task.experiments.map((item) => cardFor(item)?.path));
    options(
      $("experiment-repository"),
      repositories.map(({ root }) => ({ id: root, label: root })),
      "Choose a repository",
      task.root,
    );
    $("experiment-repository").disabled = !repositories.length;
    $("experiment-repository").required = Boolean(repositories.length);
    const available = inventory.cards.filter(
      (card) =>
        card.root === $("experiment-repository").value &&
        !card.unavailable &&
        !attached.has(card.path),
    );
    options(
      $("experiment-worktree"),
      available.map((card) => ({
        id: card.path,
        label: `${card.branch} — ${card.path}`,
      })),
      "Create a new worktree when launched",
    );
    $("experiment-worktree-field").hidden = task.mode === "chat";
    $("experiment-worktree").disabled = task.mode === "chat" || !$("experiment-repository").value;
  }

  function choose(id) {
    cancelDictation();
    if (selectedId !== id) {
      taskDetailView = tasks.find((task) => task.id === id)?.experiments.some((item) => item.report)
        ? "reports"
        : "work";
      reportWorkerId = undefined;
      $("task-report-brief").open = false;
    }
    selectedId = id;
    creating = false;
    $("task-idea").reset();
    $("add-experiment").open = false;
    $("task-attach-details").open = false;
    $("task-plan-details").open = false;
    delete $("task-plan-details").dataset.hasDrafts;
    $("task-edit-details").open = false;
    message("task-warning", "");
    renderList();
    renderDetails({ fill: true });
  }

  function updateRepositories() {
    const repositories = inventory.repositories.map(({ path, name }) => ({
      id: path,
      label: `${name} — ${path}`,
    }));
    options(
      $("task-repository"),
      repositories,
      "Attach later",
      !draft?.proposal && inventory.repositories.length === 1
        ? inventory.repositories[0].path
        : undefined,
    );
    $("task-no-repositories").hidden = Boolean(inventory.repositories.length);
    $("task-attach-hint").hidden = Boolean(inventory.repositories.length);
    $("create-task").disabled = busyControls.has($("create-task"));
  }

  async function load() {
    const version = ++request;
    try {
      const data = await api("tasks");
      if (version !== request) return;
      tasks = data.tasks;
      hasLoadedTasks = true;
      if (data.error) message("task-warning", data.error);
      renderList();
      renderDetails();
      reconcileReports();
      return true;
    } catch (error) {
      if (version === request) message("task-warning", error.message);
      return false;
    }
  }

  async function perform(control, action) {
    if (busyControls.has(control)) return;
    busyControls.add(control);
    control.disabled = true;
    message("task-warning", "");
    try {
      await action();
    } catch (error) {
      message("task-warning", error.message);
    } finally {
      busyControls.delete(control);
      control.disabled = false;
      updateRepositories();
      renderDetails();
    }
  }

  function reconcileReports() {
    if (reportRequests.size || inventory.daemonError) return;
    for (const task of tasks) {
      if (task.done && !task.completedByPullRequest) continue;
      const item = task.experiments.find((entry) => {
        if (!entry.launch || entry.reportSource || autoCollected.has(entry.id)) return false;
        const agent = agentFor(entry);
        return agent?.status === "idle" && !agent.needsInput;
      });
      if (item) {
        autoCollected.add(item.id);
        void collectReport(task, item);
        return;
      }
    }
  }

  async function collectReport(task, item) {
    if (reportRequests.has(item.id)) return;
    reportRequests.add(item.id);
    reportErrors.delete(item.id);
    if (visible()) renderDetails();
    try {
      await api("tasks/report", { id: task.id, experimentId: item.id });
      await load();
    } catch (error) {
      reportErrors.set(item.id, error.message);
    } finally {
      reportRequests.delete(item.id);
      if (visible()) renderDetails();
      reconcileReports();
    }
  }

  function renderProposal(proposal) {
    $("task-proposal-context").hidden = !proposal;
    const ideas = proposal?.experiments ?? [];
    $("task-proposal-experiments").hidden = !ideas.length;
    $("task-proposal-ideas").replaceChildren(
      ...ideas.map((idea, index) => {
        const label = element("label", "task-proposal-idea");
        const checkbox = element("input", "");
        checkbox.type = "checkbox";
        checkbox.name = "proposal-experiment";
        checkbox.value = String(index);
        checkbox.checked = true;
        const description = element("span", "task-proposal-description");
        description.append(element("strong", "", idea.title), element("span", "", idea.hypothesis));
        if (idea.provider)
          description.append(element("span", "experiment-model-label", idea.provider));
        label.append(checkbox, description);
        return label;
      }),
    );
    $("cancel-task").textContent = proposal ? "Keep in chat" : "Cancel";
  }

  function beginCreate(proposal) {
    const form = $("task-create");
    if (draft) {
      creating = true;
      renderDetails();
      if (proposal && draft.proposal?.id !== proposal.id) {
        message("task-warning", "Finish or cancel the open draft, then open this proposal again.");
      }
      form.elements.title.focus();
      return;
    }
    cancelDictation();
    creating = true;
    draft = { proposal, labels: [...(proposal?.labels ?? [])] };
    delete $("task-create-labels").dataset.labels;
    renderDraftLabels();
    form.reset();
    form.elements.mode.value = proposal?.mode ?? "chat";
    updateRepositories();
    const repo = $("task-repository");
    if (proposal) {
      const chat = sourceChat(proposal.source);
      const card = inventory.cards.find((entry) =>
        entry.agents.some((agent) => agent.chatUrl === chat),
      );
      repo.value = proposal.mode !== "worktree" ? "" : (card?.root ?? "");
      form.elements.title.value = proposal.title;
      form.elements.brief.value = proposal.brief;
    } else if (inventory.repositories.length === 1) {
      repo.value = inventory.repositories[0].path;
    }
    renderProposal(proposal);
    message("task-warning", "");
    renderList();
    renderDetails();
    if (proposal) {
      form.elements.brief.setSelectionRange(0, 0);
      form.elements.brief.scrollTop = 0;
    }
    form.elements.title.focus();
  }

  $("task-search").addEventListener("input", renderList);
  $("task-search").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !$("task-list").hidden)
      $("task-list").querySelector(".task-card-open")?.click();
  });
  $("task-attention").addEventListener("click", (event) => {
    const control = event.currentTarget;
    control.setAttribute("aria-pressed", String(control.getAttribute("aria-pressed") !== "true"));
    renderList();
  });
  for (const layout of ["board", "list"]) {
    $("tasks-as-" + layout).addEventListener("click", () => {
      $("task-list").dataset.layout = layout;
      $("tasks-as-board").setAttribute("aria-pressed", String(layout === "board"));
      $("tasks-as-list").setAttribute("aria-pressed", String(layout === "list"));
    });
  }
  $("task-open-attachment").addEventListener("click", () => {
    $("task-attach-details").open = true;
    $("task-attach-root").focus();
  });
  $("task-plan-details").addEventListener("toggle", () => {
    const task = selected();
    if (task) discoverModels(task);
  });
  $("new-task").addEventListener("click", () => beginCreate());
  $("task-board-back").addEventListener("click", () => {
    const previous = selectedId;
    choose(undefined);
    const card = $("task-list").querySelector(`[data-item-id="${previous}"] .task-card-open`);
    (card ?? $("task-search")).focus();
  });
  $("cancel-task").addEventListener("click", () => {
    const source = draft?.proposal?.source;
    draft = undefined;
    choose(selectedId);
    if (source) window.open(sourceChat(source), "_blank", "noopener");
  });

  $("task-create").addEventListener("submit", (event) => {
    event.preventDefault();
    cancelDictation();
    const submitted = draft;
    const proposalDraft = submitted.proposal;
    const data = new FormData(event.currentTarget);
    const proposal = proposalDraft && {
      id: proposalDraft.id,
      source: proposalDraft.source,
      experiments: (proposalDraft.experiments ?? []).filter((_, index) =>
        data.getAll("proposal-experiment").includes(String(index)),
      ),
    };
    void perform(event.submitter, async () => {
      const task = await api("tasks/create", {
        title: data.get("title"),
        brief: data.get("brief"),
        mode: data.get("mode"),
        labels: submitted.labels,
        root: $("task-repository").value || null,
        proposal,
      });
      tasks = [task, ...tasks.filter((item) => item.id !== task.id)];
      if (draft === submitted) {
        draft = undefined;
        if (creating && visible()) {
          choose(task.id);
          return;
        }
        creating = false;
      }
      renderList();
      renderDetails();
    });
  });

  $("task-attach-repository").addEventListener("submit", (event) => {
    event.preventDefault();
    const task = selected();
    void perform(event.submitter, async () => {
      const updated = await api("tasks/repository", {
        id: task.id,
        root: $("task-attach-root").value,
      });
      tasks = tasks.map((item) => (item.id === updated.id ? updated : item));
      if (selectedId === task.id && !creating) choose(task.id);
    });
  });

  $("task-edit").addEventListener("submit", (event) => {
    event.preventDefault();
    cancelDictation();
    const task = selected();
    const { title, brief, mode } = event.currentTarget.elements;
    const changes = {};
    if (title.value !== title.defaultValue) changes.title = title.value;
    if (brief.value !== brief.defaultValue) changes.brief = brief.value;
    if (mode.value !== (task.mode ?? "chat")) changes.mode = mode.value;
    if (!Object.keys(changes).length) return;
    void perform(event.submitter, async () => {
      const updated = await api("tasks/save", { id: task.id, ...changes });
      tasks = tasks.map((item) => (item.id === updated.id ? updated : item));
      if (changes.mode) {
        models.delete(task.id);
        modelErrors.delete(task.id);
      }
      if (selectedId === task.id && !creating) choose(task.id);
      else renderList();
    });
  });

  $("task-close").addEventListener("click", () => {
    const task = selected();
    void moveTask(task.id, task.done ? null : "done");
  });

  $("task-stage").addEventListener("change", (event) => {
    const task = selected();
    void moveTask(task.id, event.currentTarget.value || null);
  });

  for (const [buttonId, formId] of [
    ["dictate-create", "task-create"],
    ["dictate-edit", "task-edit"],
  ]) {
    const control = $(buttonId);
    control.addEventListener("click", () => void dictate(control, $(formId).elements.brief));
  }

  function cancelDictation() {
    dictation?.abort();
  }

  function insertTranscript(field, text, original, selection) {
    const [start, end] =
      field.value === original ? selection : [field.value.length, field.value.length];
    const prefix = field.value.slice(0, start);
    const suffix = field.value.slice(end);
    const leading = prefix && !/\s$/.test(prefix) ? " " : "";
    const trailing = suffix && !/^\s/.test(suffix) ? " " : "";
    const insertion = leading + text + trailing;
    if (prefix.length + suffix.length + insertion.length > field.maxLength) {
      throw new Error("The transcript won’t fit in the brief. Try a shorter recording.");
    }
    field.setRangeText(insertion, start, end, "end");
    field.focus();
  }

  async function dictate(control, field) {
    if (dictation) return;
    const controller = new AbortController();
    dictation = controller;
    const original = field.value;
    const selection = [field.selectionStart, field.selectionEnd];
    try {
      await perform(control, async () => {
        const { left, width, bottom } = field.getBoundingClientRect();
        const { text } = await api(
          "dictation",
          { x: left + width / 2, y: bottom },
          controller.signal,
        ).catch((error) => {
          if (controller.signal.aborted) return {};
          throw error;
        });
        if (text && !controller.signal.aborted) insertTranscript(field, text, original, selection);
      });
    } finally {
      dictation = undefined;
    }
  }

  $("task-edit-details").addEventListener("toggle", () => {
    if ($("task-edit-details").open) return;
    if (busyControls.has($("dictate-edit"))) cancelDictation();
    renderDetails();
  });

  $("task-idea").addEventListener("submit", (event) => {
    event.preventDefault();
    const task = selected();
    const form = event.currentTarget;
    const data = new FormData(form);
    void perform(event.submitter, async () => {
      await api("tasks/experiment", {
        id: task.id,
        ...Object.fromEntries(data),
        root: $("experiment-repository").value || undefined,
        path: $("experiment-worktree").disabled
          ? undefined
          : $("experiment-worktree").value || undefined,
      });
      if (selectedId === task.id && !creating) {
        form.reset();
        $("add-experiment").open = false;
      }
      await load();
    });
  });
  $("experiment-repository").addEventListener("change", () => {
    $("experiment-worktree").value = "";
    renderDetails();
  });

  async function loadModels(task) {
    if (task.done || (!task.root && task.mode !== "chat") || modelRequests.has(task.id)) return;
    modelRequests.add(task.id);
    modelErrors.delete(task.id);
    showModelControls(task);
    try {
      const catalog = await api("tasks/models", { id: task.id });
      models.set(task.id, { ...catalog, revision: ++modelRevision });
    } catch (error) {
      modelErrors.set(task.id, error.message);
    } finally {
      modelRequests.delete(task.id);
      renderDetails();
    }
  }

  $("task-models").addEventListener("click", () => {
    const task = selected();
    if (task) void loadModels(task);
  });
  $("task-model").addEventListener("change", () => {
    const task = selected();
    if (!task) return;
    taskDefaults.set(task.id, $("task-model").value);
    showModelControls(task);
    renderExperiments(task);
  });
  $("suggest-experiments").addEventListener("click", () => {
    const task = selected();
    const model = $("task-model").value;
    if (planning.has(task.id) || launches.has(task.id)) return;
    planning.add(task.id);
    renderDetails();
    void (async () => {
      message("task-warning", "");
      try {
        await api("tasks/suggest", { id: task.id, model });
        await load();
      } catch (error) {
        if (selectedId === task.id) message("task-warning", error.message);
      } finally {
        planning.delete(task.id);
        renderDetails();
      }
    })();
  });
  $("task-run").addEventListener("submit", (event) => {
    event.preventDefault();
    const task = selected();
    const model = $("task-model").value;
    if (launches.has(task.id) || planning.has(task.id)) return;
    launches.add(task.id);
    renderDetails();
    void (async () => {
      message("task-warning", "");
      try {
        await api("tasks/run", { id: task.id, model: model || undefined });
        await Promise.all([load(), refreshBoard()]);
      } catch (error) {
        if (selectedId === task.id) message("task-warning", error.message);
        await load();
      } finally {
        launches.delete(task.id);
        renderDetails();
      }
    })();
  });

  return {
    load,
    cancelDictation,
    showBoard() {
      choose(undefined);
    },
    openTask(id) {
      if (tasks.some((task) => task.id === id)) choose(id);
      else {
        choose(undefined);
        message("task-warning", "This task is unavailable on this host.");
      }
    },
    openProposal(proposal) {
      if (tasks.some((task) => task.id === proposal.id)) choose(proposal.id);
      else beginCreate(proposal);
    },
    openDraft({ title = "", brief = "" }) {
      beginCreate();
      if (!title && !brief) return;
      const form = $("task-create");
      if (draft.proposal || form.elements.title.value || form.elements.brief.value) {
        message("task-warning", "Finish or cancel the open draft before dictating another task.");
        return;
      }
      form.elements.title.value = title;
      form.elements.brief.value = brief;
    },
    baseForWorktree(card) {
      function base(task) {
        const item = task?.experiments.find((entry) => cardFor(entry)?.path === card.path);
        return item ? repositoryFor(task, item)?.base : undefined;
      }
      const pinned = base(selected());
      if (pinned) return pinned;
      const otherBases = new Set(tasks.map(base).filter(Boolean));
      return otherBases.size === 1 ? otherBases.values().next().value : "";
    },
    setBoard(data) {
      inventory = data;
      agentsById = new Map(
        [...data.cards.flatMap((card) => card.agents), ...data.otherAgents].map((agent) => [
          agent.id,
          agent,
        ]),
      );
      if (creating) renderDraftLabels();
      cardsByWorkspace = new Map(
        data.cards.filter((card) => card.workspaceId).map((card) => [card.workspaceId, card]),
      );
      cardsByPath = new Map(data.cards.map((card) => [card.path, card]));
      renderList();
      $("dictate-create").hidden = !data.native;
      $("dictate-edit").hidden = !data.native;
      updateRepositories();
      if (visible()) renderDetails();
      reconcileReports();
    },
  };
}
