// The Windows confinement rules for Attack's desktop target. Pure functions: nothing here touches
// the system. The helper re-checks the exe name, class and chords as a backstop; these run first
// in the main process so a refusal never reaches the helper.

export interface WinWindowIdentity {
  /** The AUMID of a packaged app, else the lowercased full exe path. */
  appId: string;
  exeName?: string | null;
  windowClass?: string | null;
}

const DENIED_EXES: ReadonlySet<string> = new Set<string>();

const DENIED_CLASSES: ReadonlySet<string> = new Set<string>();

const REFUSED = "That app cannot be driven by an Attack run.";

function exeNameOf(identity: WinWindowIdentity): string {
  if (identity.exeName) return identity.exeName.toLowerCase();
  const path = identity.appId.toLowerCase();
  return path.includes("\\") || path.endsWith(".exe") ? (path.split(/[\\/]/).pop() ?? "") : "";
}

/**
 * Why a window of this app can never be a target, or null. Matched on the lowercased exe name, the
 * AUMID prefix and the window class. `installDir` is the directory Pimi runs from: anything under
 * it is Pimi itself.
 */
export function forbiddenWinTarget(
  identity: WinWindowIdentity,
  installDir?: string | null,
): string | null {
  const appId = identity.appId.toLowerCase();
  const exe = exeNameOf(identity);
  if (DENIED_EXES.has(exe)) {
    return REFUSED;
  }
  if (appId.startsWith("com.pimi.")) {
    return REFUSED;
  }
  if (identity.windowClass && DENIED_CLASSES.has(identity.windowClass.toLowerCase())) {
    return REFUSED;
  }
  if (installDir) {
    const dir = installDir.toLowerCase().replace(/[\\/]+$/, "");
    if (dir && (appId === dir || appId.startsWith(`${dir}\\`) || appId.startsWith(`${dir}/`))) {
      return REFUSED;
    }
  }
  return null;
}

export type WinModifier = "ctrl" | "alt" | "shift" | "win";

export type ParsedWinChord =
  | { ok: true; modifiers: WinModifier[]; keys: string[] }
  | { ok: false; message: string };

const MODIFIER_ALIASES: Record<string, WinModifier> = {
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  opt: "alt",
  option: "alt",
  shift: "shift",
  win: "win",
  windows: "win",
  cmd: "win",
  command: "win",
  meta: "win",
  super: "win",
  lwin: "win",
  rwin: "win",
};

const NAMED_KEYS: ReadonlySet<string> = new Set([
  "return",
  "enter",
  "tab",
  "space",
  "backspace",
  "delete",
  "escape",
  "esc",
  "left",
  "right",
  "up",
  "down",
  "home",
  "end",
  "pageup",
  "pagedown",
  "insert",
  "apps",
  "pause",
  "capslock",
  "numlock",
  "scrolllock",
  "printscreen",
  "prtsc",
  "snapshot",
  ...Array.from({ length: 24 }, (_, index) => `f${index + 1}`),
  ...Array.from({ length: 10 }, (_, index) => `numpad${index}`),
]);

function addToken(
  token: string,
  modifiers: WinModifier[],
  keys: string[],
): { ok: false; message: string } | null {
  const modifier = MODIFIER_ALIASES[token];
  if (modifier) {
    if (!modifiers.includes(modifier)) modifiers.push(modifier);
    return null;
  }
  if (!NAMED_KEYS.has(token) && [...token].length !== 1) {
    return { ok: false, message: `Unknown key "${token}".` };
  }
  keys.push(token);
  return null;
}

/** "ctrl+shift+s" -> modifiers and keys. A key is a name above or one printable character. */
export function parseWinChord(chord: string): ParsedWinChord {
  const parts = chord
    .trim()
    .toLowerCase()
    .split("+")
    .map((part) => part.trim());
  // "ctrl++" presses the plus key: the last empty part stands for it.
  if (parts.length > 1 && parts[parts.length - 1] === "" && parts[parts.length - 2] === "") {
    parts.splice(parts.length - 2, 2, "+");
  }
  if (parts.some((part) => part === "")) {
    return { ok: false, message: "Name a key, for example return or ctrl+s." };
  }
  return parseWinKeys(parts);
}

/** A list of key names held together, for example ["w", "shift"]. */
export function parseWinKeys(tokens: readonly string[]): ParsedWinChord {
  const modifiers: WinModifier[] = [];
  const keys: string[] = [];
  for (const raw of tokens) {
    const failed = addToken(raw.trim().toLowerCase(), modifiers, keys);
    if (failed) return failed;
  }
  if (modifiers.length === 0 && keys.length === 0) {
    return { ok: false, message: "Name a key, for example return or ctrl+s." };
  }
  return { ok: true, modifiers, keys };
}

const SYSTEM = "acts on the system or the app, not the window.";

function refuseKey(
  key: string,
  held: { alt: boolean; ctrl: boolean },
  describeChord: string,
): string | null {
  const { alt, ctrl } = held;
  if (alt && (key === "tab" || key === "esc" || key === "escape")) {
    return `The chord ${describeChord} switches windows, which ${SYSTEM}`;
  }
  if (ctrl && (key === "esc" || key === "escape")) {
    return `The chord ${describeChord} opens Start or Task Manager, which ${SYSTEM}`;
  }
  if (alt && key === "f4") return "Alt+f4 closes the window or quits the app and is refused.";
  if (alt && key === "space") {
    return "Alt+space opens the system menu (move, size, minimize, close) and is refused.";
  }
  if (key === "printscreen" || key === "prtsc" || key === "snapshot") {
    return "Screenshot chords are refused.";
  }
  if (key === "capslock" || key === "numlock" || key === "scrolllock") {
    return `The ${key} key changes global keyboard state and is refused.`;
  }
  return null;
}
/**
 * Chords that act on the system or the app instead of the window: the Windows key, window
 * switching, Start and Task Manager, Explorer's ctrl+alt hotkeys, closing, the system menu,
 * screenshots, and the keys that toggle global keyboard state. A deny list of known chords: an
 * unlisted chord reaches the window, which is still the only window the keystroke is sent to.
 */
export function refuseWinChord(chord: Extract<ParsedWinChord, { ok: true }>): string | null {
  const { modifiers, keys } = chord;
  const has = (modifier: WinModifier) => modifiers.includes(modifier);
  const describeChord = [...modifiers, ...keys].join("+");
  if (has("win")) return `The chord ${describeChord} uses the Windows key, which ${SYSTEM}`;
  const alt = has("alt");
  const ctrl = has("ctrl");
  const shift = has("shift");
  if (keys.length === 0) {
    if ((alt && shift) || (ctrl && shift)) {
      return "Lone alt+shift and ctrl+shift change the keyboard layout and are refused.";
    }
    return null;
  }
  if (ctrl && alt) return "Ctrl+alt chords launch programs and are refused.";
  for (const key of keys) {
    const refused = refuseKey(key, { alt, ctrl }, describeChord);
    if (refused) return refused;
  }
  return null;
}
