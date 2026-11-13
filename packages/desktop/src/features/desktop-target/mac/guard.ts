// The macOS confinement rules for Attack's desktop target. Pure functions: nothing here touches
// the system, so every rule can be read in one place.

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
  | { ok: true; modifiers: Modifier[]; key: string }
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

// Named keys and their macOS virtual key codes.
const KEY_CODES: Record<string, number> = {
  return: 36,
  enter: 36,
  tab: 48,
  space: 49,
  delete: 51,
  backspace: 51,
  escape: 53,
  esc: 53,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  forwarddelete: 117,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
};

export function keyCodeFor(key: string): number | null {
  return KEY_CODES[key] ?? null;
}

/** "cmd+shift+s" -> modifiers and one key. A key is a name above or one printable character. */
export function parseChord(chord: string): ParsedChord {
  const parts = chord
    .trim()
    .toLowerCase()
    .split("+")
    .map((part) => part.trim());
  // "cmd++" presses the plus key: the last empty part stands for it.
  if (parts.length > 1 && parts[parts.length - 1] === "" && parts[parts.length - 2] === "") {
    parts.splice(parts.length - 2, 2, "+");
  }
  const key = parts.pop() ?? "";
  if (key === "") return { ok: false, message: "Name a key, for example return or cmd+s." };
  const modifiers: Modifier[] = [];
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part];
    if (!modifier) return { ok: false, message: `Unknown modifier "${part}".` };
    if (!modifiers.includes(modifier)) modifiers.push(modifier);
  }
  if (key === "fn" || key === "function") {
    return { ok: false, message: "The fn key is not available." };
  }
  if (!(key in KEY_CODES) && [...key].length !== 1) {
    return { ok: false, message: `Unknown key "${key}".` };
  }
  return { ok: true, modifiers, key };
}

const has = (chord: { modifiers: Modifier[] }, ...wanted: Modifier[]): boolean =>
  wanted.every((modifier) => chord.modifiers.includes(modifier));

/**
 * Chords that act on the system or on the app instead of the window: app switching, quitting,
 * hiding, minimizing, closing, Spotlight, screenshots, window cycling inside the app (which
 * would move the next keystroke to another window), Mission Control and space switching. A
 * deny list of known chords: an unlisted chord reaches the window, which is still the only
 * window the keystroke is sent to.
 */
export function refuseChord(chord: Extract<ParsedChord, { ok: true }>): string | null {
  const { key } = chord;
  const cmd = has(chord, "command");
  const ctrl = has(chord, "control");
  const opt = has(chord, "option");
  const shift = has(chord, "shift");
  if (cmd && ["tab", "`", "~", "space", "q", "h", "m", "w"].includes(key)) {
    return `The chord ${describe(chord)} acts on the system or the app, not the window.`;
  }
  if (cmd && shift && ["3", "4", "5", "6"].includes(key)) {
    return "Screenshot chords are refused.";
  }
  if (cmd && opt && ["escape", "esc", "h", "m", "d", "w"].includes(key)) {
    return `The chord ${describe(chord)} acts on the system or the app, not the window.`;
  }
  if (ctrl && cmd) return "Control-command chords are refused.";
  if (ctrl && ["left", "right", "up", "down", "space", "tab"].includes(key)) {
    return "Mission Control and space-switching chords are refused.";
  }
  if (cmd && shift && ["tab", "`", "~", "q"].includes(key)) {
    return `The chord ${describe(chord)} acts on the system or the app, not the window.`;
  }
  return null;
}

function describe(chord: Extract<ParsedChord, { ok: true }>): string {
  return [...chord.modifiers, chord.key].join("+");
}

const ELEMENT_PATH = /^\d{1,4}(\/\d{1,4}){0,11}$/;

/** An element path is child indexes from the window, at most 12 deep. */
export function isElementPath(path: string): boolean {
  return ELEMENT_PATH.test(path);
}
