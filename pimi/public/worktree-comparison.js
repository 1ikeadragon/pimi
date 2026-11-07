// Pimi addition to the Paseo fork. Apache-2.0.
export function createWorktreeComparison({
  $,
  api,
  element,
  button,
  formatPatch,
  baseForWorktree,
}) {
  const host = $("comparison-review");
  let cards = [];
  let primary;
  let current;
  let generation = 0;
  let fileGeneration = 0;
  let targetPath = "";
  const heading = element("div", "comparison-heading");
  const title = element("h2", "", "Alongside this worktree");
  heading.append(title, button("icon-button", "Close", close));
  const form = element("form", "comparison-form");
  const picker = element("select", "");
  picker.id = "comparison-worktree";
  picker.required = true;
  const base = element("input", "");
  base.id = "comparison-base";
  base.placeholder = "Auto-detect base";
  const mode = element("select", "");
  mode.id = "comparison-mode";
  mode.append(
    new Option("Branch + working changes", "all"),
    new Option("Committed changes", "committed"),
    new Option("Working changes only", "working"),
  );
  function field(caption, control) {
    const label = element("label", "", caption);
    label.append(control);
    return label;
  }
  const baseField = field("Base ref", base);
  const submit = element("button", "button secondary", "Load changes");
  submit.type = "submit";
  form.append(field("Worktree", picker), field("Comparison", mode), baseField, submit);
  const settings = element("details", "comparison-controls");
  settings.append(element("summary", "button quiet", "Comparison settings…"), form);
  settings.open = true;
  const provenance = element("p", "subtitle comparison-provenance");
  const status = element("p", "subtitle");
  status.setAttribute("role", "status");
  const files = element("select", "comparison-files");
  files.id = "comparison-file";
  files.setAttribute("aria-label", "Changed file in second worktree");
  files.hidden = true;
  const content = element("div", "patch comparison-patch");
  content.tabIndex = 0;
  host.append(heading, settings, provenance, status, files, content);

  function close() {
    resetResult();
    targetPath = "";
    picker.value = "";
    base.value = "";
    host.hidden = true;
    $("review-columns").classList.remove("comparing");
  }

  function renderOptions() {
    const previous = picker.value || targetPath;
    const available = cards.filter((card) => !card.unavailable && card.path !== primary?.path);
    const label = (card) => `${card.repo} · ${card.name}`;
    const counts = new Map();
    for (const card of available) counts.set(label(card), (counts.get(label(card)) ?? 0) + 1);
    picker.replaceChildren(
      new Option("Choose another worktree", ""),
      ...available.map((card) => {
        const name = label(card);
        const option = new Option(
          counts.get(name) > 1 ? `${name} — ${card.path}` : name,
          card.path,
        );
        option.title = card.path;
        return option;
      }),
    );
    if ([...picker.options].some((option) => option.value === previous)) picker.value = previous;
    submit.disabled = !picker.value;
  }

  function resetResult() {
    ++generation;
    ++fileGeneration;
    current = undefined;
    title.textContent = "Alongside this worktree";
    title.removeAttribute("title");
    provenance.textContent = "";
    provenance.hidden = true;
    files.hidden = true;
    files.replaceChildren();
    content.replaceChildren();
    status.textContent = "Choose a worktree and load its changes.";
  }

  async function showFile() {
    const request = ++fileGeneration;
    const review = current;
    const path = files.value;
    if (!review || !path) return;
    content.setAttribute("aria-label", `Diff for ${path} in ${targetPath}`);
    content.replaceChildren(element("p", "empty", "Loading diff…"));
    try {
      const { patch } = await api("file?" + new URLSearchParams({ id: review.id, path }));
      if (request !== fileGeneration || current !== review) return;
      if (patch.length > 400_000) {
        content.replaceChildren(
          element("p", "empty", "This patch exceeds the 400,000 character display limit."),
        );
      } else if (!patch) {
        content.replaceChildren(
          element("p", "empty", "No patch available. Reload changes if the checkout changed."),
        );
      } else {
        formatPatch(patch, content);
      }
    } catch (error) {
      if (request === fileGeneration) content.replaceChildren(element("p", "empty", error.message));
    }
  }

  async function load() {
    const card = cards.find((entry) => entry.path === picker.value && !entry.unavailable);
    if (!card || card.path === primary?.path) return;
    resetResult();
    const request = generation;
    targetPath = card.path;
    submit.disabled = true;
    status.textContent = "Loading changes…";
    try {
      const result = await api("review", {
        path: card.path,
        mode: mode.value,
        baseRef: base.value.trim(),
        prUrl: "",
      });
      if (request !== generation) return;
      current = result;
      title.textContent = `${card.repo} · ${card.name}`;
      title.title = card.path;
      provenance.textContent = card.branch !== card.name ? card.branch : "";
      provenance.hidden = !provenance.textContent;
      settings.open = false;
      status.textContent = [
        `${result.base.sha.slice(0, 8)} → ${result.head.slice(0, 8)}`,
        result.live ? "Includes tracked working changes" : "Pinned commits",
        result.untracked ? `${result.untracked} untracked files excluded` : "",
        !result.files.length ? "No changed files" : "",
      ]
        .filter(Boolean)
        .join(" · ");
      status.title = `${result.base.label} (${result.base.sha}) → ${result.head}`;
      files.replaceChildren(
        ...result.files.map((file) => new Option(`${file.status} ${file.path}`, file.path)),
      );
      files.hidden = !result.files.length;
      if (result.files.length) void showFile();
      else content.replaceChildren(element("p", "empty", "No changed files for this comparison."));
    } catch (error) {
      if (request === generation) status.textContent = error.message;
    } finally {
      if (request === generation) submit.disabled = !picker.value;
    }
  }

  picker.addEventListener("change", () => {
    resetResult();
    targetPath = picker.value;
    const card = cards.find((entry) => entry.path === targetPath);
    base.value = card ? baseForWorktree(card) : "";
    submit.disabled = !card;
  });
  mode.addEventListener("change", () => {
    baseField.hidden = mode.value === "working";
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void load();
  });
  files.addEventListener("change", () => void showFile());

  return {
    close,
    setBoard(next) {
      cards = next;
      renderOptions();
    },
    setPrimary(card) {
      primary = card;
      if (targetPath === card?.path) close();
      renderOptions();
    },
    open(card, pinnedBase = "") {
      host.hidden = false;
      $("review-columns").classList.add("comparing");
      renderOptions();
      if (card && card.path !== primary?.path) {
        picker.value = card.path;
        base.value = pinnedBase;
        mode.value = "all";
        baseField.hidden = false;
        void load();
      } else {
        settings.open = true;
        picker.focus();
      }
    },
  };
}
