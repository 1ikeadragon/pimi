// Pimi. Apache-2.0.
import { labelChips, labelPicker } from "./labels.js";
import { createTasksView } from "./tasks.js";
import { replaceBoardLanes } from "./board-motion.js";
import { createMemoryView } from "./memory.js";
import { createSpacesView } from "./spaces.js";
import { createDiffFind } from "./diff-find.js";
import { createWorktreeComparison } from "./worktree-comparison.js";
import { connectLiveUpdates } from "./live-updates.js";
import { createReviewPullRequests } from "./review-pull-requests.js";
import { createReviewFiles } from "./review-files.js";

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
let viewRequest = 0;
let reviewMode = "prs";
let reviewScreen = "home";
let railTab = "worktrees";
let reviewKey;
let reviewRequest;
let currentReviewPrUrl;
const reviewPrStates = new Map();
let pendingReviewPrRestore;
const sourceSelections = new Set();
const scrollRestores = new Map();
const MAX_REVIEW_SCROLL_RESTORES = 100;
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
  pullRequestActions,
  compareReview(card, base) {
    if (!activeWorktree || reviewScreen !== "code") {
      selectWorktree(card, base);
      return;
    }
    if (card.path !== activeWorktree.path) {
      view("review");
      worktreeComparison.open(card, base);
    }
  },
  refreshBoard,
});
const memoryView = createMemoryView({ $, api, button, element, message });
const spacesView = createSpacesView({ $, api, button, element, message });
const reviewFiles = createReviewFiles({
  $,
  api,
  button,
  element,
  openFile: (path) => selectFile(path, 0, true),
});
const reviewPrs = createReviewPullRequests({
  $,
  api,
  button,
  element,
  openDiff: openHostedReview,
  openTask,
  showDetails: () => showReviewContent("details"),
  onOpen: (url, previousUrl) => {
    const openedFromHome = reviewScreen === "home";
    captureReviewPrState(previousUrl);
    pendingReviewPrRestore = undefined;
    currentReviewPrUrl = url;
    publishReviewLocation({ view: "review-pr", url });
    return openedFromHome;
  },
  onOpened: restoreReviewPrState,
});

function publishReviewLocation(location) {
  window.pimiWorkspace?.setReviewLocation?.(location);
}

function rememberReviewScroll(path, position) {
  if (!review?.files.some((file) => file.path === path)) return;
  scrollRestores.delete(path);
  scrollRestores.set(path, position);
  if (scrollRestores.size > MAX_REVIEW_SCROLL_RESTORES)
    scrollRestores.delete(scrollRestores.keys().next().value);
}

function publishSelectedReviewLocation(prUrl) {
  publishReviewLocation(prUrl ? { view: "review-pr", url: prUrl } : { view: "review-home" });
}

function reviewFilesToLoad(keepSelection, prUrl) {
  const restoring = pendingReviewPrRestore?.url === prUrl ? pendingReviewPrRestore : undefined;
  if (restoring) return { restoring, previousFiles: [...restoring.state.selected] };
  return { restoring, previousFiles: keepSelection ? [...selected] : [] };
}

function canReuseCurrentReview(nextKey, prUrl) {
  return nextKey === reviewKey && (review || loading) && pendingReviewPrRestore?.url !== prUrl;
}

function captureReviewPrState(url) {
  if (!url || reviewMode !== "prs" || reviewScreen === "home") return;
  const patchScroll = new Map(scrollRestores);
  for (const [path, pane] of renderedPanes) {
    const content = pane.querySelector(".patch");
    if (content) patchScroll.set(path, { top: content.scrollTop, left: content.scrollLeft });
  }
  reviewPrStates.delete(url);
  reviewPrStates.set(url, {
    screen: reviewScreen,
    selected: [...selected],
    sources: [...sourceSelections],
    railTab,
    fileQuery: $("file-search").value,
    detailScroll: $("review-pr-details").scrollTop,
    patchScroll,
    head: review?.head,
    base: review?.base.sha,
  });
  if (reviewPrStates.size > 50) reviewPrStates.delete(reviewPrStates.keys().next().value);
}

function restoreReviewPrState(url, item) {
  const state = reviewPrStates.get(url);
  if (!state || reviewScreen !== "details") return;
  if (state.screen !== "code") {
    $("review-pr-details").scrollTop = state.detailScroll;
    return;
  }
  if (!item) return;
  pendingReviewPrRestore = { url, state };
  openHostedReview(item);
}

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

async function openPullRequest(url) {
  publishReviewLocation({ view: "review-pr", url });
  view("review");
  setReviewMode("prs");
  void reviewPrs.refresh();
  await reviewPrs.open(url, { restore: true });
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
  if (name !== "review") diffFind.close();
  if (name !== "spaces") spacesView.suspend();
  for (const section of ["tasks", "board", "review", "memory", "spaces"]) {
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
  boardData = data;
  const query = $("board-search").value.trim().toLowerCase();
  const signature = JSON.stringify([query, data], (key, value) =>
    key === "updatedAt" ? undefined : value,
  );
  if (signature === boardSignature) return;
  boardSignature = signature;
  tasksView.setBoard(data);
  worktreeComparison.setBoard(data.cards);
  renderReviewWorktrees(data.cards);
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
      !card.reviewOnly &&
      (matchesSearch(
        query,
        card.repo,
        card.name,
        card.branch,
        card.path,
        ...(card.labels ?? []),
        ...(card.linkedLabels ?? []),
      ) ||
        card.agents.some((agent) => matchesSearch(query, describeAgent(agent)))),
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
        selectWorktree(card, tasksView.baseForWorktree(card)),
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

function setReviewMode(mode) {
  if (mode !== reviewMode) {
    worktreeComparison.close();
    if (mode === "worktrees") reviewPrs.close();
  }
  reviewMode = mode;
  $("review").dataset.mode = mode;
  for (const name of ["prs", "worktrees"]) {
    $("review-mode-" + name).setAttribute("aria-pressed", String(mode === name));
  }
  $("review-pr-nav").hidden = mode !== "prs";
}

function showReviewContent(screen) {
  reviewScreen = screen;
  const isPr = reviewMode === "prs";
  const selectedPr = isPr && screen !== "home";
  $("review-entry").hidden = screen !== "home";
  $("review-desk").hidden = isPr && screen === "home";
  $("review-pr-context").hidden = !selectedPr;
  $("review-pr-inbox-back").hidden = !selectedPr;
  $("review-file-navigation").hidden = isPr && screen !== "code";
  $("review-tab-worktrees").hidden = isPr;
  $("review-code").hidden = screen !== "code";
  $("review-pr-details").hidden = screen !== "details";
  $("review-actions").hidden = screen !== "code";
  $("review-resume").hidden = !review || Boolean(review.pr);
  $("review-pr-overview").setAttribute("aria-pressed", String(screen === "details"));
  $("review-pr-changes").setAttribute("aria-pressed", String(screen === "code"));
  $("review").dataset.screen = screen;
  if (screen !== "code") diffFind.close();
}

function selectReviewTab(tab) {
  if ((tab === "changes" || tab === "files") && !activeWorktree) tab = "worktrees";
  railTab = tab;
  for (const name of ["worktrees", "changes", "files"]) {
    $("review-tab-" + name).setAttribute("aria-pressed", String(name === tab));
    $("review-" + name + "-nav").hidden = name !== tab;
  }
  if (tab === "changes" || tab === "files") {
    if (reviewScreen !== "code") showCurrentReview();
    if (tab === "files") void reviewFiles.open(review?.id);
  }
}

function clearReviewComparison() {
  review = undefined;
  selected = [];
  patchCache.clear();
  sourceSelections.clear();
  scrollRestores.clear();
  reviewFiles.reset();
  closeTour();
  renderFiles();
  renderPanes();
}

function showCurrentReview() {
  showReviewContent("code");
  $("review-repo").textContent = activeWorktree.repo;
  $("review-title").textContent = activeWorktree.name;
  if (review) {
    renderReviewSummary(review);
  }
}

function selectWorktree(card, base = "", prUrl = "") {
  publishSelectedReviewLocation(prUrl);
  setReviewMode(prUrl ? "prs" : "worktrees");
  const nextKey = JSON.stringify([card.path, base, prUrl]);
  if (canReuseCurrentReview(nextKey, prUrl)) {
    view("review");
    showCurrentReview();
    if (railTab === "worktrees") selectReviewTab("changes");
    message("review-warning", "");
    return;
  }
  const sameCheckout = Boolean(review && card.path && card.path === activeWorktree?.path);
  reviewKey = nextKey;
  activeWorktree = card;
  worktreeComparison.setPrimary(card);
  worktreeComparison.close();
  if (!sameCheckout) {
    clearReviewComparison();
    $("file-search").value = "";
  }
  $("base").value = base;
  $("pr").value = prUrl || card.prUrl || "";
  $("mode").value = prUrl ? "pr" : "all";
  $("mode").disabled = Boolean(card.hosted);
  $("compare-worktrees").disabled = Boolean(card.hosted);
  $("review-tab-changes").disabled = false;
  $("review-tab-files").disabled = !sameCheckout;
  updateCompareControls();
  const links = (card.previews ?? []).map((preview) => {
    const link = element("a", "button secondary", `Preview ${preview.name} ↗`);
    link.href = preview.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    return link;
  });
  links.push(...agentChatActions(card.agents ?? []));
  $("previews").replaceChildren(...links);
  $("previews").hidden = !links.length;
  view("review");
  showCurrentReview();
  selectReviewTab("changes");
  renderReviewWorktrees(boardData?.cards ?? []);
  void loadReview({ keepSelection: sameCheckout });
}

function openHostedReview(item) {
  const matches = (candidate) =>
    !candidate.unavailable &&
    candidate.head === item.headSha &&
    item.worktreePaths?.includes(candidate.path);
  const cards = boardData?.cards ?? [];
  const card =
    cards.find((candidate) => candidate.path === activeWorktree?.path && matches(candidate)) ??
    cards.find(matches);
  selectWorktree(
    card ?? {
      path: "",
      repo: item.repository,
      name: item.title ?? `Pull request #${item.number}`,
      hosted: true,
    },
    "",
    item.url,
  );
}

function renderReviewWorktrees(cards = boardData?.cards ?? []) {
  const query = $("review-worktree-search").value.trim().toLowerCase();
  const choices = cards.filter(
    (card) =>
      !card.unavailable && matchesSearch(query, card.repo, card.name, card.branch, card.path),
  );
  const list = $("review-worktree-list");
  const signature = JSON.stringify([
    query,
    activeWorktree?.path,
    choices.map(({ path, repo, name, branch, lane }) => [path, repo, name, branch, lane]),
  ]);
  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature;
  const groups = [
    ["Ready to review", choices.filter(({ lane }) => lane === "review")],
    ["Needs attention", choices.filter(({ lane }) => lane === "attention")],
    ["Working", choices.filter(({ lane }) => lane === "running")],
    [
      "Other worktrees",
      choices.filter(({ lane }) => !["review", "attention", "running"].includes(lane)),
    ],
  ];
  const rows = [];
  for (const [title, entries] of groups) {
    if (!entries.length) continue;
    rows.push(element("h3", "review-rail-group", title));
    for (const card of entries) {
      const row = button("review-target-row", "", () =>
        selectWorktree(card, tasksView.baseForWorktree(card)),
      );
      row.setAttribute("aria-pressed", String(activeWorktree?.path === card.path));
      row.title = card.path;
      row.append(
        element("strong", "", card.name),
        element("span", "", card.repo + " · " + card.branch),
      );
      rows.push(row);
    }
  }
  if (!rows.length)
    rows.push(element("p", "empty", query ? "No matching worktrees" : "No worktrees yet"));
  list.replaceChildren(...rows);
}

function openReviewPicker(warning = "") {
  captureReviewPrState(currentReviewPrUrl);
  publishReviewLocation({ view: "review-home" });
  view("review");
  setReviewMode("worktrees");
  showReviewContent("home");
  selectReviewTab("worktrees");
  $("review-repo").textContent = "";
  $("review-title").textContent = "Review";
  $("review-meta").textContent = "";
  $("review-meta").removeAttribute("title");
  message("review-warning", warning);
  renderReviewWorktrees();
  void refreshBoard();
}

function openReviewInbox(filter) {
  captureReviewPrState(currentReviewPrUrl);
  publishReviewLocation({ view: "review-prs" });
  view("review");
  setReviewMode("prs");
  worktreeComparison.close();
  reviewPrs.close();
  showReviewContent("home");
  message("review-warning", "");
  if (filter) reviewPrs.setFilter(filter);
  void reviewPrs.refresh();
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
  const source = result.head ? `${baseDisplay} → ${result.head.slice(0, 8)}` : "No commits yet";
  const meta = $("review-meta");
  meta.title = result.head
    ? `${result.base.label} → ${result.head}`
    : "Changes since an empty tree";
  meta.textContent = [
    result.pr ? "" : source,
    result.live ? "Includes working changes" : "Pinned commits",
    result.hosted ? "GitHub snapshot" : "",
    !result.hosted && !result.canOpenFiles ? "PR head differs from local checkout" : "",
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
    $("review-editor").title = error.message;
  }
}

async function loadReview({ keepSelection = false } = {}) {
  if (!activeWorktree) return;
  const mode = $("mode").value;
  const prUrl = mode === "pr" ? $("pr").value.trim() : "";
  if (mode === "pr" && !prUrl) {
    message("review-warning", "Enter a GitHub pull request URL.");
    return;
  }
  const request = ++generation;
  reviewRequest?.abort();
  reviewRequest = new AbortController();
  const { restoring, previousFiles } = reviewFilesToLoad(keepSelection, prUrl);
  loading = true;
  $("load-review").disabled = true;
  $("refresh-comparison").disabled = true;
  $("review-meta").textContent = review ? "Refreshing comparison…" : "Loading comparison…";
  $("review-meta").removeAttribute("title");
  message("review-warning", "");
  if (!review) {
    renderFiles();
    renderPanes();
  }
  try {
    const result = await api(
      "review",
      {
        path: activeWorktree.path,
        mode: mode === "pr" ? "committed" : mode,
        baseRef: $("base").value.trim(),
        prUrl,
      },
      reviewRequest.signal,
    );
    if (request !== generation) return;
    installComparison(result, previousFiles, restoring);
  } catch (error) {
    if (request !== generation) return;
    message("review-warning", error.message);
    if (review && reviewScreen === "code") renderReviewSummary(review);
    else if (reviewScreen === "code") $("review-meta").textContent = "Comparison unavailable";
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

function installComparison(result, previousFiles, restoring) {
  scrollRestores.clear();
  if (restoring) {
    if (restoring.state.head === result.head && restoring.state.base === result.base.sha) {
      for (const [path, position] of restoring.state.patchScroll)
        scrollRestores.set(path, position);
    }
    sourceSelections.clear();
    for (const path of restoring.state.sources) sourceSelections.add(path);
    $("file-search").value = restoring.state.fileQuery;
    pendingReviewPrRestore = undefined;
  } else {
    for (const path of previousFiles) {
      const content = renderedPanes.get(path)?.querySelector(".patch");
      if (content) scrollRestores.set(path, { top: content.scrollTop, left: content.scrollLeft });
    }
  }
  review = result;
  reviewEditors = [];
  renderEditorPicker($("review-editor"));
  $("review-tab-files").disabled = Boolean(result.hosted);
  patchCache.clear();
  renderedPanes.clear();
  $("panes").replaceChildren();
  closeTour();
  const paths = new Set(result.files.map((file) => file.path));
  selected = previousFiles.filter((path) => paths.has(path) || sourceSelections.has(path));
  if (!selected.length && result.files.length) selected = [result.files[0].path];
  if (reviewScreen === "code") renderReviewSummary(result);
  if (restoring) selectReviewTab(restoring.state.railTab);
  if (railTab === "files") void reviewFiles.open(result.id);
  void loadReviewEditors(result);
}

function selectFile(path, side = 0, source = false) {
  const showingSource = sourceSelections.has(path);
  if (selected[side] === path && showingSource === source) return;
  if (source) sourceSelections.add(path);
  else sourceSelections.delete(path);
  if (showingSource !== source) {
    renderedPanes.get(path)?.remove();
    renderedPanes.delete(path);
  }
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
    let label = review ? "No changed files" : "No comparison loaded";
    if (loading) label = "Loading…";
    $("file-list").replaceChildren(element("p", "empty", label));
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
        element("span", "file-status " + file.status[0].toLowerCase(), file.status[0]),
        fileLabel(file.path),
      );
      const side = button("icon-button", "◫", () => selectFile(file.path, 1));
      side.setAttribute("aria-label", `Open ${file.path} in second pane`);
      side.title = "Open in second pane";
      row.append(choose, side);
      return row;
    }),
  );
}

function fileLabel(path) {
  const slash = path.lastIndexOf("/");
  const label = element("span", "review-file-label");
  label.append(element("strong", "file-name", path.slice(slash + 1)));
  if (slash >= 0) label.append(element("span", "review-file-directory", path.slice(0, slash)));
  return label;
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
  const hasHunks = /^@@ /m.test(patch);
  for (const text of patch.replace(/\n$/, "").split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    let kind = "meta";
    let before;
    let after;
    if (hunk) {
      kind = "hunk";
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
    if (kind === "meta" && hasHunks && /^(diff --git |index |--- |\+\+\+ )/.test(text)) continue;
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
  let showingSource = !file || sourceSelections.has(path);
  let request = 0;
  const pane = element("section", "pane");
  pane.setAttribute("aria-label", path);
  const heading = element("div", "pane-head");
  const title = element("span", "pane-path", path);
  title.title = path;
  const actions = element("div", "pane-actions");
  const content = element("div", "patch");
  content.tabIndex = 0;
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
  if (file && current.canOpenFiles && file.status !== "D") editor.dataset.editorOpenable = "false";
  renderEditorPicker(editor, false);
  const toggle = button("icon-button review-pane-toggle", showingSource ? "Diff" : "File", () => {
    showingSource = !showingSource;
    if (showingSource) sourceSelections.add(path);
    else sourceSelections.delete(path);
    void loadContent();
  });
  toggle.setAttribute("aria-label", `Toggle file and diff for ${path}`);
  const wrap = button("icon-button review-pane-toggle", "Wrap", () => {
    const enabled = content.classList.toggle("review-wrap");
    wrap.setAttribute("aria-pressed", String(enabled));
  });
  wrap.setAttribute("aria-label", "Wrap long lines");
  wrap.setAttribute("aria-pressed", "false");
  const close = button("icon-button", "×", () => {
    selected = selected.filter((item) => item !== path);
    renderFiles();
    renderPanes();
  });
  close.setAttribute("aria-label", `Close ${path}`);
  if (file) actions.append(toggle);
  actions.append(wrap);
  if (editor.dataset.editorOpenable !== undefined) actions.append(editor);
  actions.append(close);
  heading.append(title, actions);
  pane.append(heading, content);

  async function loadContent() {
    const attempt = ++request;
    toggle.textContent = file?.status === "D" ? "Before" : "File";
    if (showingSource) toggle.textContent = "Diff";
    toggle.setAttribute("aria-pressed", String(showingSource));
    content.setAttribute("aria-label", `${showingSource ? "Source" : "Diff"} for ${path}`);
    content.replaceChildren(
      element("p", "empty", showingSource ? "Loading file…" : "Loading diff…"),
    );
    try {
      if (showingSource) {
        const query = new URLSearchParams({ id: current.id, path });
        const { source, tokens } = await api((file ? "source?" : "review-source?") + query);
        if (attempt !== request || current !== review) return;
        showSource(source, tokens, content);
      } else {
        const { patch, fingerprint } = await getPatch(current.id, path);
        if (attempt !== request || current !== review) return;
        pane.dataset.fingerprint = fingerprint;
        if (patch.length > 400_000) {
          content.replaceChildren(element("p", "empty", "This patch is too large to display."));
        } else if (!patch) {
          content.replaceChildren(
            element(
              "p",
              "empty",
              current.hosted
                ? "GitHub did not return a text patch for this file."
                : "No text patch is available. Open the file to see its contents.",
            ),
          );
        } else {
          firstLine = formatPatch(patch, content);
        }
        if (editor.dataset.editorOpenable !== undefined) {
          editor.dataset.editorOpenable = "true";
          renderEditorPicker(editor);
        }
      }
      const position = scrollRestores.get(path);
      if (position) {
        content.scrollTop = position.top;
        content.scrollLeft = position.left;
        scrollRestores.delete(path);
      }
      focusStep();
    } catch (error) {
      if (attempt === request)
        content.replaceChildren(
          element("p", "empty", error.message),
          button("button quiet review-retry", "Try again", loadContent),
        );
    }
  }
  void loadContent();
  return pane;
}

function renderPanes() {
  for (const [path, pane] of renderedPanes) {
    if (!selected.includes(path)) {
      const content = pane.querySelector(".patch");
      if (content) rememberReviewScroll(path, { top: content.scrollTop, left: content.scrollLeft });
      renderedPanes.delete(path);
      pane.remove();
    }
  }
  if (!selected.length) {
    const empty = element("div", "review-code-empty");
    let title = "Choose a file";
    let hint = "Pick a file in the sidebar to review it.";
    if (loading && !review) {
      title = "Loading comparison…";
      hint = "";
    } else if (!review) {
      title = "Comparison unavailable";
      hint = "Try again or choose a different comparison.";
    } else if (!review.files.length) {
      title = "No changes to review";
      hint = "Switch to Files to browse the code in this checkout.";
    }
    empty.append(element("h2", "", title));
    if (hint) empty.append(element("p", "subtitle", hint));
    if (review && !review.files.length && !review.hosted)
      empty.append(button("button secondary", "Browse files", () => selectReviewTab("files")));
    $("panes").replaceChildren(empty);
    return;
  }
  $("panes").querySelector(":scope > .review-code-empty")?.remove();
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
$("show-review").addEventListener("click", () => {
  if (reviewMode === "prs" && reviewScreen !== "home") {
    view("review");
    void reviewPrs.refresh();
  } else openReviewInbox();
});
$("review-mode-prs").addEventListener("click", () => openReviewInbox());
$("review-mode-worktrees").addEventListener("click", () => openReviewPicker());
$("review-pr-inbox-back").addEventListener("click", () => {
  openReviewInbox();
  $("review-pr-search").focus();
});
$("review-pr-overview").addEventListener("click", () => {
  message("review-warning", "");
  showReviewContent("details");
});
$("review-pr-changes").addEventListener("click", () => reviewPrs.showChanges());
$("change-review-worktree").addEventListener("click", () => {
  selectReviewTab("worktrees");
  $("review-worktree-search").focus();
});
$("compare-worktrees").addEventListener("click", () => worktreeComparison.open());
for (const tab of ["worktrees", "changes", "files"]) {
  $("review-tab-" + tab).addEventListener("click", () => selectReviewTab(tab));
}
$("review-worktree-search").addEventListener("input", () => renderReviewWorktrees());
$("review-worktree-search").addEventListener("keydown", (event) => {
  if (event.key === "Enter") $("review-worktree-list").querySelector("button")?.click();
});
$("review-resume").addEventListener("click", () => {
  if (!activeWorktree || !review) return;
  showCurrentReview();
  selectReviewTab("changes");
  message("review-warning", "");
});
$("review-add-repository").addEventListener("click", () => {
  $("show-board").click();
  $("watch-repo").closest("details").open = true;
  $("repo-path").focus();
});
async function navigateToWorktreeReview(destination) {
  publishReviewLocation({ view: "review-home" });
  const request = view("review");
  if (destination.reviewNotice) {
    openReviewPicker(destination.reviewNotice);
    return;
  }
  const prepared = destination.reviewTarget;
  // An explicit prepared target already passed the desktop runtime's host and path checks.
  const board = refreshBoard();
  const taskState = tasksView.load();
  await (prepared ? taskState : Promise.all([board, taskState]));
  if (request !== viewRequest) return;
  if (!prepared && destination.serverId && boardData?.serverId !== destination.serverId) {
    openReviewPicker("This checkout belongs to another host or is offline.");
    return;
  }
  const card =
    boardData?.cards.find(({ path, unavailable }) => path === destination.path && !unavailable) ??
    prepared;
  if (!card) {
    openReviewPicker("Choose a worktree to review.");
    return;
  }
  selectWorktree(card, tasksView.baseForWorktree(card));
}

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
  if (destination.view === "review-home") {
    openReviewPicker();
    return;
  }
  if (destination.view === "review-prs") {
    openReviewInbox(destination.filter);
    return;
  }
  if (destination.view === "review-pr") {
    await openPullRequest(destination.url);
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
  if (destination.view !== "review") {
    $("show-board").click();
    return;
  }
  await navigateToWorktreeReview(destination);
});
$("board-search").addEventListener("input", () => {
  if (boardData) renderBoard(boardData);
});
$("board-search").addEventListener("keydown", (event) => {
  if (event.key === "Enter") $("lanes").querySelector(".work-card-open:not(:disabled)")?.click();
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
$("file-tour").addEventListener("click", () => {
  $("review-tools").open = false;
  startFileTour();
});
$("ai-tour").addEventListener("click", () => {
  $("review-tools").open = false;
  void startAiTour();
});
$("prev-step").addEventListener("click", () => showStep(stepIndex - 1));
$("next-step").addEventListener("click", nextStep);
$("close-tour").addEventListener("click", closeTour);
function focusViewSearch(event, reviewing) {
  const listSearch = $("tasks").hidden ? "board-search" : "task-search";
  const reviewSearch = {
    worktrees: "review-worktree-search",
    changes: "file-search",
    files: "review-source-search",
  }[railTab];
  let searchId = reviewing ? reviewSearch : listSearch;
  if (reviewing && reviewMode === "prs" && reviewScreen !== "code") searchId = "review-pr-search";
  const search = $(searchId);
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
  const reviewing = !$("review").hidden;
  if (event.key === "/") {
    focusViewSearch(event, reviewing);
  } else if (reviewing && event.key === "Escape" && tour) {
    closeTour();
  } else if (reviewing && reviewScreen === "code" && (event.key === "[" || event.key === "]")) {
    event.preventDefault();
    navigateReview(event.key === "[" ? -1 : 1);
  }
});
connectLiveUpdates({
  refreshBoard,
  refreshTasks: tasksView.load,
  refreshPullRequests: () => !$("review").hidden && reviewMode === "prs" && reviewPrs.refresh(),
  status: (text) => message("live-status", text),
});
