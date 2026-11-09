// Pimi addition to the Paseo fork. Apache-2.0.

const CHECK_LABELS = {
  unknown: "Checks unavailable",
  none: "No checks",
  pending: "Checks running",
  success: "Checks passed",
  failure: "Checks failed",
  cancelled: "Cancelled",
  skipped: "Skipped",
};
const REVIEW_LABELS = {
  approved: "Approved",
  changes_requested: "Changes requested",
  pending: "Awaiting review",
};

export function createReviewPullRequests({
  $,
  api,
  element,
  button,
  openDiff,
  openTask,
  showDetails,
}) {
  const nav = $("review-pr-nav");
  const details = $("review-pr-details");
  const identity = $("review-pr-identity");
  let snapshot;
  let activeUrl;
  let currentItem;
  let detailVisible = false;
  let filter = "requested";
  let query = "";
  let listRequest = 0;
  let detailRequest = 0;
  let fetching = false;
  let listError = "";
  let detailError = "";
  let detailStale = false;
  let detailUpdatedAt;
  let detailLoading = false;

  const heading = element("div", "review-pr-nav-heading");
  const title = element("h2", "", "Pull requests");
  const count = element("span", "count");
  const controls = element("div", "review-pr-controls");
  const refreshButton = button(
    "button quiet review-pr-refresh",
    "Refresh",
    () => void refresh({ force: true }),
  );
  refreshButton.type = "button";
  heading.append(title, count, refreshButton);
  const search = element("input", "search review-pr-search");
  search.id = "review-pr-search";
  search.type = "search";
  search.placeholder = "Find a pull request";
  search.setAttribute("aria-label", "Find a pull request");
  search.addEventListener("input", () => {
    query = search.value.trim().toLowerCase();
    renderList();
  });
  const filters = element("div", "review-pr-filters");
  filters.setAttribute("aria-label", "Pull request filter");
  filters.setAttribute("role", "group");
  const allButton = button("button quiet", "All", () => setFilter("all"));
  const mineButton = button("button quiet", "My open PRs", () => setFilter("mine"));
  const requestedButton = button("button quiet", "To review", () => setFilter("requested"));
  const filterCounts = [requestedButton, mineButton, allButton].map((control) => {
    const badge = element("span", "review-pr-filter-count");
    control.append(badge);
    return badge;
  });
  filters.append(requestedButton, mineButton, allButton);
  const listStatus = element("p", "review-pr-list-status");
  listStatus.setAttribute("role", "status");
  const list = element("div", "review-pr-list");
  list.setAttribute("aria-label", "Pull requests");
  const openForm = element("form", "review-pr-open-form");
  const urlInput = element("input", "search");
  urlInput.id = "review-pr-url";
  urlInput.type = "url";
  urlInput.required = true;
  urlInput.placeholder = "Paste GitHub PR URL";
  urlInput.setAttribute("aria-label", "GitHub pull request URL");
  const submit = element("button", "button quiet", "Open");
  submit.type = "submit";
  openForm.append(urlInput, submit);
  openForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+\/pull\/[1-9]\d*)\/?(?:[?#].*)?$/.exec(
      urlInput.value.trim(),
    );
    if (!match) {
      urlInput.setCustomValidity("Paste a GitHub pull request URL.");
      urlInput.reportValidity();
      return;
    }
    void open("https://github.com/" + match[1]);
    urlInput.value = "";
  });
  urlInput.addEventListener("input", () => urlInput.setCustomValidity(""));
  controls.append(filters, search);
  nav.replaceChildren(heading, controls, openForm, listStatus, list);
  renderList();

  function setFilter(next) {
    filter = next;
    renderList();
  }
  function text(value) {
    return typeof value === "string" ? value : "";
  }
  function author(item) {
    return typeof item.author === "string" ? item.author : item.author?.login || "";
  }
  function repository(item) {
    return typeof item.repository === "string"
      ? item.repository
      : item.repository?.nameWithOwner || "";
  }
  function date(value) {
    if (!value) return "";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime())
      ? ""
      : parsed.toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });
  }
  function stateLabel(item) {
    const state = text(item.state).toLowerCase();
    if (state === "merged") return "Merged";
    if (state === "closed") return "Closed";
    return item.isDraft ? "Draft" : "Open";
  }
  function chip(label, kind = "neutral") {
    const node = element("span", "review-pr-chip", label);
    node.dataset.tone = kind;
    return node;
  }
  function reviewTone(value) {
    if (value === "approved") return "success";
    return value === "changes_requested" ? "failure" : "neutral";
  }
  function stateTone(item) {
    return stateLabel(item).toLowerCase();
  }
  function sourceMessages() {
    const messages = new Set();
    const sources = [
      snapshot?.requestedReview,
      snapshot?.authored,
      ...(snapshot?.repositories || []),
    ];
    for (const source of sources) {
      if (source?.error) messages.add(String(source.error));
      if (source?.truncated)
        messages.add("Some pull requests are outside the current result limit.");
    }
    for (const warning of snapshot?.warnings || []) {
      const message = typeof warning === "string" ? warning : warning?.message;
      if (message) messages.add(message);
    }
    return [...messages];
  }
  function renderList() {
    const items = snapshot?.items || [];
    const requested = items.filter((item) => item.reviewRequested);
    const mine = items.filter((item) => item.authoredByMe && item.state === "open");
    const scope = { requested, mine, all: items }[filter];
    const shown = scope.filter(
      (item) =>
        !query ||
        `${repository(item)} ${item.number} ${item.title} ${author(item)}`
          .toLowerCase()
          .includes(query),
    );
    for (const [index, entries] of [requested, mine, items].entries())
      filterCounts[index].textContent = snapshot ? String(entries.length) : "";
    count.textContent =
      shown.length === scope.length ? String(scope.length) : `${shown.length} / ${scope.length}`;
    allButton.setAttribute("aria-pressed", String(filter === "all"));
    mineButton.setAttribute("aria-pressed", String(filter === "mine"));
    requestedButton.setAttribute("aria-pressed", String(filter === "requested"));
    refreshButton.disabled = fetching || Boolean(snapshot?.refreshing);
    refreshButton.textContent = refreshButton.disabled ? "Refreshing…" : "Refresh";
    const hasWarnings = renderListStatus();
    const focusedUrl = list.contains(document.activeElement)
      ? document.activeElement.closest(".review-pr-row")?.dataset.prUrl
      : undefined;
    if (!shown.length) {
      list.replaceChildren(renderEmptyList(hasWarnings));
      return;
    }
    const rows = shown.map(renderRow);
    list.replaceChildren(...rows);
    if (focusedUrl)
      rows.find((row) => row.dataset.prUrl === focusedUrl)?.focus({ preventScroll: true });
  }
  function renderListStatus() {
    const messages = sourceMessages();
    const status = [listError, snapshot?.stale ? "Showing saved results." : "", ...messages].filter(
      Boolean,
    );
    if (!status.length && snapshot?.refreshing) status.push("Updating pull requests…");
    if (!status.length && snapshot?.updatedAt) status.push(`Updated ${date(snapshot.updatedAt)}`);
    listStatus.textContent = status.join(" ");
    listStatus.hidden = !listStatus.textContent;
    listStatus.classList.toggle(
      "has-warning",
      Boolean(listError || messages.length || snapshot?.stale),
    );
    return messages.length > 0;
  }
  function renderEmptyList(hasWarnings) {
    const empty = element("div", "review-pr-empty");
    let label = "No pull requests yet";
    if ((!snapshot && fetching) || snapshot?.refreshing) label = "Loading pull requests…";
    else if (query) label = "No matching pull requests";
    else if (filter === "requested") label = "No pull requests waiting for your review";
    else if (filter === "mine") label = "You have no open pull requests";
    empty.append(element("p", "", label));
    if (!query && !fetching && !snapshot?.refreshing) {
      empty.append(
        element(
          "p",
          "subtitle",
          listError || hasWarnings
            ? "Resolve the connection issue above, then refresh."
            : "Pull requests from your repositories and requests for your review appear here.",
        ),
      );
    }
    return empty;
  }
  function renderRow(item) {
    const row = button("review-pr-row", "", () => void open(item.url));
    row.dataset.prUrl = item.url;
    row.setAttribute("aria-pressed", String(detailVisible && item.url === activeUrl));
    const meta = element("span", "review-pr-row-meta", `${repository(item)} · #${item.number}`);
    const rowTitle = element("span", "review-pr-row-title", item.title);
    const statuses = element("span", "review-pr-row-status");
    statuses.append(chip(stateLabel(item), stateTone(item)));
    if (item.reviewRequested) statuses.append(chip("Review requested", "attention"));
    else if (REVIEW_LABELS[item.reviewDecision]) {
      statuses.append(chip(REVIEW_LABELS[item.reviewDecision], reviewTone(item.reviewDecision)));
    }
    if (item.checksStatus && item.checksStatus !== "none") {
      statuses.append(
        chip(CHECK_LABELS[item.checksStatus] || "Checks unavailable", item.checksStatus),
      );
    }
    row.append(meta, rowTitle, statuses);
    return row;
  }
  async function refresh({ force = false } = {}) {
    const request = ++listRequest;
    fetching = true;
    listError = "";
    if (!snapshot || force) renderList();
    try {
      const next = await api(`pull-requests${force ? "?refresh=1" : ""}`);
      if (request !== listRequest) return;
      snapshot = next;
    } catch (error) {
      if (request === listRequest)
        listError = error.message || "Could not load pull requests. Try refreshing.";
    } finally {
      if (request === listRequest) {
        fetching = false;
        renderList();
      }
    }
    if (
      request === listRequest &&
      detailVisible &&
      activeUrl &&
      !snapshot?.refreshing &&
      !listError
    ) {
      void loadDetail(activeUrl);
    }
    return snapshot;
  }
  function section(titleText) {
    const node = element("section", "review-pr-section");
    node.append(element("h3", "", titleText));
    return node;
  }
  function renderDetails() {
    if (!detailVisible) return;
    const item = currentItem;
    $("review-pr-changes").disabled = !item;
    identity.replaceChildren(
      item ? renderDetailHeader(item) : element("h2", "review-pr-pending-title", "Pull request"),
    );
    details.replaceChildren();
    if (!item) {
      const empty = element("div", "review-pr-empty");
      empty.append(
        element("p", "", detailLoading ? "Loading pull request…" : "Pull request unavailable"),
      );
      if (detailError) empty.append(element("p", "warning", detailError));
      if (!detailLoading)
        empty.append(
          button("button secondary", "Try again", () => void loadDetail(activeUrl, true)),
        );
      details.append(empty);
      return;
    }
    if (detailError || detailStale) {
      const notice = element(
        "p",
        "review-pr-detail-notice",
        [
          detailError,
          detailStale
            ? `Showing saved details${date(detailUpdatedAt) ? ` from ${date(detailUpdatedAt)}` : ""}.`
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
      notice.setAttribute("role", "status");
      details.append(notice);
    }
    details.append(renderStats(item));
    const actions = element("div", "review-pr-detail-actions");
    const refreshDetailsButton = button(
      "button quiet",
      detailLoading ? "Refreshing…" : "Refresh details",
      () => void loadDetail(item.url, true),
    );
    refreshDetailsButton.disabled = detailLoading;
    actions.append(refreshDetailsButton);
    for (const task of item.taskLinks ?? []) {
      actions.append(button("button quiet", task.title, () => openTask(task.id)));
    }
    details.append(actions);
    const description = section("Description");
    const missing = detailLoading ? "Loading description…" : "No description provided.";
    description.append(renderMarkdown(item.bodyHtml, text(item.body) || missing));
    details.append(description);
    details.append(renderChecks(item));
    if (item.discussionNotice) details.append(renderDiscussion(item));
  }
  function renderDetailHeader(item) {
    const header = element("header", "review-pr-detail-heading");
    const context = element("p", "context-label", `${repository(item)} · #${item.number}`);
    const detailTitle = element("h2", "", item.title);
    const metadata = element(
      "p",
      "subtitle",
      [
        author(item) ? `Opened by ${author(item)}` : "",
        item.updatedAt ? `Updated ${date(item.updatedAt)}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    );
    header.append(context, detailTitle, metadata);
    const state = element("div", "review-pr-detail-state");
    state.append(chip(stateLabel(item), stateTone(item)));
    if (item.reviewRequested) state.append(chip("Your review requested", "attention"));
    if (REVIEW_LABELS[item.reviewDecision])
      state.append(chip(REVIEW_LABELS[item.reviewDecision], reviewTone(item.reviewDecision)));
    if (item.mergeable === "CONFLICTING") state.append(chip("Merge conflicts", "failure"));
    header.append(state);
    return header;
  }
  function renderStats(item) {
    const comparison = element("div", "review-pr-comparison");
    if (item.headRefName || item.baseRefName)
      comparison.append(
        element("code", "", `${item.headRefName || "Head"} → ${item.baseRefName || "Base"}`),
      );
    const stats = [
      Number.isFinite(item.changedFiles) ? `${item.changedFiles} files` : "",
      Number.isFinite(item.additions) ? `+${item.additions}` : "",
      Number.isFinite(item.deletions) ? `−${item.deletions}` : "",
    ].filter(Boolean);
    if (stats.length) comparison.append(element("span", "review-pr-diff-stat", stats.join(" · ")));
    comparison.hidden = !comparison.childNodes.length;
    return comparison;
  }
  function renderChecks(item) {
    const checks = section(CHECK_LABELS[item.checksStatus] || "Checks");
    if (item.checksError) checks.append(element("p", "warning", item.checksError));
    if (item.checks?.length) {
      const rows = element("div", "review-pr-check-list");
      for (const check of item.checks) {
        const row = element("div", "review-pr-check-row");
        const label = element("div", "review-pr-check-name");
        label.append(element("span", "", check.name || "Check"));
        if (check.workflow) label.append(element("span", "subtitle", check.workflow));
        row.append(
          label,
          chip(
            { success: "Passed", failure: "Failed", pending: "Running" }[check.status] ||
              CHECK_LABELS[check.status] ||
              "Unknown",
            check.status,
          ),
        );
        rows.append(row);
      }
      checks.append(rows);
    } else {
      let message = "Check details are unavailable. Refresh to try again.";
      if (detailLoading) message = "Loading checks…";
      else if (item.checksStatus === "none") message = "No checks reported for this pull request.";
      checks.append(element("p", "subtitle", message));
    }
    return checks;
  }
  function renderMarkdown(html, fallback) {
    const body = element("div", "review-pr-body", fallback);
    // The local API renders Markdown with raw HTML, images and link navigation disabled.
    if (html) {
      body.classList.add("review-pr-markdown");
      body.innerHTML = html;
    }
    return body;
  }
  function renderDiscussion(item) {
    const discussion = section("Conversation");
    if (!item.discussion?.length)
      discussion.append(element("p", "subtitle", "No comments or reviews yet."));
    for (const entry of item.discussion ?? []) {
      const card = element("article", "review-pr-comment");
      const who = element("strong", "", entry.author || "GitHub user");
      const kind =
        entry.kind === "review" ? REVIEW_LABELS[entry.state?.toLowerCase()] || "Review" : "Comment";
      const context = element(
        "span",
        "subtitle",
        [kind, date(entry.createdAt)].filter(Boolean).join(" · "),
      );
      const header = element("div", "review-pr-comment-header");
      header.append(who, context);
      card.append(header);
      if (entry.body) card.append(renderMarkdown(entry.bodyHtml, entry.body));
      discussion.append(card);
    }
    discussion.append(element("p", "subtitle", "Inline review threads are unavailable here."));
    return discussion;
  }
  async function loadDetail(url, force = false) {
    if (!url) return;
    const request = ++detailRequest;
    detailLoading = true;
    detailError = "";
    renderDetails();
    try {
      const result = await api(
        `pull-request?${new URLSearchParams({ url, ...(force ? { refresh: "1" } : {}) })}`,
      );
      if (request !== detailRequest || activeUrl !== url) return;
      if (result.item) currentItem = result.item;
      detailError = result.error || "";
      detailStale = Boolean(result.stale);
      detailUpdatedAt = result.updatedAt;
      if (!result.item && !detailError)
        detailError = "Pull request details are unavailable. Try refreshing.";
    } catch (error) {
      if (request === detailRequest && activeUrl === url) {
        detailError = error.message || "Could not load pull request details. Try refreshing.";
        detailStale = Boolean(currentItem);
      }
    } finally {
      if (request === detailRequest && activeUrl === url) {
        detailLoading = false;
        renderDetails();
      }
    }
  }
  async function open(url) {
    if (!url) return;
    const changed = activeUrl !== url;
    activeUrl = url;
    detailVisible = true;
    if (changed) {
      currentItem = snapshot?.items.find((item) => item.url === url);
      detailStale = false;
      detailUpdatedAt = undefined;
      detailError = "";
      details.scrollTop = 0;
    }
    showDetails();
    renderList();
    await loadDetail(url);
  }
  function close() {
    detailVisible = false;
    ++detailRequest;
    detailLoading = false;
    renderList();
  }
  function showChanges() {
    if (detailVisible && currentItem) openDiff(currentItem);
  }
  return { refresh, open, close, setFilter, showChanges };
}
