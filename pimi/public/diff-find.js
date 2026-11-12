// Pimi. Apache-2.0.
export function createDiffFind($) {
  const bar = $("diff-find");
  const field = $("diff-find-input");
  const output = $("diff-find-status");
  const previous = $("diff-find-prev");
  const next = $("diff-find-next");
  const panes = $("review-columns");
  let matches = [];
  let active = -1;
  let returnFocus;

  function select(index) {
    matches[active]?.classList.remove("find-current");
    active = index;
    const match = matches[active];
    if (match) {
      match.classList.add("find-current");
      match.scrollIntoView({ block: "center", inline: "nearest" });
    }
    if (!field.value.trim()) output.textContent = "";
    else
      output.textContent = match ? `${active + 1} of ${matches.length} lines` : "No matching lines";
    previous.disabled = next.disabled = !match;
  }

  function search() {
    const current = matches[active];
    for (const line of matches) line.classList.remove("find-match", "find-current");
    const query = field.value.trim().toLowerCase();
    matches = query
      ? [...panes.querySelectorAll(".patch-line")].filter(
          (line) =>
            !line.closest("[hidden]") &&
            line.lastElementChild?.textContent.toLowerCase().includes(query),
        )
      : [];
    for (const line of matches) line.classList.add("find-match");
    active = -1;
    select(matches.length ? Math.max(0, matches.indexOf(current)) : -1);
  }

  const changes = new MutationObserver(search);
  function close(restoreFocus = false) {
    if (bar.hidden) return;
    changes.disconnect();
    for (const line of matches) line.classList.remove("find-match", "find-current");
    matches = [];
    active = -1;
    bar.hidden = true;
    if (restoreFocus && returnFocus?.isConnected) returnFocus.focus();
  }

  function open() {
    if (bar.hidden) {
      returnFocus = document.activeElement;
      bar.hidden = false;
      changes.observe(panes, { childList: true, subtree: true });
      search();
    }
    field.focus();
    field.select();
  }

  function move(delta) {
    if (matches.length) select((active + delta + matches.length) % matches.length);
  }

  $("show-diff-find").addEventListener("click", open);
  $("diff-find-close").addEventListener("click", () => close(true));
  previous.addEventListener("click", () => move(-1));
  next.addEventListener("click", () => move(1));
  field.addEventListener("input", search);
  field.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    move(event.shiftKey ? -1 : 1);
  });
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || $("review").hidden || $("review-desk").hidden) return;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      open();
    } else if (event.key === "Escape" && !bar.hidden) {
      event.preventDefault();
      close(true);
    }
  });

  return { close };
}
