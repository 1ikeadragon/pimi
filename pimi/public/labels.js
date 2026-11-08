// Shared Paseo label definitions are supplied by the daemon; only assignments live here.
const key = (name) => name.replace(/\s+/g, " ").trim().toLowerCase();

export function labelChips(names = [], catalog = [], linked = []) {
  const group = document.createElement("span");
  group.className = "label-chips";
  const definitions = new Map(catalog.map((label) => [key(label.name), label]));
  const direct = new Set(names.map(key));
  const visible = new Map([...names, ...linked].map((name) => [key(name), name]));
  for (const name of visible.values()) {
    const definition = definitions.get(key(name));
    const chip = document.createElement("span");
    chip.className = "label-chip";
    if (definition) chip.dataset.color = definition.color;
    chip.textContent = definition?.name ?? name;
    if (!definition) chip.title = "Label is no longer in the catalog";
    else if (!direct.has(key(name))) chip.title = "From linked work";
    group.append(chip);
  }
  group.hidden = !group.childElementCount;
  return group;
}

export function labelPicker({ names = [], catalog = [], error, title = "Labels", onChange }) {
  const picker = document.createElement("details");
  picker.className = "label-picker";
  const summary = document.createElement("summary");
  summary.className = "button quiet label-picker-toggle";
  summary.textContent = title;
  const panel = document.createElement("div");
  panel.className = "label-picker-options";
  const selected = new Set(names.map(key));
  const definitions = [...catalog];
  for (const name of names) {
    if (!definitions.some((label) => key(label.name) === key(name))) definitions.push({ name });
  }
  if (error || !definitions.length) {
    const hint = document.createElement("p");
    hint.className = "subtitle";
    hint.textContent = error || "Create labels from a workspace’s Labels menu.";
    panel.append(hint);
  }
  for (const label of definitions) {
    const row = document.createElement("label");
    row.className = "label-picker-option";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = label.name;
    input.checked = selected.has(key(label.name));
    input.disabled = Boolean(error);
    input.addEventListener("change", async () => {
      const assigned = input.checked;
      const next = assigned
        ? [...names, label.name]
        : names.filter((name) => key(name) !== key(label.name));
      const controls = [...panel.querySelectorAll("input")];
      controls.forEach((control) => {
        control.disabled = true;
      });
      try {
        await onChange(next, label.name, assigned);
        names = next;
      } catch (failure) {
        input.checked = !assigned;
        status.textContent = failure.message;
      } finally {
        controls.forEach((control) => {
          control.disabled = false;
        });
      }
    });
    row.append(input, labelChips([label.name], catalog));
    panel.append(row);
  }
  const status = document.createElement("p");
  status.className = "warning";
  status.setAttribute("role", "status");
  panel.append(status);
  picker.append(summary, panel);
  return picker;
}
