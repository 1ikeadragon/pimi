// Pimi. Apache-2.0.
import { createMemoryView } from "./memory.js";
import { createSpacesView } from "./spaces.js";

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
let viewRequest = 0;
const memoryView = createMemoryView({ $, api, button, element, message });
const spacesView = createSpacesView({ $, api, button, element, message });
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
  const request = ++viewRequest;
  if (name !== "spaces") spacesView.suspend();
  for (const section of ["memory", "spaces"]) {
    $(section).hidden = section !== name;
    const nav = $("show-" + section);
    if (section === name) nav.setAttribute("aria-current", "page");
    else nav.removeAttribute("aria-current");
  }
  window.pimiWorkspace?.setSection(name);
  return request;
}

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
window.pimiWorkspace?.onNavigate(async (destination) => {
  if (destination.view === "spaces") {
    view("spaces");
    await spacesView.load(destination.action);
    return;
  }
  view("memory");
  await memoryView.load(destination.view === "memory" ? destination.projectId : undefined);
});
void memoryView.load();
