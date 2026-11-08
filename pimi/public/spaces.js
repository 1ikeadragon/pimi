// Pimi addition to the Paseo fork. Apache-2.0.
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

export function createSpacesView({ $, api, button, element, message }) {
  const section = $("spaces");
  const grid = $("spaces-items");
  const editor = $("spaces-card-dialog");
  const confirmation = $("spaces-remove-dialog");
  const form = $("spaces-card-form");
  const text = $("spaces-note-text");
  const preview = $("spaces-card-image");
  const player = $("spaces-video-player");
  const play = $("spaces-play");
  const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
  let current;
  let suspended = false;
  let busy = false;
  let ready = false;

  function showEmpty() {
    $("spaces-empty").hidden = !ready || grid.childElementCount > 0;
  }

  function setBusy(value) {
    busy = value;
    $("spaces-new").disabled = value || !ready;
    for (const id of ["spaces-save", "spaces-close", "spaces-remove"]) $(id).disabled = value;
    text.readOnly = value;
  }

  async function run(action, errorId = "spaces-error") {
    if (busy) return;
    setBusy(true);
    message("spaces-error", "");
    message("spaces-card-error", "");
    message("spaces-status", "");
    try {
      await action();
    } catch (error) {
      message(editor.open ? errorId : "spaces-error", error.message);
    } finally {
      setBusy(false);
    }
  }

  async function copyReference(id, control) {
    try {
      await navigator.clipboard.writeText("space:" + id);
      control.classList.add("spaces-copied");
      control.setAttribute("aria-label", "Copied");
      message("spaces-status", "Reference copied.");
      setTimeout(() => {
        control.classList.remove("spaces-copied");
        control.setAttribute("aria-label", "Copy reference");
      }, 1300);
    } catch {
      message(editor.open ? "spaces-card-error" : "spaces-error", "Couldn’t copy the reference.");
    }
  }

  function openCard(item) {
    current = item;
    const isImage = item?.kind === "image";
    const isLink = item?.kind === "link";
    const isNote = !isImage && !isLink;
    const titles = { note: "Edit note", image: "Image", link: "Link" };
    $("spaces-card-title").textContent = item ? titles[item.kind] : "New note";
    $("spaces-card-reference").textContent = item ? "space:" + item.id : "";
    $("spaces-note-label").hidden = !isNote;
    $("spaces-save").hidden = !isNote;
    text.required = isNote;
    text.value = item?.text ?? "";
    preview.hidden = !isImage;
    if (isImage) preview.src = imageUrl(item.id);
    else preview.removeAttribute("src");
    $("spaces-remove").hidden = !item;
    $("spaces-copy").hidden = !item;
    $("spaces-card-link").hidden = !isLink;
    $("spaces-card-url").textContent = item?.url ?? "";
    $("spaces-open-link").dataset.spaceUrl = item?.url ?? "";
    play.hidden = !item?.embedUrl;
    $("spaces-close").textContent = isNote ? "Cancel" : "Close";
    message("spaces-card-error", "");
    editor.showModal();
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
      const title = item.embedUrl ? "YouTube" : url.host;
      const badge = element("span", "spaces-link-icon");
      badge.append(
        $(item.embedUrl ? "spaces-video-icon" : "spaces-link-icon").content.cloneNode(true),
      );
      const caption = element("span", "spaces-link-caption");
      caption.append(
        element("strong", "", title),
        element("span", "subtitle", url.host + url.pathname),
      );
      open.append(badge, caption);
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

  function insert(item) {
    $("space-card-" + item.id)?.remove();
    grid.prepend(card(item));
    showEmpty();
  }

  function load() {
    if (suspended) {
      suspended = false;
      editor.showModal();
      return;
    }
    return run(async () => {
      const { items } = await api("spaces", { action: "list" });
      ready = true;
      grid.replaceChildren(...items.map(card));
      showEmpty();
    });
  }

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
  play.addEventListener("click", (event) => {
    if (!event.isTrusted || !current?.embedUrl) return;
    const frame = element("iframe", "spaces-video-frame");
    frame.title = "YouTube video player";
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
    frame.setAttribute("credentialless", "");
    frame.setAttribute("allow", "encrypted-media; fullscreen");
    frame.referrerPolicy = "no-referrer";
    frame.src = current.embedUrl;
    player.replaceChildren(frame);
    play.hidden = true;
    frame.focus();
  });
  window.pimiWorkspace?.onSpaceLinkError(() => {
    message("spaces-card-error", "Couldn’t open this link in your browser.");
  });
  editor.addEventListener("close", () => {
    player.replaceChildren();
    play.hidden = !current?.embedUrl;
  });
  $("spaces-copy").addEventListener(
    "click",
    (event) => void copyReference(current.id, event.currentTarget),
  );
  $("spaces-remove").addEventListener("click", () => {
    confirmation.returnValue = "";
    confirmation.showModal();
  });
  confirmation.addEventListener("close", () => {
    if (confirmation.returnValue !== "remove" || !current) return;
    const { id } = current;
    void run(async () => {
      await api("spaces", { action: "remove", id });
      $("space-card-" + id)?.remove();
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
    if (busy) event.preventDefault();
  });

  return {
    load,
    suspend() {
      if (!editor.open) return;
      confirmation.close();
      editor.close();
      suspended = true;
    },
  };
}
