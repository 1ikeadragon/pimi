// Pimi addition to the Paseo fork. Apache-2.0.
export function createTasksView({
  $,
  api,
  button,
  element,
  message,
  agentChatLinks,
  openReview,
  refreshBoard,
}) {
  let tasks = [];
  let inventory = { cards: [], repositories: [] };
  let selectedId;
  let editorId;
  let renderedExperiments;
  let renderedList;
  let creating = false;
  let request = 0;
  const models = new Map();
  const modelRequests = new Set();
  const launches = new Set();
  const planning = new Set();
  const reportRequests = new Set();
  const autoCollected = new Set();
  const busyControls = new Set();

  const selected = () => tasks.find((task) => task.id === selectedId);
  const visible = () => !$("tasks").hidden;
  const drafts = (task) => task.experiments.filter((item) => !item.path && !item.report);

  function cardFor(experiment) {
    const workspace =
      experiment.workspaceId &&
      inventory.cards.find((card) => card.workspaceId === experiment.workspaceId);
    return (
      workspace ||
      inventory.cards.find(
        (card) =>
          experiment.path &&
          card.path === experiment.path &&
          (!experiment.workspaceId || !card.workspaceId),
      )
    );
  }

  function experimentStatus(item, agent) {
    if (item.report) return "Report ready";
    if (agent?.needsInput) return "Needs approval";
    if (agent?.status === "error" || item.error) return "Needs attention";
    if (["running", "initializing"].includes(agent?.status)) return "Running";
    if (agent?.status === "idle") return "Agent finished";
    if (item.path) return "Linked worktree";
    return item.launch ? "Launch pending" : "Draft";
  }

  function status(task) {
    if (task.done) return "Closed";
    if (task.experiments.length && task.experiments.every((item) => item.report))
      return "Ready to decide";
    if (task.experiments.some((item) => item.launch || item.path || item.report))
      return "Exploring";
    return "Draft";
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

  function renderList() {
    const query = $("task-search").value.trim().toLowerCase();
    const visibleTasks = tasks.filter((task) =>
      `${task.title} ${task.brief}`.toLowerCase().includes(query),
    );
    const signature = JSON.stringify([
      query,
      selectedId,
      creating,
      visibleTasks.map((task) => [task.id, task.title, status(task)]),
    ]);
    if (signature === renderedList) return;
    renderedList = signature;
    $("task-list").replaceChildren(
      ...visibleTasks.map((task) => {
        const row = button("task-row", "", () => choose(task.id));
        row.setAttribute("aria-pressed", String(!creating && task.id === selectedId));
        row.append(element("strong", "", task.title), element("span", "", status(task)));
        return row;
      }),
      ...(!visibleTasks.length
        ? [element("p", "empty", query ? "No matching tasks." : "No tasks yet.")]
        : []),
    );
  }

  function showModelControls(task) {
    const pending = drafts(task);
    const choices = models.get(task.id);
    const active = launches.has(task.id) || planning.has(task.id);
    $("task-run").hidden = task.done;
    $("task-model").disabled = active || !choices?.models.length;
    $("task-models").disabled = active || modelRequests.has(task.id);
    let modelButtonText = choices ? "Refresh models" : "Load models";
    if (modelRequests.has(task.id)) modelButtonText = "Loading…";
    $("task-models").textContent = modelButtonText;
    const modelChosen = Boolean($("task-model").value && choices?.models.length);
    $("run-task").disabled = active || !modelChosen || !pending.length;
    $("suggest-experiments").disabled = active || !modelChosen || task.experiments.length > 6;
    $("run-task").textContent = pending.length > 4 ? "Run next 4" : "Run experiments";
    let note = "Pimi checks the model first, then starts one agent per experiment.";
    if (planning.has(task.id)) note = "Drafting two experiments from the brief…";
    else if (active) note = "Checking the model and starting worktrees…";
    else if (choices?.models.length === 0) note = "No ready models. Check Agent Console settings.";
    $("task-run-note").textContent = note;
  }

  function reportContent(item) {
    const report = element("div", "experiment-report");
    report.append(
      element("h4", "", item.reportSource === "agent" ? "Agent report" : "Report"),
      element("p", "", item.report),
    );
    if (item.reportTruncated) {
      report.append(
        element("p", "subtitle", "Report shortened. See Agent Console for the full response."),
      );
    }
    return report;
  }

  function renderExperiments(task) {
    const entries = task.experiments.map((item) => {
      const card = cardFor(item);
      const workspaceAgents = card?.agents ?? [];
      const workers = item.launch ? workspaceAgents.filter((agent) => agent.id === item.id) : [];
      return {
        item,
        card,
        agent: workers[0],
        chatAgents: item.launch ? workers : workspaceAgents,
      };
    });
    const signature = JSON.stringify([
      task.id,
      task.done,
      visible(),
      launches.has(task.id),
      planning.has(task.id),
      entries,
      [...reportRequests],
    ]);
    if (signature === renderedExperiments) return;
    renderedExperiments = signature;
    $("experiment-list").replaceChildren(
      ...entries.map(({ item, card, agent, chatAgents }) => {
        const row = element("article", "experiment");
        const heading = element("div", "experiment-heading");
        heading.append(
          element("h3", "", item.title),
          element("span", "task-status", experimentStatus(item, agent)),
        );
        row.append(heading, element("p", "experiment-hypothesis", item.hypothesis));
        if (card) row.append(element("p", "subtitle", card.branch));
        const error = agent?.error || item.error;
        if (error) row.append(element("p", "warning", error));
        if (item.report) row.append(reportContent(item));
        const actions = element("div", "experiment-actions");
        actions.append(...agentChatLinks(chatAgents));
        if (card && !card.unavailable) {
          actions.append(
            button("button secondary", "Review changes", () => openReview(card, task.base)),
          );
        }
        if (!task.done) {
          if (!item.launch && !item.path && !item.report) {
            const discard = button("button secondary", "Discard draft", () => {
              void perform(discard, async () => {
                await api("tasks/discard", { id: task.id, experimentId: item.id });
                await load();
              });
            });
            discard.disabled = launches.has(task.id) || planning.has(task.id);
            actions.append(discard);
          }
          if (item.launch && !item.report) {
            const collect = button(
              "button secondary",
              "Collect report",
              () => void collectReport(task, item),
            );
            collect.disabled =
              reportRequests.has(item.id) || ["initializing", "running"].includes(agent?.status);
            actions.append(collect);
          }
          actions.append(
            button("button secondary", item.report ? "Edit report" : "Add report", () => {
              editorId = item.id;
              $("report-editor-label").firstChild.textContent = `Report for ${item.title}`;
              $("task-report-text").value = item.report;
              $("task-report-editor").hidden = false;
              $("task-report-text").focus();
            }),
          );
        }
        if (actions.childElementCount) row.append(actions);
        return row;
      }),
    );
    if (!entries.length)
      $("experiment-list").append(
        element("p", "subtitle", "Add a hypothesis or link an existing worktree."),
      );

    if (visible() && !task.done && !reportRequests.size) {
      // Collect a finished worker's report once per view session. Manual collection can retry.
      const next = entries.find(
        ({ item, agent }) =>
          !item.reportSource &&
          agent?.status === "idle" &&
          !agent.needsInput &&
          !autoCollected.has(item.id) &&
          !reportRequests.has(item.id),
      );
      if (next) {
        autoCollected.add(next.item.id);
        void collectReport(task, next.item, { quiet: true });
      }
    }
  }

  function renderDetails({ fill = false } = {}) {
    const task = selected();
    $("task-create").hidden = !creating;
    $("task-empty").hidden = creating || Boolean(task);
    $("task-detail").hidden = creating || !task;
    if (creating || !task) return;
    $("task-title").textContent = task.title;
    $("task-brief").textContent = task.brief;
    $("task-context").textContent =
      `${task.root.split("/").at(-1)} · base ${task.base.slice(0, 8)}`;
    $("task-status").textContent = status(task);
    $("task-close").textContent = task.done ? "Reopen task" : "Close task";
    $("task-close").disabled = launches.has(task.id) || planning.has(task.id);
    $("add-experiment").hidden = task.done;
    const form = $("task-edit");
    if (fill) {
      form.elements.title.value = task.title;
      form.elements.brief.value = task.brief;
    }
    const attached = new Set(task.experiments.map((item) => cardFor(item)?.path));
    const available = inventory.cards.filter(
      (card) => card.root === task.root && !card.unavailable && !attached.has(card.path),
    );
    options(
      $("experiment-worktree"),
      available.map((card) => ({
        id: card.path,
        label: card.branch,
      })),
      "Create a new worktree when launched",
    );
    const choice = models.get(task.id);
    const original = drafts(task).find((item) => item.launch)?.launch.config.provider;
    options($("task-model"), choice?.models ?? [], "Choose a model", original ?? choice?.preferred);
    showModelControls(task);
    renderExperiments(task);
  }

  function closeReportEditor() {
    editorId = undefined;
    $("task-report-editor").hidden = true;
  }

  function choose(id) {
    selectedId = id;
    creating = false;
    closeReportEditor();
    $("task-idea").reset();
    $("add-experiment").open = false;
    $("task-edit-details").open = false;
    message("task-warning", "");
    renderList();
    renderDetails({ fill: true });
  }

  function updateRepositories() {
    options(
      $("task-repository"),
      inventory.repositories.map(({ path, name }) => ({
        id: path,
        label: `${name} — ${path}`,
      })),
      "Choose a repository",
      inventory.repositories.length === 1 ? inventory.repositories[0].path : undefined,
    );
    $("task-no-repositories").hidden = Boolean(inventory.repositories.length);
    $("create-task").disabled =
      !inventory.repositories.length || busyControls.has($("create-task"));
  }

  async function load() {
    const version = ++request;
    try {
      const data = await api("tasks");
      if (version !== request) return;
      tasks = data.tasks;
      if (data.error) message("task-warning", data.error);
      if (!selectedId && tasks.length && !creating) choose(tasks[0].id);
      else {
        renderList();
        renderDetails();
      }
    } catch (error) {
      if (version === request) message("task-warning", error.message);
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

  async function collectReport(task, item, { quiet = false } = {}) {
    if (reportRequests.has(item.id)) return;
    reportRequests.add(item.id);
    try {
      await api("tasks/report", { id: task.id, experimentId: item.id });
      await load();
    } catch (error) {
      if (!quiet && selectedId === task.id) message("task-warning", error.message);
    } finally {
      reportRequests.delete(item.id);
      renderDetails();
    }
  }

  $("task-search").addEventListener("input", renderList);
  $("new-task").addEventListener("click", () => {
    creating = true;
    closeReportEditor();
    $("task-create").reset();
    const repo = $("task-repository");
    if (inventory.repositories.length === 1) repo.value = inventory.repositories[0].path;
    message("task-warning", "");
    renderList();
    renderDetails();
    (inventory.repositories.length === 1 ? $("task-create").elements.title : repo).focus();
  });
  $("cancel-task").addEventListener("click", () => choose(selectedId ?? tasks[0]?.id));

  $("task-create").addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void perform(event.submitter, async () => {
      const task = await api("tasks/create", {
        title: data.get("title"),
        brief: data.get("brief"),
        root: $("task-repository").value,
      });
      tasks = [task, ...tasks];
      choose(task.id);
    });
  });

  $("task-edit").addEventListener("submit", (event) => {
    event.preventDefault();
    const task = selected();
    const data = new FormData(event.currentTarget);
    void saveTask(event.submitter, task, Object.fromEntries(data), task.done);
  });

  $("task-close").addEventListener("click", (event) => {
    const task = selected();
    void saveTask(event.currentTarget, task, { title: task.title, brief: task.brief }, !task.done);
  });

  function saveTask(control, task, changes, done) {
    return perform(control, async () => {
      const updated = await api("tasks/save", { id: task.id, ...changes, done });
      tasks = tasks.map((item) => (item.id === updated.id ? updated : item));
      if (selectedId === task.id && !creating) choose(task.id);
      else renderList();
    });
  }

  for (const [buttonId, formId] of [
    ["dictate-create", "task-create"],
    ["dictate-edit", "task-edit"],
  ]) {
    const control = $(buttonId);
    control.addEventListener("click", () => {
      const field = $(formId).elements.brief;
      const start = field.selectionStart ?? field.value.length;
      const end = field.selectionEnd ?? start;
      void perform(control, async () => {
        const { text } = await api("dictation", {});
        if (!text) return;
        const prefix = field.value.slice(0, start);
        const suffix = field.value.slice(end);
        const leading = prefix && !/\s$/.test(prefix) ? " " : "";
        const trailing = suffix && !/^\s/.test(suffix) ? " " : "";
        const insertion = leading + text + trailing;
        if (prefix.length + suffix.length + insertion.length > field.maxLength) {
          throw new Error(
            "That transcript is longer than the space left in the brief. Shorten the brief or try a shorter recording.",
          );
        }
        field.setRangeText(insertion, start, end, "end");
        field.focus();
      });
    });
  }

  $("task-idea").addEventListener("submit", (event) => {
    event.preventDefault();
    const task = selected();
    const form = event.currentTarget;
    const data = new FormData(form);
    void perform(event.submitter, async () => {
      await api("tasks/experiment", {
        id: task.id,
        ...Object.fromEntries(data),
        path: $("experiment-worktree").value || undefined,
      });
      if (selectedId === task.id && !creating) {
        form.reset();
        $("add-experiment").open = false;
      }
      await load();
    });
  });

  $("task-models").addEventListener("click", () => {
    const task = selected();
    modelRequests.add(task.id);
    showModelControls(task);
    void (async () => {
      try {
        models.set(task.id, await api("tasks/models", { id: task.id }));
      } catch (error) {
        if (selectedId === task.id) message("task-warning", error.message);
      } finally {
        modelRequests.delete(task.id);
        renderDetails();
      }
    })();
  });
  $("task-model").addEventListener("change", () => showModelControls(selected()));
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
        await api("tasks/run", { id: task.id, model });
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
  $("cancel-report").addEventListener("click", closeReportEditor);
  $("task-report-editor").addEventListener("submit", (event) => {
    event.preventDefault();
    const task = selected();
    const experimentId = editorId;
    void perform(event.submitter, async () => {
      await api("tasks/report", { id: task.id, experimentId, text: $("task-report-text").value });
      if (editorId === experimentId) closeReportEditor();
      await load();
    });
  });

  return {
    load,
    setBoard(data) {
      inventory = data;
      $("dictate-create").hidden = !data.native;
      $("dictate-edit").hidden = !data.native;
      updateRepositories();
      if (visible()) renderDetails();
    },
  };
}
