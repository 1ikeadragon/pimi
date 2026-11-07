// Pimi addition to the Paseo fork. Apache-2.0.
export function createTasksView({
  $,
  api,
  button,
  element,
  message,
  agentChatLinks,
  openReview,
  compareReview,
  refreshBoard,
}) {
  let tasks = [];
  let inventory = { cards: [], repositories: [] };
  let selectedId;
  let renderedExperiments;
  let renderedList;
  let creating = false;
  let proposalDraft;
  let request = 0;
  const models = new Map();
  const modelRequests = new Set();
  const launches = new Set();
  const planning = new Set();
  const reportRequests = new Set();
  const reportErrors = new Map();
  const autoCollected = new Set();
  const busyControls = new Set();

  const selected = () => tasks.find((task) => task.id === selectedId);
  const visible = () => !$("tasks").hidden;
  const drafts = (task) => task.experiments.filter((item) => !item.path && !item.report);
  const repositoriesFor = (task) =>
    task.repositories ?? (task.root ? [{ root: task.root, base: task.base }] : []);
  const repositoryFor = (task, item) =>
    repositoriesFor(task).find(({ root }) => root === (item.root ?? task.root));

  function sourceChat({ serverId, agentId }) {
    return `paseo://h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(agentId)}`;
  }

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
    if (reportRequests.has(item.id)) return "Getting report…";
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
      return "Ready to review";
    if (task.experiments.some((item) => item.launch || item.path || item.report))
      return "In progress";
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
    $("task-run").hidden = task.done || !task.root;
    $("task-model").disabled = active || !choices?.models.length;
    $("task-models").disabled = active || modelRequests.has(task.id);
    let modelButtonText = choices ? "Refresh models" : "Load models";
    if (modelRequests.has(task.id)) modelButtonText = "Loading…";
    $("task-models").textContent = modelButtonText;
    const modelChosen = Boolean($("task-model").value && choices?.models.length);
    $("run-task").disabled = active || !modelChosen || !pending.length;
    $("suggest-experiments").disabled = active || !modelChosen || task.experiments.length > 6;
    $("run-task").textContent = pending.length > 4 ? "Start next 4" : "Start agents";
    let note = "Pimi starts one agent per draft. Finished agents report here.";
    if (planning.has(task.id)) note = "Drafting two work items from the brief…";
    else if (active) note = "Checking the model and starting worktrees…";
    else if (choices?.models.length === 0) note = "No ready models. Check Agent Console settings.";
    $("task-run-note").textContent = note;
  }

  function reportContent(item) {
    const report = element("div", "experiment-report");
    report.append(
      element("h4", "", item.reportSource === "agent" ? "Agent report" : "Saved report"),
      element("p", "", item.report),
    );
    if (item.reportTruncated) {
      report.append(
        element("p", "subtitle", "Report shortened. See Agent Console for the full response."),
      );
    }
    return report;
  }

  function workItemActions(task, { item, card, agent, chatAgents }) {
    const actions = element("div", "experiment-actions");
    actions.append(...agentChatLinks(chatAgents));
    if (card && !card.unavailable) {
      const base = repositoryFor(task, item)?.base || "";
      actions.append(
        button("button secondary", "Review changes", () => openReview(card, base)),
        button("button quiet", "Compare alongside", () => compareReview(card, base)),
      );
    }
    if (task.done) return actions;
    if (!item.launch && !item.path && !item.report) {
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
    if (item.launch && !item.report && reportErrors.has(item.id)) {
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

  function workItemRepositoryPicker(task, item, repositories) {
    const picker = element("select", "work-item-repository");
    picker.setAttribute("aria-label", `Repository for ${item.title}`);
    picker.replaceChildren(
      ...repositories.map(({ root }) => new Option(root.split("/").at(-1), root)),
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
      task.repositories,
      visible(),
      launches.has(task.id),
      planning.has(task.id),
      entries,
      [...reportRequests],
      [...reportErrors],
    ]);
    if (signature === renderedExperiments) return;
    renderedExperiments = signature;
    $("experiment-list").replaceChildren(
      ...entries.map((entry) => {
        const { item, card, agent } = entry;
        const row = element("article", "experiment");
        const heading = element("div", "experiment-heading");
        heading.append(
          element("h3", "", item.title),
          element("span", "task-status", experimentStatus(item, agent)),
        );
        row.append(heading, element("p", "experiment-hypothesis", item.hypothesis));
        const root = repositoryFor(task, item)?.root;
        row.append(
          element(
            "p",
            "subtitle",
            root
              ? `${root.split("/").at(-1)} · ${card?.branch || "New worktree"}`
              : "No repository",
          ),
        );
        const error = agent?.error || item.error;
        if (error) row.append(element("p", "warning", error));
        if (item.report) row.append(reportContent(item));
        if (reportErrors.has(item.id))
          row.append(element("p", "subtitle", reportErrors.get(item.id)));
        const actions = workItemActions(task, entry);
        if (actions.childElementCount) row.append(actions);
        return row;
      }),
    );
    if (!entries.length)
      $("experiment-list").append(
        element("p", "subtitle", "Add a work item or link an existing worktree."),
      );
  }

  function renderDetails({ fill = false } = {}) {
    const task = selected();
    $("task-create").hidden = !creating;
    $("task-empty").hidden = creating || Boolean(task);
    $("task-detail").hidden = creating || !task;
    if (creating || !task) return;
    $("task-title").textContent = task.title;
    $("task-brief").textContent = task.brief;
    const managed = task.experiments.filter((item) => item.launch);
    const reports = managed.filter((item) => item.reportSource === "agent").length;
    const progress = managed.length ? `${reports} of ${managed.length} agent reports ready` : "";
    if ($("task-progress").textContent !== progress) $("task-progress").textContent = progress;
    const repositories = repositoriesFor(task);
    $("task-context").textContent = repositories.length
      ? repositories
          .map(({ root, base }) => `${root.split("/").at(-1)} · base ${base.slice(0, 8)}`)
          .join(" | ")
      : "No repository attached";
    $("task-context").title = repositories.map(({ root, base }) => `${root} @ ${base}`).join("\n");
    $("task-attach-repository").hidden = task.done;
    options(
      $("task-attach-root"),
      inventory.repositories
        .filter(({ path }) => !repositories.some(({ root }) => root === path))
        .map(({ path, name }) => ({ id: path, label: `${name} — ${path}` })),
      "Add another repository",
    );
    const sourceLink = $("task-source-chat");
    sourceLink.hidden = !task.source;
    if (task.source) sourceLink.href = sourceChat(task.source);
    else sourceLink.removeAttribute("href");
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
    $("experiment-worktree").disabled = !$("experiment-repository").value;
    const choice = models.get(task.id);
    const original = drafts(task).find((item) => item.launch)?.launch.config.provider;
    options($("task-model"), choice?.models ?? [], "Choose a model", original ?? choice?.preferred);
    showModelControls(task);
    renderExperiments(task);
  }

  function choose(id) {
    selectedId = id;
    creating = false;
    proposalDraft = undefined;
    $("task-idea").reset();
    $("add-experiment").open = false;
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
      !proposalDraft && inventory.repositories.length === 1
        ? inventory.repositories[0].path
        : undefined,
    );
    options($("task-attach-root"), repositories, "Choose a repository");
    $("task-no-repositories").hidden = Boolean(inventory.repositories.length);
    $("task-attach-hint").hidden = Boolean(inventory.repositories.length);
    $("attach-task-repository").disabled =
      !inventory.repositories.length || busyControls.has($("attach-task-repository"));
    $("create-task").disabled = busyControls.has($("create-task"));
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
      reconcileReports();
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

  function reconcileReports() {
    if (reportRequests.size) return;
    for (const task of tasks) {
      if (task.done) continue;
      const item = task.experiments.find((entry) => {
        if (!entry.launch || entry.reportSource || autoCollected.has(entry.id)) return false;
        return cardFor(entry)?.agents.some(
          (agent) => agent.id === entry.id && agent.status === "idle" && !agent.needsInput,
        );
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
        label.append(checkbox, description);
        return label;
      }),
    );
    $("cancel-task").textContent = proposal ? "Keep in chat" : "Cancel";
  }

  function beginCreate(proposal) {
    const form = $("task-create");
    if (proposal && creating && (form.elements.title.value || form.elements.brief.value)) {
      if (proposalDraft?.id !== proposal.id) {
        message("task-warning", "Finish or cancel the open draft, then open this proposal again.");
      }
      return;
    }
    creating = true;
    proposalDraft = proposal;
    form.reset();
    updateRepositories();
    const repo = $("task-repository");
    if (proposal) {
      const chat = sourceChat(proposal.source);
      const card = inventory.cards.find((entry) =>
        entry.agents.some((agent) => agent.chatUrl === chat),
      );
      repo.value = card?.root ?? "";
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
  $("new-task").addEventListener("click", () => beginCreate());
  $("cancel-task").addEventListener("click", () => {
    const source = proposalDraft?.source;
    choose(selectedId ?? tasks[0]?.id);
    if (source) window.open(sourceChat(source), "_blank", "noopener");
  });

  $("task-create").addEventListener("submit", (event) => {
    event.preventDefault();
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
        root: $("task-repository").value || null,
        proposal,
      });
      tasks = [task, ...tasks.filter((item) => item.id !== task.id)];
      choose(task.id);
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
        root: $("experiment-repository").value || undefined,
        path: $("experiment-worktree").value || undefined,
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

  return {
    load,
    openProposal(proposal) {
      if (tasks.some((task) => task.id === proposal.id)) choose(proposal.id);
      else beginCreate(proposal);
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
      $("dictate-create").hidden = !data.native;
      $("dictate-edit").hidden = !data.native;
      updateRepositories();
      if (visible()) renderDetails();
      reconcileReports();
    },
  };
}
