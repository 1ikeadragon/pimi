// COMPAT(paseo-home): earlier builds served the renderer from paseo://app, so their
// localStorage (saved remote hosts, drafts, layout and panel state, UI preferences) sits under
// that origin and the pimi://app renderer starts empty. This copies every key across once. Delete it with
// the home migration in packages/server/src/server/legacy-home-migration.ts.
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app, BrowserWindow, protocol } from "electron";
import log from "electron-log/main";

export const LEGACY_APP_SCHEME = "paseo";
/** A blank page the pimi scheme serves so the migration can run in the pimi origin. */
export const STORAGE_MIGRATION_PATH = "/__legacy-storage-migration";
const BLANK_PAGE = "<!doctype html><title></title>";

async function withHiddenPage<T>(url: string, run: (win: BrowserWindow) => Promise<T>): Promise<T> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await win.loadURL(url);
    return await run(win);
  } finally {
    win.destroy();
  }
}

/**
 * Copies every localStorage entry of the old origin once per userData directory, never over a
 * key the pimi origin already has. The rename changed key names ("@paseo:x" -> "@pimi:x",
 * "paseo:x" -> "pimi:x", "paseo-drafts" -> "pimi-drafts") and the attachment mime type inside
 * stored drafts; any other key kept its name.
 */
export async function migrateLegacyRendererStorage(appScheme: string): Promise<void> {
  const markerPath = path.join(app.getPath("userData"), "legacy-renderer-storage.migrated");
  if (existsSync(markerPath)) return;
  // A fresh install has no storage directory, so there is nothing to read.
  if (!existsSync(path.join(app.getPath("userData"), "Local Storage"))) return;
  try {
    protocol.handle(
      LEGACY_APP_SCHEME,
      () => new Response(BLANK_PAGE, { headers: { "content-type": "text/html" } }),
    );
    const entries = await withHiddenPage(`${LEGACY_APP_SCHEME}://app/`, async (win) => {
      const json: unknown = await win.webContents.executeJavaScript(
        `JSON.stringify(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]))`,
      );
      return typeof json === "string" ? (JSON.parse(json) as Array<[string, string | null]>) : [];
    });
    if (entries.length > 0) {
      const copied = await withHiddenPage(
        `${appScheme}://app${STORAGE_MIGRATION_PATH}`,
        async (win) =>
          win.webContents.executeJavaScript(
            `(() => { let copied = 0; for (const [key, value] of ${JSON.stringify(entries)}) { const next = key.replace(/^(@?)paseo([:-])/, "$1pimi$2"); if (value !== null && localStorage.getItem(next) === null) { localStorage.setItem(next, value.split('"application/paseo-').join('"application/pimi-')); copied += 1; } } return copied; })()`,
          ) as Promise<number>,
      );
      log.info(
        `[legacy-storage] copied ${copied} of ${entries.length} entries from ${LEGACY_APP_SCHEME}://app`,
      );
    }
    writeFileSync(markerPath, new Date().toISOString());
  } catch (error) {
    // Preferences only: start without them rather than blocking the app, and retry next launch.
    log.warn("[legacy-storage] could not migrate renderer storage", error);
  } finally {
    protocol.unhandle(LEGACY_APP_SCHEME);
  }
}
