// Pimi addition to the Paseo fork. Apache-2.0.
export function createReviewFiles({ $, api, button, element, openFile }) {
  const search = $("review-source-search");
  const list = $("review-source-list");
  let current;
  let request;
  let tree;
  let paths;
  let directory = "";

  function row(path, isDirectory) {
    const parts = path.split("/");
    const item = button("review-target-row review-source-row", "", () => {
      if (isDirectory) {
        directory = path;
        render();
        list.querySelector("button")?.focus();
      } else {
        openFile(path);
      }
    });
    item.title = path;
    const glyph = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    glyph.setAttribute("class", "glyph");
    glyph.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", isDirectory ? "#glyph-folder" : "#glyph-review");
    glyph.append(use);
    const title = element("strong", "", parts.at(-1));
    const text = element("span", "review-source-path");
    text.append(title);
    if (search.value && parts.length > 1)
      text.append(element("span", "", parts.slice(0, -1).join("/")));
    item.append(glyph, text);
    return item;
  }

  function render() {
    if (!paths) return;
    const term = search.value.trim().toLowerCase();
    if (term) {
      const matches = paths.filter((path) => path.toLowerCase().includes(term));
      const shown = matches.slice(0, 200);
      list.replaceChildren(...shown.map((path) => row(path, false)));
      if (!shown.length) list.append(element("p", "empty", "No matching files"));
      if (shown.length < matches.length)
        list.append(element("p", "empty", "Refine your search to see more files."));
      return;
    }
    const entries = tree.get(directory) ?? tree.get("");
    const rows = [];
    if (directory) {
      const up = button("review-target-row review-parent-folder", "", () => {
        directory = directory.split("/").slice(0, -1).join("/");
        render();
        list.querySelector("button")?.focus();
      });
      up.append(element("strong", "", "‹ Parent folder"), element("span", "", directory));
      rows.push(up);
    }
    const folders = [...(entries?.folders ?? [])];
    const files = entries?.files ?? [];
    for (const path of folders.slice(0, 200)) rows.push(row(path, true));
    for (const path of files.slice(0, 200 - Math.min(200, folders.length)))
      rows.push(row(path, false));
    if (folders.length + files.length > 200) {
      rows.push(element("p", "empty", "Search to see more files in this checkout."));
    }
    if (!rows.length) rows.push(element("p", "empty", "No source files in this checkout"));
    list.replaceChildren(...rows);
  }

  function index(files) {
    const directories = new Map();
    function entry(path) {
      if (!directories.has(path)) directories.set(path, { folders: new Set(), files: [] });
      return directories.get(path);
    }
    for (const file of files) {
      const parts = file.split("/");
      let parent = "";
      for (const part of parts.slice(0, -1)) {
        const child = parent ? parent + "/" + part : part;
        entry(parent).folders.add(child);
        parent = child;
      }
      entry(parent).files.push(file);
    }
    return directories;
  }

  async function open(id) {
    if (!id || current === id) return;
    current = id;
    request?.abort();
    request = new AbortController();
    list.replaceChildren(element("p", "empty", "Loading files…"));
    try {
      const result = await api(
        "review-files?" + new URLSearchParams({ id }),
        undefined,
        request.signal,
      );
      if (current !== id) return;
      paths = result.paths;
      tree = index(paths);
      if (!tree.has(directory)) directory = "";
      render();
    } catch (error) {
      if (current !== id) return;
      paths = undefined;
      list.replaceChildren(
        element("p", "empty", error.message),
        button("button quiet", "Try again", () => {
          current = undefined;
          void open(id);
        }),
      );
    }
  }

  search.addEventListener("input", render);
  search.addEventListener("keydown", (event) => {
    if (event.key === "Enter") list.querySelector("button")?.click();
  });
  return {
    open,
    reset() {
      request?.abort();
      current = undefined;
      paths = undefined;
      tree = undefined;
      directory = "";
      search.value = "";
      list.replaceChildren();
    },
  };
}
