// Pimi. Apache-2.0.
const imageTypes = new Set(["image/png", "image/jpeg", "image/webp"]);

function imageInput(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("error", () => reject(new Error("Couldn’t read the pasted image.")), {
      once: true,
    });
    reader.addEventListener(
      "load",
      () => {
        resolve({ action: "add-image", mime: file.type, data: reader.result.split(",", 2)[1] });
      },
      { once: true },
    );
    reader.readAsDataURL(file);
  });
}

function imageUrl(id) {
  return "/api/spaces/image?id=" + encodeURIComponent(id);
}

function inlineEmbed(url) {
  if (typeof url !== "string") return null;
  if (/^https:\/\/www\.youtube-nocookie\.com\/embed\/[A-Za-z0-9_-]{11}$/.test(url)) {
    return { kind: "youtube", name: "YouTube", title: "YouTube video player", icon: "video", url };
  }
  if (
    /^https:\/\/platform\.twitter\.com\/embed\/Tweet\.html\?id=[1-9]\d{0,19}&dnt=true$/.test(url)
  ) {
    return { kind: "x", name: "X", title: "X post", icon: "link", url };
  }
  if (
    /^https:\/\/arxiv\.org\/html\/(?:\d{2}(?:0[1-9]|1[0-2])\.\d{4,5}|[a-z][a-z-]*(?:\.[A-Z]{2})?\/\d{2}(?:0[1-9]|1[0-2])\d{3})(?:v[1-9]\d*)?$/.test(
      url,
    )
  ) {
    return { kind: "arxiv", name: "arXiv", title: "arXiv paper", icon: "paper", url };
  }
  return null;
}

function githubRepository(url) {
  if (url.origin !== "https://github.com" || url.username || url.password) return null;
  const match = /^\/([A-Za-z\d][A-Za-z\d-]{0,38})\/([\w.-]{1,100})\/?$/.exec(url.pathname);
  return match ? `${match[1]}/${match[2]}` : null;
}

export function createSpacesView({ $, api, button, element, message }) {
  const section = $("spaces");
  const grid = $("spaces-items");
  const searchInput = $("spaces-search");
  const editor = $("spaces-card-dialog");
  const confirmation = $("spaces-remove-dialog");
  const form = $("spaces-card-form");
  const text = $("spaces-note-text");
  const preview = $("spaces-card-image");
  const reader = $("spaces-paper-reader");
  const paperUnavailable = $("spaces-paper-unavailable");
  const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
  let current;
  let active = false;
  let suspended = false;
  let busy = false;
  let mutating = false;
  let ready = false;
  let searchTimer;
  let searchGeneration = 0;
  let searchPending = false;
  let copyTimer;
  let feedback;
  const sources = new WeakMap();
  const signatures = new WeakMap();
  const unavailablePapers = new Set();

  function embedFrame(embed) {
    const frame = element("iframe");
    frame.title = embed.title;
    frame.setAttribute("sandbox", embed.kind === "arxiv" ? "" : "allow-scripts allow-same-origin");
    frame.setAttribute("credentialless", "");
    frame.setAttribute(
      "allow",
      embed.kind === "youtube" ? "autoplay 'none'; encrypted-media; fullscreen" : "autoplay 'none'",
    );
    frame.referrerPolicy = "no-referrer";
    frame.src = embed.url;
    return frame;
  }

  // A card shows a static poster; the iframe exists only after a click, and goes back to the
  // poster when it scrolls away or Spaces is hidden, so a view switch never reloads an embed.
  function fillPoster(slot) {
    observer.unobserve(slot);
    const embed = sources.get(slot);
    if (embed.kind === "arxiv") {
      const label = element("span", "spaces-embed-label");
      label.append($("spaces-paper-icon").content.cloneNode(true), "arXiv paper");
      slot.replaceChildren(label);
      return;
    }
    const play = button("spaces-embed-play", "", () => {
      slot.replaceChildren(embedFrame(embed));
      observer.observe(slot);
    });
    play.setAttribute("aria-label", embed.kind === "youtube" ? "Play video" : "Show post");
    if (embed.kind === "youtube") {
      const image = element("img");
      image.alt = "";
      image.loading = "lazy";
      image.decoding = "async";
      image.src = "/api/spaces/poster?v=" + embed.url.split("/").pop();
      image.addEventListener("error", () => image.remove(), { once: true });
      play.append(image);
    }
    const glyph = element("span", "spaces-embed-glyph");
    glyph.append($("spaces-video-icon").content.cloneNode(true));
    if (embed.kind === "x") glyph.append("Show post");
    play.append(glyph);
    slot.replaceChildren(play);
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const { target, isIntersecting, intersectionRatio } of entries) {
        if ((!isIntersecting || intersectionRatio === 0) && target.querySelector("iframe"))
          fillPoster(target);
      }
    },
    { threshold: 0.01 },
  );

  function updateEmbedVisibility() {
    if (!active || document.hidden) {
      for (const frame of grid.querySelectorAll(".spaces-embed iframe"))
        fillPoster(frame.parentElement);
    }
    updatePaperReader();
  }

  function updatePaperReader() {
    const embed = current?.kind === "link" ? inlineEmbed(current.embedUrl) : null;
    const paper = embed?.kind === "arxiv" ? embed : null;
    const unavailable = paper && unavailablePapers.has(paper.url);
    paperUnavailable.hidden = !unavailable;
    const show = paper && !unavailable && active && editor.open && !document.hidden;
    reader.hidden = !show;
    if (!show) reader.replaceChildren();
    else if (reader.firstElementChild?.src !== paper.url) reader.replaceChildren(embedFrame(paper));
  }

  function resume() {
    active = true;
    updateEmbedVisibility();
    if (!suspended) return;
    suspended = false;
    editor.showModal();
    updatePaperReader();
  }

  document.addEventListener("visibilitychange", updateEmbedVisibility);

  function showEmpty() {
    $("spaces-empty").hidden = !ready || grid.childElementCount > 0;
    $("spaces-empty-text").textContent = searchInput.value.trim()
      ? "No matching cards."
      : "Your cards will appear here.";
  }

  // A background run only fetches cards. The header, New note and the open editor stay usable
  // while it runs; only Save waits, so a save never races the list that is still arriving.
  function setBusy(value, background) {
    busy = value;
    mutating = value && !background;
    $("spaces-new").disabled = mutating;
    $("spaces-save").disabled = busy;
    for (const id of ["spaces-close", "spaces-remove"]) $(id).disabled = mutating;
    text.readOnly = mutating;
  }

  async function run(action, errorId = "spaces-error", background = false) {
    if (busy) return;
    setBusy(true, background);
    message("spaces-error", "");
    message("spaces-card-error", "");
    message("spaces-status", "");
    try {
      await action();
    } catch (error) {
      message(editor.open ? errorId : "spaces-error", error.message);
    } finally {
      setBusy(false);
      if (searchPending) queueSearch();
    }
  }

  async function copyReference(id, control) {
    try {
      await navigator.clipboard.writeText("space:" + id);
      control.classList.add("spaces-copied");
      control.setAttribute("aria-label", "Copied");
      clearTimeout(copyTimer);
      if (feedback) feedback.hidden = true;
      feedback = $(editor.open ? "spaces-card-copy-feedback" : "spaces-copy-feedback");
      feedback.hidden = false;
      copyTimer = setTimeout(() => {
        feedback.hidden = true;
      }, 1800);
      setTimeout(() => {
        control.classList.remove("spaces-copied");
        control.setAttribute("aria-label", "Copy reference");
      }, 1300);
    } catch {
      message(editor.open ? "spaces-card-error" : "spaces-error", "Couldn’t copy the reference.");
    }
  }

  function showLinkText(item, status = "") {
    const body = $("spaces-card-link-text");
    body.textContent = item?.preview?.text ?? "";
    body.hidden = !body.textContent;
    message("spaces-card-link-status", item?.preview?.truncated ? "Preview excerpt" : status);
    if (item?.preview?.title) $("spaces-card-title").textContent = item.preview.title;
  }

  async function loadLinkText(item) {
    try {
      const { item: loaded } = await api("spaces", { action: "preview-link", id: item.id });
      if (!editor.open || current?.id !== item.id) return;
      current = loaded;
      showLinkText(loaded, loaded.preview ? "" : "Link text unavailable.");
      const caption = $("space-card-" + item.id)?.querySelector(".spaces-link-caption");
      if (caption && loaded.preview) {
        if (loaded.preview.title)
          caption.querySelector("strong").textContent = loaded.preview.title;
        const summary = caption.querySelector(".spaces-link-summary");
        summary.textContent = loaded.preview.text;
        summary.hidden = !loaded.preview.text;
      }
    } catch {
      if (editor.open && current?.id === item.id) showLinkText(item, "Couldn’t load link text.");
    }
  }

  function openLinkDetails(item) {
    const link = item?.kind === "link" ? item : null;
    $("spaces-card-link").hidden = !link;
    $("spaces-card-url").textContent = link?.url ?? "";
    $("spaces-open-link").dataset.spaceUrl = link?.url ?? "";
    showLinkText(link, link && !link.preview ? "Loading link text…" : "");
    if (link && !link.preview) void loadLinkText(link);
  }

  function openCard(item, draftText = "") {
    current = item;
    const isImage = item?.kind === "image";
    const isLink = item?.kind === "link";
    const isNote = !isImage && !isLink;
    const paper = isLink && inlineEmbed(item.embedUrl)?.kind === "arxiv";
    const titles = { note: "Edit note", image: "Image", link: paper ? "arXiv paper" : "Link" };
    editor.classList.toggle("spaces-dialog-paper", paper);
    $("spaces-card-title").textContent = item ? titles[item.kind] : "New note";
    $("spaces-card-reference").textContent = item ? "space:" + item.id : "";
    $("spaces-note-label").hidden = !isNote;
    $("spaces-save").hidden = !isNote;
    text.required = isNote;
    text.value = item?.text ?? draftText;
    preview.hidden = !isImage;
    if (isImage) preview.src = imageUrl(item.id);
    else preview.removeAttribute("src");
    $("spaces-remove").hidden = !item;
    $("spaces-copy").hidden = !item;
    $("spaces-close").textContent = isNote ? "Cancel" : "Close";
    message("spaces-card-error", "");
    editor.showModal();
    openLinkDetails(item);
    updatePaperReader();
    (isNote ? text : $("spaces-close")).focus();
  }

  function card(item) {
    const node = element("article", "spaces-card spaces-card-" + item.kind);
    node.id = "space-card-" + item.id;
    const open = button("spaces-card-body", "", () => openCard(item));
    if (item.kind === "image") {
      open.setAttribute("aria-label", "Open pasted image");
      const img = element("img");
      img.alt = "Pasted image";
      img.loading = "lazy";
      img.src = imageUrl(item.id);
      open.append(img);
    } else if (item.kind === "link") {
      const url = new URL(item.url);
      const embed = inlineEmbed(item.embedUrl);
      const repository = githubRepository(url);
      const title = item.preview?.title || (embed?.name ?? repository ?? url.host);
      const badge = element("span", "spaces-link-icon");
      const icon = embed?.icon ?? (repository ? "repo" : "link");
      badge.append($(`spaces-${icon}-icon`).content.cloneNode(true));
      const caption = element("span", "spaces-link-caption");
      const summary = element("span", "spaces-link-summary", item.preview?.text);
      summary.hidden = !item.preview?.text;
      caption.append(
        element("strong", "", title),
        element("span", "subtitle", repository ? "GitHub repository" : url.host + url.pathname),
        summary,
      );
      open.append(badge, caption);
      if (embed) {
        const slot = element("div", "spaces-embed");
        slot.dataset.embedKind = embed.kind;
        sources.set(slot, embed);
        fillPoster(slot);
        slot.hidden = unavailablePapers.has(embed.url);
        if (embed.kind === "arxiv") {
          const peek = button("spaces-paper-peek", "", () => openCard(item));
          peek.tabIndex = -1;
          peek.setAttribute("aria-label", "Open arXiv paper");
          const previewArea = element("div", "spaces-paper-peek-area");
          previewArea.hidden = slot.hidden;
          previewArea.append(slot, peek);
          node.append(previewArea);
        } else {
          node.append(slot);
        }
      }
    } else {
      open.append(element("span", "spaces-note-preview", item.text));
    }
    const copy = button(
      "button quiet glyph-button spaces-reference",
      "",
      () => void copyReference(item.id, copy),
    );
    copy.setAttribute("aria-label", "Copy reference");
    copy.title = "Copy reference · space:" + item.id;
    copy.append($("spaces-copy-icon").content.cloneNode(true));
    const footer = element("div", "spaces-card-footer");
    const time = element("time", "subtitle", date.format(new Date(item.updatedAt)));
    time.dateTime = item.updatedAt;
    footer.append(time, copy);
    node.append(open, footer);
    return node;
  }

  function removeCard(id) {
    const node = $("space-card-" + id);
    const slot = node?.querySelector(".spaces-embed");
    if (slot) observer.unobserve(slot);
    node?.remove();
    if (searchInput.value.trim()) searchPending = true;
  }

  function insert(item) {
    removeCard(item.id);
    const node = card(item);
    grid.prepend(node);
    showEmpty();
  }

  async function load(action) {
    if (suspended) {
      resume();
      if (!action) return;
    }
    active = true;
    if (action && (editor.open || busy)) {
      message("spaces-status", "Finish the open card first.");
      return;
    }
    if (action?.kind === "search") searchInput.value = action.query;
    if (action && ["saved", "open", "remove"].includes(action.kind)) searchInput.value = "";
    let cards;
    await run(
      async () => {
        unavailablePapers.clear();
        cards = await loadCards();
      },
      "spaces-error",
      true,
    );
    if (active && cards && action) applyLoadedAction(action, cards);
  }

  function applyLoadedAction(action, cards) {
    if (action.kind === "search") {
      searchInput.focus();
      return;
    }
    if (editor.open) return;
    if (action.kind === "draft") openCard(undefined, action.text);
    if (action.kind === "open" || action.kind === "remove") {
      const item = cards.find((entry) => entry.id === action.id);
      if (!item) {
        message("spaces-status", "That card is no longer available.");
        return;
      }
      openCard(item);
      if (action.kind === "remove") confirmRemoval();
    }
  }

  // Reuse the card of every unchanged item so its images stay decoded and its embeds do not
  // reload; only added, edited, removed or moved cards touch the DOM.
  function reconcileCards(items) {
    const existing = new Map();
    for (const node of grid.children) existing.set(node.id, node);
    const wanted = new Set();
    let cursor = grid.firstElementChild;
    for (const item of items) {
      const id = "space-card-" + item.id;
      wanted.add(id);
      const signature = JSON.stringify(item);
      let node = existing.get(id);
      if (!node || signatures.get(node) !== signature) {
        const old = node?.querySelector(".spaces-embed");
        if (old) observer.unobserve(old);
        const next = card(item);
        signatures.set(next, signature);
        if (node) node.replaceWith(next);
        node = next;
        if (cursor === existing.get(id)) cursor = node;
      } else {
        // A reused card follows the cleared list of unavailable papers like a new one would.
        const slot = node.querySelector(".spaces-embed");
        if (slot) {
          slot.hidden = unavailablePapers.has(sources.get(slot).url);
          if (slot.parentElement !== node) slot.parentElement.hidden = slot.hidden;
        }
      }
      if (node === cursor) cursor = cursor.nextElementSibling;
      else grid.insertBefore(node, cursor);
    }
    for (const [id, node] of existing) {
      if (wanted.has(id)) continue;
      const slot = node.querySelector(".spaces-embed");
      if (slot) observer.unobserve(slot);
      node.remove();
    }
  }

  async function loadCards() {
    const generation = ++searchGeneration;
    const query = searchInput.value.trim();
    const result = await api("spaces", query ? { action: "search", query } : { action: "list" });
    if (!active || generation !== searchGeneration || query !== searchInput.value.trim()) return;
    ready = true;
    reconcileCards(result.items);
    if (query && result.unindexedLinks) {
      const count = result.unindexedLinks;
      message(
        "spaces-status",
        `Link text unavailable for ${count} ${count === 1 ? "card" : "cards"}.`,
      );
    } else message("spaces-status", "");
    updateEmbedVisibility();
    showEmpty();
    return result.items;
  }

  function queueSearch() {
    clearTimeout(searchTimer);
    searchGeneration++;
    searchPending = busy;
    if (!active || busy) return;
    searchTimer = setTimeout(async () => {
      const generation = searchGeneration + 1;
      try {
        message("spaces-error", "");
        await loadCards();
      } catch (error) {
        if (active && generation === searchGeneration) message("spaces-error", error.message);
      }
    }, 180);
  }

  searchInput.addEventListener("input", queueSearch);

  document.addEventListener("paste", (event) => {
    if (
      section.hidden ||
      editor.open ||
      event.target.closest?.("input, textarea, [contenteditable]")
    )
      return;
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    const files = [...clipboard.files];
    const note = clipboard.getData("text/plain") || clipboard.getData("text/uri-list");
    if (!files.length && !note.trim()) return;
    event.preventDefault();
    if (busy || !ready) {
      message("spaces-error", "Wait for Spaces to load or finish saving, then paste again.");
      return;
    }
    void run(async () => {
      for (const file of files) {
        if (!imageTypes.has(file.type) || file.size > 4 * 1024 * 1024) {
          throw new Error("Paste a PNG, JPEG or WebP image up to 4 MB.");
        }
      }
      if (files.length) {
        for (const file of files) {
          const { item } = await api("spaces", await imageInput(file));
          insert(item);
        }
      } else {
        const { item } = await api("spaces", { action: "add-note", text: note });
        insert(item);
      }
      message("spaces-status", "Added to Spaces.");
    });
  });

  $("spaces-new").addEventListener("click", () => openCard());
  $("spaces-close").addEventListener("click", () => editor.close());
  window.pimiWorkspace?.onSpaceLinkError(() => {
    message("spaces-card-error", "Couldn’t open this link in your browser.");
  });
  window.pimiWorkspace?.onPaperUnavailable?.((url) => {
    if (inlineEmbed(url)?.kind !== "arxiv") return;
    unavailablePapers.add(url);
    for (const slot of grid.querySelectorAll('.spaces-embed[data-embed-kind="arxiv"]')) {
      if (sources.get(slot)?.url !== url) continue;
      observer.unobserve(slot);
      slot.replaceChildren();
      slot.hidden = true;
      slot.parentElement.hidden = true;
    }
    updatePaperReader();
  });
  $("spaces-copy").addEventListener(
    "click",
    (event) => void copyReference(current.id, event.currentTarget),
  );
  function confirmRemoval() {
    confirmation.returnValue = "";
    confirmation.showModal();
  }
  $("spaces-remove").addEventListener("click", confirmRemoval);
  confirmation.addEventListener("close", () => {
    if (confirmation.returnValue !== "remove" || !current) return;
    const { id } = current;
    void run(async () => {
      await api("spaces", { action: "remove", id });
      removeCard(id);
      editor.close();
      suspended = false;
      showEmpty();
      $("spaces-new").focus();
      message("spaces-status", "Card removed.");
    }, "spaces-card-error");
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (current && current.kind !== "note") return;
    void run(async () => {
      const request = current
        ? { action: "edit-note", id: current.id, text: text.value }
        : { action: "add-note", text: text.value };
      const { item } = await api("spaces", request);
      insert(item);
      editor.close();
      suspended = false;
      $("space-card-" + item.id)
        .querySelector("button")
        .focus();
      message("spaces-status", "Note saved.");
    }, "spaces-card-error");
  });
  editor.addEventListener("cancel", (event) => {
    if (mutating) event.preventDefault();
  });
  editor.addEventListener("close", updatePaperReader);

  return {
    load,
    resume,
    suspend() {
      active = false;
      clearTimeout(searchTimer);
      searchGeneration++;
      searchPending = false;
      updateEmbedVisibility();
      if (!editor.open) return;
      confirmation.close();
      editor.close();
      updatePaperReader();
      suspended = true;
    },
  };
}
