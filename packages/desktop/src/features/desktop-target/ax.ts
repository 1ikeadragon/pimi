import { execFile } from "node:child_process";
import type { DesktopGuard, Frame, Modifier } from "./guard.js";

// Accessibility and input go through System Events with a fixed JXA script. Agent text is never
// part of the script source: it travels as argv, which the script reads as plain strings.
// `osascript` is attributed by macOS to the app that spawned it (the packaged Pimi app), so the
// Accessibility and Automation prompts name Pimi, not a helper.

export type AxErrorCode =
  | "permission_missing"
  | "window_gone"
  | "refused"
  | "unsupported"
  | "failed";

export class AxError extends Error {
  constructor(
    readonly code: AxErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AxError";
  }
}

const SNAPSHOT_MAX_DEPTH = 12;
const SNAPSHOT_MAX_NODES = 400;
const SNAPSHOT_BUDGET_MS = 6_000;
const CALL_TIMEOUT_MS = 8_000;

const SCRIPT = String.raw`
ObjC.import("CoreGraphics");
ObjC.import("AppKit");
const se = Application("System Events");
const cur = Application.currentApplication();
cur.includeStandardAdditions = true;
const fail = (code, message) => JSON.stringify({ ok: false, code, message });
const ok = (value) => JSON.stringify(Object.assign({ ok: true }, value));
const cleanTitle = (name) => (name === null || name === undefined ? "" : String(name));

function safe(read) { try { return read(); } catch (e) { return null; } }

function cgWindows(onScreenOnly) {
  const arr = $.CGWindowListCopyWindowInfo(onScreenOnly ? 17 : 0, 0);
  return ObjC.deepUnwrap(ObjC.castRefToObject(arr));
}

function runningApp(pid) {
  try { return $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid); } catch (e) { return null; }
}

function bundleOf(pid) {
  const app = runningApp(pid);
  if (!app) return null;
  const policy = safe(() => app.activationPolicy);
  if (Number(policy) !== 0) return null;
  const id = safe(() => ObjC.unwrap(app.bundleIdentifier));
  return typeof id === "string" && id !== "" ? id : null;
}

function nameOf(pid) {
  const app = runningApp(pid);
  const n = app ? safe(() => ObjC.unwrap(app.localizedName)) : null;
  return typeof n === "string" && n !== "" ? n : null;
}

// Windows come from the window server, not Accessibility: naming the target and capturing it need
// only Screen Recording. Titles are empty without that permission.
function candidates(onScreenOnly) {
  const out = [];
  for (const w of cgWindows(onScreenOnly)) {
    if (w.kCGWindowLayer !== 0) continue;
    const b = w.kCGWindowBounds;
    if (b.Width < 40 || b.Height < 40) continue;
    const bundleId = bundleOf(w.kCGWindowOwnerPID);
    if (!bundleId) continue;
    out.push({ pid: w.kCGWindowOwnerPID, bundleId: bundleId, title: cleanTitle(w.kCGWindowName), number: w.kCGWindowNumber, frame: { x: b.X, y: b.Y, width: b.Width, height: b.Height } });
  }
  return out;
}

function resolve(bundleId, title, ownPid) {
  const hits = candidates(false).filter((c) => c.bundleId === bundleId && c.title === title);
  if (hits.length === 0) return { error: fail("window_gone", "The window titled " + JSON.stringify(title) + " is gone.") };
  if (hits.length > 1) {
    return { error: fail("refused", "More than one window is titled " + JSON.stringify(title) + "; rename one so the target is unambiguous.") };
  }
  const hit = hits[0];
  if (String(hit.pid) === String(ownPid)) return { error: fail("refused", "Pimi cannot drive its own windows.") };
  return { pid: hit.pid, frame: hit.frame, number: hit.number };
}

// The Accessibility handle of the window the window server named, matched by its frame.
function axWindow(pid, frame) {
  const procs = se.applicationProcesses.whose({ unixId: pid })();
  if (procs.length === 0) return { error: fail("window_gone", "The target app is not running.") };
  const proc = procs[0];
  const poss = proc.windows.position();
  const sizes = proc.windows.size();
  for (let i = 0; i < poss.length; i++) {
    if (Math.abs(poss[i][0] - frame.x) <= 2 && Math.abs(poss[i][1] - frame.y) <= 2 && Math.abs(sizes[i][0] - frame.width) <= 2 && Math.abs(sizes[i][1] - frame.height) <= 2) {
      return { proc: proc, win: proc.windows[i] };
    }
  }
  return { error: fail("window_gone", "The window could not be found through Accessibility.") };
}

// The first on-screen window at a point, front to back, must be the target window.
function topmostIsTarget(pid, frame, ax, ay) {
  for (const w of cgWindows(true)) {
    if (w.kCGWindowAlpha === 0) continue;
    const b = w.kCGWindowBounds;
    if (ax < b.X || ay < b.Y || ax >= b.X + b.Width || ay >= b.Y + b.Height) continue;
    return w.kCGWindowOwnerPID === pid && w.kCGWindowLayer === 0 &&
      Math.abs(b.X - frame.x) <= 2 && Math.abs(b.Y - frame.y) <= 2;
  }
  return false;
}

function front(proc, win) {
  try { win.actions.byName("AXRaise").perform(); } catch (e) {}
  proc.frontmost = true;
  cur.delay(0.2);
  const now = se.applicationProcesses.whose({ frontmost: true })();
  if (now.length === 0 || String(now[0].unixId()) !== String(proc.unixId())) return false;
  try { return win.attributes.byName("AXMain").value() === true; } catch (e) { return false; }
}

function snapshot(win, frame) {
  const lines = [];
  let count = 0;
  let truncated = false;
  const deadline = Date.now() + ${SNAPSHOT_BUDGET_MS};
  function walk(el, path, depth) {
    if (depth >= ${SNAPSHOT_MAX_DEPTH}) { truncated = true; return; }
    const kids = el.uiElements;
    const roles = safe(() => kids.role()) || [];
    const names = safe(() => kids.name()) || [];
    const descs = safe(() => kids.description()) || [];
    const vals = safe(() => kids.value()) || [];
    const poss = safe(() => kids.position()) || [];
    const sizes = safe(() => kids.size()) || [];
    for (let i = 0; i < roles.length; i++) {
      if (count >= ${SNAPSHOT_MAX_NODES} || Date.now() > deadline) { truncated = true; return; }
      count++;
      const p = path === "" ? String(i) : path + "/" + i;
      let line = "  ".repeat(depth) + "[" + p + "] " + roles[i];
      if (names[i]) line += " " + JSON.stringify(String(names[i]).slice(0, 80));
      else if (descs[i]) line += " " + JSON.stringify(String(descs[i]).slice(0, 80));
      const v = vals[i];
      if (v !== null && v !== undefined && typeof v !== "object" && String(v) !== "" && String(v) !== String(names[i])) {
        line += " value=" + JSON.stringify(String(v).slice(0, 80));
      }
      if (poss[i] && sizes[i]) {
        line += " (" + Math.round(poss[i][0] - frame.x) + "," + Math.round(poss[i][1] - frame.y) + "," + Math.round(sizes[i][0]) + "," + Math.round(sizes[i][1]) + ")";
      }
      lines.push(line);
      walk(el.uiElements[i], p, depth + 1);
    }
  }
  walk(win, "", 0);
  return { tree: lines.join("\n"), truncated: truncated };
}

function run(argv) {
  const verb = argv[0];
  if (verb === "probe") {
    // Touching System Events is what makes macOS ask for Automation access.
    se.applicationProcesses.whose({ frontmost: true })();
    return ok({});
  }
  if (verb === "list") {
    const own = argv[1];
    const out = [];
    for (const c of candidates(true)) {
      if (String(c.pid) === String(own) || out.length >= 200) continue;
      out.push({ bundleId: c.bundleId, appName: nameOf(c.pid) || c.bundleId, windowTitle: c.title });
    }
    return ok({ windows: out });
  }
  const bundleId = argv[1], title = argv[2], own = argv[3];
  const target = resolve(bundleId, title, own);
  if (target.error) return target.error;
  const pid = target.pid, frame = target.frame;
  if (verb === "resolve") return ok({ pid: pid, frame: frame, windowNumber: target.number });
  const handle = axWindow(pid, frame);
  if (handle.error) return handle.error;
  const proc = handle.proc, win = handle.win;
  if (verb === "snapshot") {
    return ok(snapshot(win, frame));
  }
  if (verb === "click-element") {
    let el = win;
    for (const part of argv[4].split("/")) el = el.uiElements[Number(part)];
    const role = safe(() => el.role());
    if (role === null) return fail("failed", "That element no longer exists. Take a new snapshot.");
    const label = safe(() => el.name()) || safe(() => el.description()) || null;
    const pos = safe(() => el.position());
    const size = safe(() => el.size());
    if (!pos || !size) return fail("failed", "That element has no position. Take a new snapshot.");
    const cx = pos[0] + size[0] / 2, cy = pos[1] + size[1] / 2;
    if (cx < frame.x || cy < frame.y || cx >= frame.x + frame.width || cy >= frame.y + frame.height) {
      return fail("refused", "That element is outside the target window.");
    }
    const point = { x: Math.round(cx - frame.x), y: Math.round(cy - frame.y) };
    const actions = safe(() => el.actions.name()) || [];
    if (actions.indexOf("AXPress") >= 0) {
      el.actions.byName("AXPress").perform();
    } else {
      if (!topmostIsTarget(pid, frame, cx, cy)) return fail("refused", "Another window covers that element.");
      se.click({ at: [cx, cy] });
    }
    return ok({ role: String(role), label: label === null ? null : String(label).slice(0, 200), point: point });
  }
  if (verb === "click-point") {
    const rx = Number(argv[4]), ry = Number(argv[5]);
    const ax = frame.x + rx, ay = frame.y + ry;
    if (!(rx >= 0 && ry >= 0 && rx < frame.width && ry < frame.height)) {
      return fail("refused", "That point is outside the target window.");
    }
    if (!topmostIsTarget(pid, frame, ax, ay)) return fail("refused", "Another window covers that point.");
    se.click({ at: [ax, ay] });
    return ok({ role: null, label: null, point: { x: Math.round(rx), y: Math.round(ry) } });
  }
  if (verb === "type" || verb === "key-code" || verb === "key-char") {
    if (!front(proc, win)) return fail("refused", "The target window could not be brought to the front, so nothing was typed.");
    if (verb === "type") { se.keystroke(argv[4]); return ok({}); }
    const using = JSON.parse(argv[5]).map((m) => m + " down");
    if (verb === "key-code") se.keyCode(Number(argv[4]), { using: using });
    else se.keystroke(argv[4], { using: using });
    return ok({});
  }
  return fail("failed", "Unknown desktop verb.");
}
`;

function mapStderr(stderr: string): AxError {
  if (/-1743|not authorized to send Apple events/i.test(stderr)) {
    return new AxError(
      "permission_missing",
      "Pimi is not allowed to control System Events. Allow it in System Settings > Privacy & Security > Automation.",
    );
  }
  if (/-25211|-1719|assistive access|not allowed assistive|-25204/i.test(stderr)) {
    if (/-1719|invalid index/i.test(stderr)) {
      return new AxError("window_gone", "The window or element is gone. Take a new snapshot.");
    }
    return new AxError(
      "permission_missing",
      "Pimi does not have Accessibility access. Grant it in System Settings > Privacy & Security > Accessibility.",
    );
  }
  if (/-1728|can.t get|invalid index/i.test(stderr)) {
    return new AxError("window_gone", "The window or element is gone. Take a new snapshot.");
  }
  return new AxError("failed", `System Events failed: ${stderr.trim().slice(0, 300)}`);
}

// One System Events call at a time: parallel calls only slow each other down and race on focus.
let chain: Promise<unknown> = Promise.resolve();

function runScript(args: string[], timeoutMs: number): Promise<Record<string, unknown>> {
  const job = chain.then(
    () =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        execFile(
          "/usr/bin/osascript",
          ["-l", "JavaScript", "-e", SCRIPT, ...args],
          { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
          (error, stdout, stderr) => {
            const text = stdout.trim() || stderr.trim();
            let parsed: Record<string, unknown> | null = null;
            try {
              parsed = JSON.parse(text) as Record<string, unknown>;
            } catch {
              parsed = null;
            }
            if (parsed && typeof parsed.ok === "boolean") {
              if (parsed.ok) resolve(parsed);
              else reject(new AxError(parsed.code as AxErrorCode, String(parsed.message)));
              return;
            }
            if (error && (error as NodeJS.ErrnoException & { killed?: boolean }).killed) {
              reject(new AxError("failed", "System Events did not answer in time."));
              return;
            }
            reject(mapStderr(stderr || text || String(error)));
          },
        );
      }),
  );
  chain = job.catch(() => undefined);
  return job;
}

const target = (guard: DesktopGuard, ownPid: number): string[] => [
  guard.bundleId,
  guard.windowTitle,
  String(ownPid),
];

export interface ResolvedWindow {
  pid: number;
  frame: Frame;
  windowNumber: number | null;
}

export async function resolveWindow(guard: DesktopGuard, ownPid: number): Promise<ResolvedWindow> {
  const result = await runScript(["resolve", ...target(guard, ownPid)], CALL_TIMEOUT_MS);
  const frame = result.frame as Frame;
  return {
    pid: result.pid as number,
    frame,
    windowNumber: (result.windowNumber as number | null) ?? null,
  };
}

export async function probeAutomation(): Promise<"granted" | "denied" | "failed"> {
  try {
    await runScript(["probe"], 60_000);
    return "granted";
  } catch (error) {
    return error instanceof AxError && error.code === "permission_missing" ? "denied" : "failed";
  }
}

export async function listWindows(
  ownPid: number,
): Promise<Array<{ bundleId: string; appName: string; windowTitle: string }>> {
  const result = await runScript(["list", String(ownPid)], 15_000);
  return result.windows as Array<{ bundleId: string; appName: string; windowTitle: string }>;
}

export async function snapshotWindow(
  guard: DesktopGuard,
  ownPid: number,
): Promise<{ tree: string; truncated: boolean }> {
  const result = await runScript(
    ["snapshot", ...target(guard, ownPid)],
    SNAPSHOT_BUDGET_MS + 4_000,
  );
  return { tree: String(result.tree), truncated: result.truncated === true };
}

export interface ClickHit {
  role: string | null;
  label: string | null;
  point: { x: number; y: number } | null;
}

export async function clickElement(
  guard: DesktopGuard,
  ownPid: number,
  path: string,
): Promise<ClickHit> {
  const result = await runScript(
    ["click-element", ...target(guard, ownPid), path],
    CALL_TIMEOUT_MS,
  );
  return result as unknown as ClickHit;
}

export async function clickPoint(
  guard: DesktopGuard,
  ownPid: number,
  point: { x: number; y: number },
): Promise<ClickHit> {
  const result = await runScript(
    ["click-point", ...target(guard, ownPid), String(point.x), String(point.y)],
    CALL_TIMEOUT_MS,
  );
  return result as unknown as ClickHit;
}

export async function typeText(guard: DesktopGuard, ownPid: number, text: string): Promise<void> {
  await runScript(["type", ...target(guard, ownPid), text], CALL_TIMEOUT_MS);
}

export async function pressKey(
  guard: DesktopGuard,
  ownPid: number,
  key: { code: number } | { char: string },
  modifiers: Modifier[],
): Promise<void> {
  const verb = "code" in key ? "key-code" : "key-char";
  const value = "code" in key ? String(key.code) : key.char;
  await runScript(
    [verb, ...target(guard, ownPid), value, JSON.stringify(modifiers)],
    CALL_TIMEOUT_MS,
  );
}
