// Pimi. PolyForm-Noncommercial-1.0.0.
export function createMemoryView({ $, api, button, element, message }) {
  const picker = $("memory-scope");
  const form = $("memory-form");
  const dialog = $("memory-forget-dialog");
  const placeholder = $("memory-placeholder");
  const noteCount = $("memory-note-count");
  const content = $("memory-content");
  const keyInput = form.elements.key;
  const textInput = form.elements.text;
  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
  let projects = [];
  let notes = [];
  let projectId = null;
  let current;
  let loadedScope = null;
  let renderedNotes = null;
  let renderedScopes = null;
  let busy = false;
  let mutating = false;

  function projectName() {
    return projects.find(({ id }) => id === projectId)?.name || "This project";
  }

  function scopeLabel() {
    return projectId ? projectName() : "Across projects";
  }

  function hasChanges() {
    return (
      !form.hidden &&
      (keyInput.value !== (current?.key ?? "") || textInput.value !== (current?.text ?? ""))
    );
  }

  function canChangeView() {
    if (!hasChanges()) return true;
    message("memory-warning", "Save or cancel your changes before switching notes.");
    return false;
  }

  // A background run only fetches. It leaves the header, New note and the editor usable, so the
  // chrome does not wait for the host. Controls that depend on the data are guarded by `busy` and
  // only look disabled when the fetch outlasts BUSY_LOOK_DELAY_MS, so a quick refresh never dims
  // them for a frame.
  const BUSY_LOOK_DELAY_MS = 150;
  let busyLookTimer;

  function applyDisabled() {
    for (const control of [picker, $("memory-forget"), $("memory-save")]) control.disabled = busy;
    for (const control of [$("memory-new"), $("memory-reload"), $("memory-cancel"), textInput])
      control.disabled = mutating;
    keyInput.disabled = mutating || Boolean(current);
  }

  function setBusy(value, background) {
    busy = value;
    mutating = value && !background;
    clearTimeout(busyLookTimer);
    if (value && background) busyLookTimer = setTimeout(applyDisabled, BUSY_LOOK_DELAY_MS);
    else applyDisabled();
  }

  async function run(action, { background = false } = {}) {
    if (busy) return;
    setBusy(true, background);
    message("memory-warning", "");
    message("memory-status", "");
    try {
      await action();
    } catch (error) {
      message("memory-warning", error.message);
    } finally {
      setBusy(false);
    }
  }

  function showEditor(note) {
    current = note ?? undefined;
    form.hidden = note === null;
    placeholder.hidden = !form.hidden;
    $("memory-note-heading").textContent = current?.key || "New note";
    $("memory-note-scope").textContent = current
      ? scopeLabel() + " · " + dateFormat.format(new Date(current.updatedAt))
      : scopeLabel();
    $("memory-key-field").hidden = Boolean(current);
    keyInput.value = current?.key ?? "";
    keyInput.disabled = mutating || Boolean(current);
    textInput.value = current?.text ?? "";
    $("memory-forget").hidden = !current;
    for (const row of $("memory-notes").children) {
      row.setAttribute("aria-pressed", String(row.dataset.key === current?.key));
    }
  }

  function renderNotes() {
    const rows = notes.toSorted(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.key.localeCompare(b.key),
    );
    const signature = JSON.stringify(rows.map(({ key, updatedAt }) => [key, updatedAt]));
    // Rows for unchanged notes stay in place, so reopening keeps scroll position, hover and focus.
    if (signature !== renderedNotes) {
      renderedNotes = signature;
      $("memory-notes").replaceChildren(
        ...rows.map(({ key, updatedAt }) => {
          const row = button("memory-note", "", () => {
            if (!canChangeView()) return;
            void run(async () => {
              const { note } = await api("memory", { action: "read", projectId, key });
              showEditor(note);
            });
          });
          row.dataset.key = key;
          row.setAttribute("aria-pressed", String(current?.key === key));
          row.append(
            element("strong", "", key),
            element("span", "subtitle", dateFormat.format(new Date(updatedAt))),
          );
          return row;
        }),
      );
    }
    noteCount.textContent = String(rows.length);
    message("memory-empty", rows.length ? "" : "No notes saved in this scope.");
    content.removeAttribute("data-loading");
    placeholder.querySelector("h2").textContent = rows.length ? "Choose a note" : "No notes yet";
    placeholder.querySelector("p").textContent = rows.length
      ? "Open a saved note to read or edit it."
      : "Add a note you want your agents to remember.";
  }

  // The scope changed (or this is the first load): the old list no longer applies, so clear it
  // and let the empty state wait until the new list says whether it is empty.
  function resetScope() {
    notes = [];
    renderedNotes = null;
    showEditor(null);
    $("memory-notes").replaceChildren();
    noteCount.textContent = "";
    message("memory-empty", "");
    content.dataset.loading = "";
  }

  async function loadScope() {
    const selected = projects.find(({ id }) => id === projectId);
    let caption = "Shared across projects on this host.";
    if (selected) {
      caption = selected.archived
        ? "Archived project on this host."
        : "Shared with this project’s worktrees.";
    }
    $("memory-scope-caption").textContent = caption;
    ({ notes } = await api("memory", { action: "list", projectId }));
    renderNotes();
  }

  async function load(preferredProjectId) {
    if (hasChanges()) {
      if (preferredProjectId !== undefined) canChangeView();
      return;
    }
    await run(
      async () => {
        const previousScope = loadedScope;
        ({ projects } = await api("memory", { action: "catalog" }));
        projects.sort((a, b) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root));
        if (preferredProjectId !== undefined) {
          if (!projects.some(({ id }) => id === preferredProjectId)) {
            throw new Error("This project is no longer registered on this host.");
          }
          projectId = preferredProjectId;
        }
        if (!projects.some(({ id }) => id === projectId)) projectId = null;
        const nameCounts = new Map();
        for (const { name } of projects) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
        const scopes = JSON.stringify([projects, [...nameCounts]]);
        if (scopes !== renderedScopes) {
          renderedScopes = scopes;
          picker.replaceChildren(
            new Option("Across projects", ""),
            ...projects.map(({ id, name, root, archived }) => {
              const duplicate = nameCounts.get(name) > 1;
              const option = new Option(
                name + (duplicate ? " — " + root : "") + (archived ? " (archived)" : ""),
                id,
              );
              option.title = root;
              return option;
            }),
          );
        }
        picker.value = projectId ?? "";
        if (previousScope !== projectId) resetScope();
        loadedScope = projectId;
        await loadScope();
      },
      { background: true },
    );
  }

  picker.addEventListener("change", () => {
    if (busy || !canChangeView()) {
      picker.value = projectId ?? "";
      return;
    }
    projectId = picker.value || null;
    void run(async () => {
      resetScope();
      loadedScope = projectId;
      await loadScope();
    });
  });
  $("memory-reload").addEventListener("click", () => {
    if (canChangeView()) void load();
  });
  $("memory-new").addEventListener("click", () => {
    if (!canChangeView()) return;
    showEditor(undefined);
    keyInput.focus();
  });
  $("memory-cancel").addEventListener("click", () => {
    showEditor(null);
    message("memory-warning", "");
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const key = keyInput.value.trim();
    const text = textInput.value.trim();
    const expectedUpdatedAt = current?.updatedAt ?? null;
    void run(async () => {
      const { note } = await api("memory", {
        action: "save",
        projectId,
        key,
        text,
        expectedUpdatedAt,
      });
      notes = [...notes.filter((entry) => entry.key !== note.key), note];
      showEditor(note);
      renderNotes();
      message("memory-status", "Saved in " + scopeLabel() + ".");
    });
  });

  $("memory-forget").addEventListener("click", () => {
    if (busy) return;
    $("memory-forget-description").textContent =
      current.key + " will be removed from " + scopeLabel() + ".";
    dialog.returnValue = "";
    dialog.showModal();
  });
  dialog.addEventListener("close", () => {
    if (dialog.returnValue !== "forget" || !current) return;
    const { key, updatedAt } = current;
    void run(async () => {
      await api("memory", { action: "forget", projectId, key, expectedUpdatedAt: updatedAt });
      notes = notes.filter((entry) => entry.key !== key);
      showEditor(null);
      renderNotes();
      message("memory-status", "Note forgotten.");
      $("memory-new").focus();
    });
  });

  return { load };
}
