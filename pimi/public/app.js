// Pimi addition to the Paseo fork. Apache-2.0.
import { createTasksView } from "./tasks.js";
import { createMemoryView } from "./memory.js";
import { createDiffFind } from "./diff-find.js";
import { createWorktreeComparison } from "./worktree-comparison.js";
import { connectLiveUpdates } from "./live-updates.js";

const $ = (id) => document.getElementById(id);
const laneDefinitions = [
  ["ready", "Ready", "No clean worktrees"],
  ["running", "In progress", "No agents running"],
  ["review", "Review", "Nothing to review"],
  ["attention", "Needs attention", "Nothing needs attention"],
];
let activeWorktree;
let review;
let selected = [];
let daemonConnected = false;
let tour;
let stepIndex = 0;
let generatingFor;
let generation = 0;
let loading = false;
let reviewEditors = [];
let boardRequest;
let boardSignature;
let boardData;
const patchCache = new Map();
const renderedPanes = new Map();
const diffFind = createDiffFind($);
const worktreeComparison = createWorktreeComparison({
  $,
  api,
  element,
  button,
  formatPatch,
  baseForWorktree: (card) => tasksView.baseForWorktree(card),
});
const tasksView = createTasksView({
  $,
  api,
  button,
  element,
  message,
  agentChatLinks: agentChatActions,
  openReview: selectWorktree,
  compareReview(card, base) {
    if (!activeWorktree || !$("review-entry").hidden) selectWorktree(card, base);
    view("review");
    worktreeComparison.open(card, base);
  },
  refreshBoard,
});
const memoryView = createMemoryView({ $, api, button, element, message });

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
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
  if (name !== "tasks") tasksView.cancelDictation();
  if (name !== "review") diffFind.close();
  for (const section of ["tasks", "board", "review", "memory"]) {
    $(section).hidden = section !== name;
    const nav = $("show-" + section);
    if (section === name) nav.setAttribute("aria-current", "page");
    else nav.removeAttribute("aria-current");
  }
  window.pimiWorkspace?.setSection(name);
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
      message(
        $("tasks").hidden ? "review-warning" : "task-warning",
        "Could not copy the chat link.",
      );
    }
  });
  return [...links, copy];
}

function matchesSearch(query, ...values) {
  return values.some((value) => value?.toLowerCase().includes(query));
}

function renderBoard(data) {
  const previousLanes = new Map(boardData?.cards.map(({ path, lane }) => [path, lane]));
  boardData = data;
  const query = $("board-search").value.trim().toLowerCase();
  const signature = JSON.stringify([query, data], (key, value) =>
    key === "updatedAt" ? undefined : value,
  );
  if (signature === boardSignature) return;
  boardSignature = signature;
  tasksView.setBoard(data);
  worktreeComparison.setBoard(data.cards);
  renderReviewWorktreeOptions(data.cards);
  daemonConnected = !data.daemonError;
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
      matchesSearch(query, card.repo, card.name, card.branch, card.path) ||
      card.agents.some((agent) => matchesSearch(query, describeAgent(agent))),
  );
  const otherAgents = data.otherAgents.filter((agent) =>
    matchesSearch(query, describeAgent(agent), agent.cwd),
  );
  const lanes = laneDefinitions.map(([id, title, empty]) => {
    const lane = element("section", "lane " + id);
    const header = element("div", "lane-heading");
    const cards = cardsMatchingQuery.filter((card) => card.lane === id);
    header.append(element("h2", "", title), element("span", "count", cards.length));
    lane.append(header);
    for (const card of cards) {
      const item = button("card", "", () => selectWorktree(card));
      item.dataset.path = card.path;
      if (previousLanes.has(card.path) && previousLanes.get(card.path) !== id) {
        item.classList.add("card-moved");
      }
      item.title = card.path;
      item.disabled = Boolean(card.unavailable);
      const gitStatus = [
        card.unavailable ? "Worktree missing" : card.error,
        card.dirty ? "Working changes" : "",
        card.ahead ? `${card.ahead} ahead of base` : "",
        card.prUrl ? "Open PR" : "",
      ].filter(Boolean);
      item.append(
        element("span", "card-name", card.name),
        element("span", "card-repo", card.repo),
        element("span", "card-detail", gitStatus.join(" · ") || "No pending changes"),
        ...card.agents.map((agent) =>
          element("span", "card-agent", describeAgent(agent, card.name)),
        ),
      );
      lane.append(item);
    }
    if (!cards.length) lane.append(element("p", "empty", query ? "No matching worktrees" : empty));
    return lane;
  });
  const focusedPath = document.activeElement?.closest(".card")?.dataset.path;
  $("lanes").replaceChildren(...lanes);
  if (focusedPath)
    [...$("lanes").querySelectorAll(".card")]
      .find((card) => card.dataset.path === focusedPath)
      ?.focus({ preventScroll: true });
  $("other-agents").hidden = !otherAgents.length;
  $("agent-list").replaceChildren(
    ...otherAgents.map((agent) => {
      const row = element("div", "agent-row", describeAgent(agent));
      row.title = agent.cwd;
      return row;
    }),
  );
  updateTourControls();
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
      daemonConnected = false;
      message("board-warning", error.message);
      updateTourControls();
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

function selectWorktree(card, base = "") {
  activeWorktree = card;
  worktreeComparison.setPrimary(card);
  $("file-search").value = "";
  $("base").value = base;
  $("pr").value = card.prUrl || "";
  $("mode").value = "all";
  updateCompareControls();
  $("review-entry").hidden = true;
  $("review-actions").hidden = false;
  $("review-desk").hidden = false;
  $("review-repo").textContent = card.repo;
  $("review-title").textContent = card.name;
  const links = (card.previews ?? []).map((preview) => {
    const link = element("a", "button secondary", `Preview ${preview.name} ↗`);
    link.href = preview.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    return link;
  });
  links.push(...agentChatActions(card.agents));
  $("previews").replaceChildren(...links);
  $("previews").hidden = !links.length;
  view("review");
  void loadReview();
}

function renderReviewWorktreeOptions(cards) {
  const picker = $("review-worktree");
  const previous = picker.value || activeWorktree?.path || "";
  const choices = cards.filter((card) => !card.unavailable);
  const signature = JSON.stringify(choices.map(({ path, repo, name }) => [path, repo, name]));
  if (picker.dataset.options === signature) return;
  picker.dataset.options = signature;
  const placeholder = element(
    "option",
    "",
    choices.length ? "Select a worktree" : "No worktrees yet",
  );
  placeholder.value = "";
  picker.replaceChildren(
    placeholder,
    ...choices.map((card) => {
      const option = element("option", "", `${card.repo} · ${card.name}`);
      option.value = card.path;
      return option;
    }),
  );
  picker.value = choices.some((card) => card.path === previous) ? previous : "";
  picker.disabled = choices.length === 0;
  $("review-open-worktree").disabled = !picker.value;
}

function openReviewPicker(warning = "") {
  diffFind.close();
  worktreeComparison.close();
  ++generation;
  loading = false;
  $("review-repo").textContent = "Worktree review";
  $("review-title").textContent = "Review";
  $("review-meta").textContent = "";
  $("review-meta").removeAttribute("title");
  $("review-entry").hidden = false;
  $("review-actions").hidden = true;
  $("review-desk").hidden = true;
  message("review-warning", warning);
  view("review");
  renderReviewWorktreeOptions(boardData?.cards ?? []);
  void refreshBoard();
}

function updateCompareControls() {
  const mode = $("mode").value;
  $("base-control").hidden = mode === "working" || mode === "pr";
  $("pr-control").hidden = mode !== "pr";
}

function renderReviewSummary(result) {
  const baseLabel = result.base.label.replace(/^refs\/(heads|remotes)\//, "");
  const baseDisplay = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(baseLabel)
    ? baseLabel.slice(0, 8)
    : baseLabel;
  const source = result.pr?.label || `${baseDisplay} → ${result.head.slice(0, 8)}`;
  const meta = $("review-meta");
  meta.title = `${result.base.label} → ${result.head}`;
  meta.textContent = [
    source,
    result.live ? "Includes tracked working changes" : "Pinned commits",
    result.untracked
      ? `${result.untracked} untracked ${result.untracked === 1 ? "file" : "files"} excluded`
      : "",
    !result.canOpenFiles ? "PR head differs from local checkout" : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function renderEditorPicker(picker, available = true) {
  const choices = available ? reviewEditors : [];
  picker.replaceChildren(
    new Option("Open in…", ""),
    ...choices.map(({ id, label }) => new Option(label, id)),
  );
  picker.disabled = !choices.length;
}

function renderReviewEditorPickers() {
  renderEditorPicker($("review-editor"));
  for (const pane of renderedPanes.values()) {
    const editor = pane.querySelector("[data-editor-openable]");
    if (editor) renderEditorPicker(editor, editor.dataset.editorOpenable === "true");
  }
}

async function loadReviewEditors(result) {
  try {
    const choices = await api("editors?" + new URLSearchParams({ id: result.id }));
    if (review !== result) return;
    reviewEditors = choices;
    renderReviewEditorPickers();
    $("review-editor").title = choices.length ? "" : "No editor available";
  } catch (error) {
    if (review !== result) return;
    message("review-warning", error.message);
  }
}

async function loadReview({ keepSelection = false } = {}) {
  const mode = $("mode").value;
  if (mode === "pr" && !$("pr").value.trim()) {
    message("review-warning", "Enter a GitHub pull request URL.");
    return;
  }
  const request = ++generation;
  const previousFiles = keepSelection ? selected : [];
  loading = true;
  $("load-review").disabled = true;
  $("refresh-comparison").disabled = true;
  reviewEditors = [];
  renderEditorPicker($("review-editor"));
  $("review-editor").title = "Detecting editors…";
  $("review-meta").textContent = "Loading comparison…";
  $("review-meta").removeAttribute("title");
  message("review-warning", "");
  review = undefined;
  selected = [];
  patchCache.clear();
  closeTour();
  renderFiles();
  renderPanes();
  updateTourControls();
  try {
    const result = await api("review", {
      path: activeWorktree.path,
      mode: mode === "pr" ? "committed" : mode,
      baseRef: $("base").value.trim(),
      prUrl: mode === "pr" ? $("pr").value.trim() : "",
    });
    if (request !== generation) return;
    review = result;
    const paths = new Set(result.files.map((file) => file.path));
    selected = previousFiles.filter((path) => paths.has(path));
    if (!selected.length && result.files.length) selected = [result.files[0].path];
    renderReviewSummary(result);
    void loadReviewEditors(result);
  } catch (error) {
    if (request !== generation) return;
    message("review-warning", error.message);
    $("review-meta").textContent = "Comparison unavailable";
  } finally {
    if (request === generation) {
      loading = false;
      $("load-review").disabled = false;
      $("refresh-comparison").disabled = false;
      renderFiles();
      renderPanes();
      updateTourControls();
    }
  }
}

function selectFile(path, side = 0) {
  if (selected[side] === path) return;
  if (selected[1 - side] === path) {
    [selected[0], selected[1]] = [selected[1], selected[0]];
  } else if (side === 1 && !selected[0]) {
    selected = [path];
  } else {
    selected[side] = path;
  }
  selected = selected.filter(Boolean);
  renderFiles();
  renderPanes();
}

function matchingFiles() {
  const query = $("file-search").value.trim().toLowerCase();
  return review?.files.filter((file) => matchesSearch(query, file.path, file.oldPath)) ?? [];
}

function renderFiles() {
  const files = matchingFiles();
  const total = review?.files.length ?? 0;
  $("file-count").textContent = files.length === total ? total : `${files.length} / ${total}`;
  if (!review?.files.length) {
    $("file-list").replaceChildren(
      element("p", "empty", loading ? "Loading…" : "No tracked changes to display"),
    );
    return;
  }
  if (!files.length) {
    $("file-list").replaceChildren(element("p", "empty", "No matching files"));
    return;
  }
  $("file-list").replaceChildren(
    ...files.map((file) => {
      const row = element("div", "file-row" + (selected.includes(file.path) ? " selected" : ""));
      const choose = button("file-select", "", () => selectFile(file.path));
      choose.setAttribute("aria-pressed", String(selected[0] === file.path));
      choose.title = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
      choose.append(
        element("span", "file-status", file.status[0]),
        element("span", "file-name", file.path),
      );
      const side = button("icon-button", "◫", () => selectFile(file.path, 1));
      side.setAttribute("aria-label", `Open ${file.path} in second pane`);
      side.title = "Open in second pane";
      row.append(choose, side);
      return row;
    }),
  );
}

function getPatch(id, path) {
  const query = new URLSearchParams({ id, path });
  if (!patchCache.has(path)) {
    const request = api("file?" + query).catch((error) => {
      if (patchCache.get(path) === request) patchCache.delete(path);
      throw error;
    });
    patchCache.set(path, request);
    if (patchCache.size > 20) patchCache.delete(patchCache.keys().next().value);
  }
  return patchCache.get(path);
}

function formatPatch(patch, parent) {
  const fragment = document.createDocumentFragment();
  let oldLine = null;
  let newLine = null;
  let firstAdded;
  for (const text of patch.replace(/\n$/, "").split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    let kind = "meta";
    let before;
    let after;
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
    } else if (text.startsWith("diff --git ")) {
      oldLine = newLine = null;
    } else if (oldLine !== null && text.startsWith("+")) {
      kind = "add";
      after = newLine++;
      firstAdded ??= after;
    } else if (oldLine !== null && text.startsWith("-")) {
      kind = "remove";
      before = oldLine++;
    } else if (oldLine !== null && text.startsWith(" ")) {
      kind = "context";
      before = oldLine++;
      after = newLine++;
    }
    const row = element("div", "patch-line " + kind);
    const oldGutter = element("span", "gutter", before);
    const newGutter = element("span", "gutter", after);
    oldGutter.setAttribute("aria-hidden", "true");
    newGutter.setAttribute("aria-hidden", "true");
    if (after != null) row.dataset.line = after;
    row.append(oldGutter, newGutter, element("span", "", text));
    fragment.append(row);
  }
  parent.replaceChildren(fragment);
  return firstAdded ?? 1;
}

function showSource(source, tokens, parent) {
  const fragment = document.createDocumentFragment();
  const lines = source.replace(/\n$/, "").split("\n");
  lines.forEach((text, index) => {
    const row = element("div", "patch-line");
    row.dataset.line = index + 1;
    const gutter = element("span", "gutter", index + 1);
    gutter.setAttribute("aria-hidden", "true");
    const line = element("span", "");
    const highlighted = tokens?.[index];
    if (highlighted?.length) {
      for (const token of highlighted) {
        line.append(element("span", token.style ? `syntax-${token.style}` : "", token.text));
      }
    } else {
      line.textContent = text;
    }
    row.append(gutter, line);
    fragment.append(row);
  });
  parent.replaceChildren(fragment);
}

function focusStep() {
  for (const pane of renderedPanes.values()) {
    pane.querySelector(".focus")?.classList.remove("focus");
  }
  const step = tour?.steps[stepIndex];
  if (!step) return;
  const pane = renderedPanes.get(step.path);
  if (step.fingerprint) {
    const fingerprint = pane?.dataset.fingerprint;
    if (fingerprint !== step.fingerprint) {
      $("note-text").textContent = fingerprint
        ? "This diff has changed. Reload changes before using this note."
        : "Waiting for the changed line…";
      return;
    }
    $("note-text").textContent = step.note;
  }
  const line = Number.isSafeInteger(step.line)
    ? pane?.querySelector(`[data-line="${step.line}"]`)
    : (pane?.querySelector(".add") ?? pane?.querySelector(".remove"));
  if (line) {
    line.classList.add("focus");
    line.scrollIntoView({ block: "center", inline: "nearest" });
  }
}

function createPane(path) {
  const current = review;
  const file = current.files.find((item) => item.path === path);
  let firstLine = 1;
  const pane = element("section", "pane");
  pane.setAttribute("aria-label", path);
  const heading = element("div", "pane-head");
  const title = element("span", "pane-path", path);
  title.title = path;
  const actions = element("div", "pane-actions");
  const editor = element("select", "editor-picker");
  editor.addEventListener("change", () => {
    const editorId = editor.value;
    editor.value = "";
    if (!editorId) return;
    const step = tour?.steps[stepIndex];
    if (step?.path === path && step.fingerprint && step.fingerprint !== pane.dataset.fingerprint) {
      message("review-warning", "Reload changes before opening this walkthrough line.");
      return;
    }
    void launchEditor(
      current,
      editorId,
      path,
      step?.path === path && step.line ? step.line : firstLine,
      pane.dataset.fingerprint,
    );
  });
  editor.setAttribute("aria-label", `Open ${path} in`);
  editor.dataset.editorOpenable = "false";
  renderEditorPicker(editor, false);
  editor.title =
    current.canOpenFiles && file.status !== "D"
      ? "Open local file at the selected line"
      : "File is unavailable at the current checkout";
  const close = button("icon-button", "×", () => {
    selected = selected.filter((item) => item !== path);
    renderFiles();
    renderPanes();
  });
  close.setAttribute("aria-label", `Close ${path}`);
  actions.append(editor, close);
  heading.append(title, actions);
  const content = element("div", "patch");
  content.tabIndex = 0;
  content.setAttribute("aria-label", `Diff for ${path}`);
  content.append(element("p", "empty", "Loading diff…"));
  pane.append(heading, content);
  const displayPatch = (patch) => {
    if (patch.length > 400_000) {
      content.replaceChildren(
        element("p", "empty", "This patch exceeds the 400,000 character display limit."),
      );
    } else if (!patch) {
      content.replaceChildren(
        element("p", "empty", "No patch available. Refresh if the checkout changed."),
      );
    } else {
      firstLine = formatPatch(patch, content);
    }
    content.setAttribute("aria-label", `Diff for ${path}`);
    if (current.id === review?.id) focusStep();
  };
  const loadPatch = async () => {
    try {
      const { patch, fingerprint } = await getPatch(current.id, path);
      pane.dataset.fingerprint = fingerprint;
      displayPatch(patch);
      editor.dataset.editorOpenable = String(current.canOpenFiles && file.status !== "D");
      renderEditorPicker(editor, editor.dataset.editorOpenable === "true");
      let showingSource = false;
      const toggle = button("icon-button", file.status === "D" ? "Before" : "File", async () => {
        if (showingSource) {
          showingSource = false;
          toggle.textContent = file.status === "D" ? "Before" : "File";
          displayPatch(patch);
          return;
        }
        toggle.disabled = true;
        try {
          const query = new URLSearchParams({ id: current.id, path });
          const { source, tokens } = await api("source?" + query);
          showSource(source, tokens, content);
          showingSource = true;
          toggle.textContent = "Diff";
          content.setAttribute("aria-label", `Source for ${path}`);
          if (current.id === review?.id) focusStep();
        } catch (error) {
          if (current.id === review?.id) message("review-warning", error.message);
        } finally {
          toggle.disabled = false;
        }
      });
      toggle.setAttribute("aria-label", `Toggle file and diff for ${path}`);
      actions.prepend(toggle);
    } catch (error) {
      content.replaceChildren(element("p", "empty", error.message));
    }
  };
  void loadPatch();
  return pane;
}

function renderPanes() {
  for (const [path, pane] of renderedPanes) {
    if (!selected.includes(path)) {
      renderedPanes.delete(path);
      pane.remove();
    }
  }
  if (!selected.length) {
    $("panes").replaceChildren(element("p", "empty", "Choose a changed file to start reviewing."));
    return;
  }
  $("panes").querySelector(":scope > .empty")?.remove();
  for (const [index, path] of selected.entries()) {
    if (!renderedPanes.has(path)) renderedPanes.set(path, createPane(path));
    const pane = renderedPanes.get(path);
    const current = $("panes").children[index];
    if (pane !== current) $("panes").insertBefore(pane, current ?? null);
  }
  focusStep();
}

async function launchEditor(result, editorId, path, line = 1, fingerprint) {
  if (review !== result) return;
  try {
    await api("editor", { id: result.id, path, line, fingerprint, editorId });
  } catch (error) {
    if (review === result) message("review-warning", error.message);
  }
}

function updateTourControls() {
  $("file-tour").disabled = !review?.files.length;
  $("ai-tour").disabled = !review?.files.length || !daemonConnected || Boolean(generatingFor);
  $("ai-tour").title = daemonConnected
    ? "Use your configured agent provider"
    : "Explanations are currently unavailable";
  let status = "";
  if (generatingFor) status = "Generating notes…";
  else if (!review?.files.length) status = "Load changes to start";
  $("tour-status").textContent = status;
}

function showStep(index) {
  if (!tour || index < 0 || index >= tour.steps.length) return;
  stepIndex = index;
  const step = tour.steps[index];
  $("tour-card").hidden = false;
  $("tour-position").textContent = `${index + 1} / ${tour.steps.length} · ${tour.label}`;
  $("note-title").textContent = step.title;
  $("note-text").textContent = step.note;
  $("prev-step").disabled = index === 0;
  $("next-step").textContent = index === tour.steps.length - 1 ? "Finish" : "Next →";
  selectFile(step.path);
  focusStep();
}

function closeTour() {
  tour = undefined;
  $("tour-card").hidden = true;
  focusStep();
}

function startFileTour() {
  const statusLabels = {
    A: "Added",
    D: "Deleted",
    M: "Modified",
    R: "Renamed",
    C: "Copied",
    T: "Type changed",
  };
  tour = {
    label: "File tour",
    steps: review.files.map((file) => ({
      path: file.path,
      title: file.path,
      note: `${statusLabels[file.status[0]] || file.status} in this comparison.${file.oldPath ? ` Previous path: ${file.oldPath}.` : ""}`,
    })),
  };
  showStep(0);
}

async function startAiTour() {
  const id = review.id;
  generatingFor = id;
  updateTourControls();
  try {
    const result = await api("tour", { id });
    if (review?.id !== id) return;
    tour = { label: result.provider || "AI notes", steps: result.steps };
    if (result.omittedFiles) {
      message(
        "review-warning",
        `${result.omittedFiles} file(s) without added lines were outside the explanation. They remain in the file list.`,
      );
    }
    showStep(0);
  } catch (error) {
    if (review?.id === id) message("review-warning", error.message);
  } finally {
    generatingFor = undefined;
    updateTourControls();
  }
}

function nextStep() {
  if (!tour) return;
  if (stepIndex + 1 === tour.steps.length) closeTour();
  else showStep(stepIndex + 1);
}

function navigateReview(direction) {
  if (tour) {
    if (direction < 0) showStep(stepIndex - 1);
    else nextStep();
    return;
  }
  const files = matchingFiles();
  const current = files.findIndex((file) => file.path === selected[0]);
  const boundary = direction > 0 ? 0 : files.length - 1;
  const index = current < 0 ? boundary : current + direction;
  const file = files[index];
  if (file) selectFile(file.path);
}

$("show-board").addEventListener("click", () => {
  view("board");
  void refreshBoard();
});
$("show-tasks").addEventListener("click", () => {
  view("tasks");
  void tasksView.load();
  void refreshBoard();
});
$("show-memory").addEventListener("click", () => {
  view("memory");
  void memoryView.load();
});
const appearance = $("appearance");
appearance.value = document.documentElement.dataset.appearance;
if (window.pimiWorkspace) {
  const layoutToggle = $("toggle-workspace-window");
  layoutToggle.hidden = false;
  $("show-agents").hidden = false;
  $("show-memory").hidden = false;
  document.documentElement.dataset.workspaceChrome = window.pimiWorkspace.chrome;
  window.pimiWorkspace.onLayoutChange((mode) => {
    document.documentElement.dataset.workspaceLayout = mode;
    const detached = mode === "detached";
    const label = detached ? "Move into main window" : "Open in separate window";
    layoutToggle.setAttribute("aria-label", label);
    layoutToggle.title = label;
    layoutToggle
      .querySelector("use")
      .setAttribute("href", detached ? "#glyph-dock" : "#glyph-window");
    window.dispatchEvent(new Event("pimi-layout-change"));
  });
  layoutToggle.addEventListener("click", async () => {
    layoutToggle.disabled = true;
    message("workspace-window-warning", "");
    try {
      await window.pimiWorkspace.toggleWindow();
    } catch {
      message("workspace-window-warning", "Could not move the workspace. Try again.");
    } finally {
      layoutToggle.disabled = false;
    }
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
$("show-review").addEventListener("click", () => {
  if ($("review-entry").hidden) view("review");
  else openReviewPicker();
});
$("change-review-worktree").addEventListener("click", () => {
  openReviewPicker();
  $("review-worktree").focus();
});
$("compare-worktrees").addEventListener("click", () => worktreeComparison.open());
$("review-worktree").addEventListener("change", () => {
  $("review-open-worktree").disabled = !$("review-worktree").value;
});
$("review-target").addEventListener("submit", (event) => {
  event.preventDefault();
  const card = boardData?.cards.find(
    ({ path, unavailable }) => path === $("review-worktree").value && !unavailable,
  );
  if (card) selectWorktree(card, tasksView.baseForWorktree(card));
});
$("review-add-repository").addEventListener("click", () => {
  $("show-board").click();
  $("watch-repo").closest("details").open = true;
  $("repo-path").focus();
});
window.pimiWorkspace?.onNavigate(async (destination) => {
  if (destination.view === "memory") {
    view("memory");
    await memoryView.load(destination.projectId);
    return;
  }
  if (destination.view === "review-home") {
    $("show-review").click();
    return;
  }
  if (destination.view === "tasks") {
    $("show-tasks").click();
    return;
  }
  if (destination.view === "task-draft") {
    view("tasks");
    await Promise.all([refreshBoard(), tasksView.load()]);
    tasksView.openProposal(destination.proposal);
    return;
  }
  if (destination.view !== "review") {
    $("show-board").click();
    return;
  }
  view("review");
  await Promise.all([refreshBoard(), tasksView.load()]);
  if (destination.serverId && !daemonConnected) {
    openReviewPicker("Connect to the Agent Console host to open this review suggestion.");
    return;
  }
  if (destination.serverId && boardData?.serverId !== destination.serverId) {
    openReviewPicker("This review suggestion belongs to a different Agent Console host.");
    return;
  }
  const card = boardData?.cards.find(
    ({ path, unavailable }) => path === destination.path && !unavailable,
  );
  if (!card) {
    openReviewPicker("Add this repository in Work to open its review.");
    return;
  }
  selectWorktree(card, tasksView.baseForWorktree(card));
});
$("board-search").addEventListener("input", () => {
  if (boardData) renderBoard(boardData);
});
$("board-search").addEventListener("keydown", (event) => {
  if (event.key === "Enter") $("lanes").querySelector(".card:not(:disabled)")?.click();
});
$("file-search").addEventListener("input", renderFiles);
$("file-search").addEventListener("keydown", (event) => {
  if (event.key === "Enter") $("file-list").querySelector(".file-select")?.click();
});
$("watch-repo").addEventListener("submit", watchRepository);
$("mode").addEventListener("change", updateCompareControls);
$("compare").addEventListener("submit", (event) => {
  event.preventDefault();
  $("comparison-settings").open = false;
  void loadReview({ keepSelection: true });
});
$("refresh-comparison").addEventListener("click", () => void loadReview({ keepSelection: true }));
$("review-editor").addEventListener("change", () => {
  const picker = $("review-editor");
  const editorId = picker.value;
  picker.value = "";
  if (review && editorId) void launchEditor(review, editorId, null);
});
$("file-tour").addEventListener("click", startFileTour);
$("ai-tour").addEventListener("click", startAiTour);
$("prev-step").addEventListener("click", () => showStep(stepIndex - 1));
$("next-step").addEventListener("click", nextStep);
$("close-tour").addEventListener("click", closeTour);
function focusViewSearch(event, reviewing) {
  const listSearch = $("tasks").hidden ? "board-search" : "task-search";
  const reviewSearch = $("review-entry").hidden ? "file-search" : "review-worktree";
  const search = $(reviewing ? reviewSearch : listSearch);
  if (search.closest("[hidden]")) return;
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
  const reviewing = !$("review").hidden;
  if (event.key === "/") {
    focusViewSearch(event, reviewing);
  } else if (reviewing && event.key === "Escape" && tour) {
    closeTour();
  } else if (reviewing && (event.key === "[" || event.key === "]")) {
    event.preventDefault();
    navigateReview(event.key === "[" ? -1 : 1);
  }
});
connectLiveUpdates({
  refreshBoard,
  refreshTasks: tasksView.load,
  status: (text) => message("live-status", text),
});
