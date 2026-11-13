// The macOS confinement rules for Attack's desktop target. Pure functions: nothing here touches
// the system, so every rule can be read in one place. The helper re-checks the chords
// (native/mac/Safety.swift); these run first so a refusal never reaches it.

const FORBIDDEN_BUNDLE_IDS: ReadonlySet<string> = new Set([]);

/** Why a window of this app can never be a target, or null. */
export function forbiddenTarget(bundleId: string): string | null {
  if (FORBIDDEN_BUNDLE_IDS.has(bundleId) || bundleId.startsWith("com.pimi.")) {
    return "That app cannot be driven by an Attack run.";
  }
  return null;
}

export type Modifier = "command" | "control" | "option" | "shift";

export type ParsedChord =
  | { ok: true; modifiers: Modifier[]; keys: string[] }
  | { ok: false; message: string };

const MODIFIER_ALIASES: Record<string, Modifier> = {
  cmd: "command",
  command: "command",
  meta: "command",
  super: "command",
  ctrl: "control",
  control: "control",
  opt: "option",
  option: "option",
  alt: "option",
  shift: "shift",
};

// Named keys the helper knows; any other key is one printable character.
const NAMED_KEYS: ReadonlySet<string> = new Set([
  "return",
  "enter",
  "tab",
  "space",
  "delete",
  "backspace",
  "escape",
  "esc",
  "left",
  "right",
  "down",
  "up",
  "home",
  "end",
  "pageup",
  "pagedown",
  "forwarddelete",
  "del",
  "plus",
  "minus",
  "comma",
  "period",
  "slash",
  "semicolon",
  "equals",
  ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
]);

/**
 * `chord` ("cmd+shift+s") or `keys` (["cmd", "shift", "s"]) into modifiers and keys. A key is a
 * name above or one printable character. Modifiers alone are allowed: `keys: ["shift"]` with
 * `action: "down"` holds shift.
 */
export function parseChord(input: { chord?: string; keys?: string[] }): ParsedChord {
  let tokens: string[];
  if (input.keys !== undefined && input.keys.length > 0) {
    tokens = input.keys.map((key) => key.trim().toLowerCase());
  } else if (input.chord !== undefined) {
    const parts = input.chord
      .trim()
      .toLowerCase()
      .split("+")
      .map((part) => part.trim());
    // "cmd++" presses the plus key: the last empty part stands for it.
    if (parts.length > 1 && parts[parts.length - 1] === "" && parts[parts.length - 2] === "") {
      parts.splice(parts.length - 2, 2, "+");
    }
    tokens = parts;
  } else {
    return { ok: false, message: "Pass a chord, for example return or cmd+s." };
  }
  if (tokens.length === 0 || tokens.some((token) => token === "")) {
    return { ok: false, message: "Name a key, for example return or cmd+s." };
  }
  const modifiers: Modifier[] = [];
  const keys: string[] = [];
  for (const token of tokens) {
    const modifier = MODIFIER_ALIASES[token];
    if (modifier) {
      if (!modifiers.includes(modifier)) modifiers.push(modifier);
      continue;
    }
    if (token === "fn" || token === "function") {
      return { ok: false, message: "The fn key is not available." };
    }
    if (!NAMED_KEYS.has(token) && [...token].length !== 1) {
      return { ok: false, message: `Unknown key "${token}".` };
    }
    keys.push(token);
  }
  return { ok: true, modifiers, keys };
}

/**
 * Chords that act on the system or on the app instead of the window: app switching, quitting,
 * hiding, minimizing, closing, Spotlight, screenshots, window cycling inside the app (which
 * would move the next keystroke to another window), Mission Control and space switching. A
 * deny list of known chords: an unlisted chord reaches the window, which is still the only
 * process the keystroke is sent to.
 */
export function refuseChord(chord: Extract<ParsedChord, { ok: true }>): string | null {
  const cmd = chord.modifiers.includes("command");
  const ctrl = chord.modifiers.includes("control");
  const opt = chord.modifiers.includes("option");
  const shift = chord.modifiers.includes("shift");
  for (const key of chord.keys) {
    if (cmd && ["tab", "`", "~", "space", "q", "h", "m", "w"].includes(key)) {
      return `The chord ${describe(chord)} acts on the system or the app, not the window.`;
    }
    if (cmd && shift && ["3", "4", "5", "6"].includes(key)) {
      return "Screenshot chords are refused.";
    }
    if (cmd && opt && ["escape", "esc", "h", "m", "d", "w"].includes(key)) {
      return `The chord ${describe(chord)} acts on the system or the app, not the window.`;
    }
    if (ctrl && ["left", "right", "up", "down", "space", "tab"].includes(key)) {
      return "Mission Control and space-switching chords are refused.";
    }
    if (cmd && shift && ["tab", "`", "~", "q"].includes(key)) {
      return `The chord ${describe(chord)} acts on the system or the app, not the window.`;
    }
  }
  if (ctrl && cmd) return "Control-command chords are refused.";
  return null;
}

function describe(chord: Extract<ParsedChord, { ok: true }>): string {
  return [...chord.modifiers, ...chord.keys].join("+");
}
