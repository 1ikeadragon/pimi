import { webContents as allWebContents, type WebContents } from "electron";
import { PIMI_BROWSER_PROFILE_PARTITION } from "../browser-profile.js";
import {
  BROWSER_NEW_TAB_REQUEST_EVENT,
  decideBrowserWindowOpenRequest,
  isAllowedBrowserWebviewUrl,
  PendingBrowserWindowOpenRequests,
} from "./window-open.js";
import { isAttackUrlAllowed, attackUrlHost } from "@pimi/protocol/attack/allowlist";
import { PimiBrowserWebviewRegistry } from "./registry.js";

export {
  BROWSER_NEW_TAB_REQUEST_EVENT,
  decideBrowserWindowOpenRequest,
  PendingBrowserWindowOpenRequests,
};

const browserRegistry = new PimiBrowserWebviewRegistry();

// Tabs an Attack run's agents drive may only reach the run's hosts. The daemon sends the list
// with each browser command (`attackGuard`); normal tabs have no entry and browse freely.
interface AttackNavigationPolicy {
  readonly runId: string;
  readonly allowedHosts: readonly string[];
}

export const ATTACK_NAVIGATION_REFUSED_EVENT = "pimi:event:attack-navigation-refused";

const attackPolicies = new Map<string, AttackNavigationPolicy>();

export function setAttackNavigationPolicy(browserId: string, policy: AttackNavigationPolicy): void {
  attackPolicies.set(browserId, { runId: policy.runId, allowedHosts: [...policy.allowedHosts] });
}

export function getAttackNavigationPolicy(browserId: string): AttackNavigationPolicy | null {
  return attackPolicies.get(browserId) ?? null;
}

/** Reports a refused navigation to the window hosting the tab; only the host is sent, never the path. */
export function reportAttackNavigationRefused(
  hostContents: { isDestroyed(): boolean; send(channel: string, payload: unknown): void } | null,
  input: { runId: string; browserId: string; url: string },
): void {
  if (!hostContents || hostContents.isDestroyed()) return;
  hostContents.send(ATTACK_NAVIGATION_REFUSED_EVENT, {
    runId: input.runId,
    browserId: input.browserId,
    host: attackUrlHost(input.url) ?? "invalid_url",
  });
}

/** True when the tab belongs to an Attack run and `url` is off its list. */
export function isAttackNavigationRefused(browserId: string | null, url: string): boolean {
  const policy = browserId ? attackPolicies.get(browserId) : undefined;
  if (!policy || url === "about:blank") return false;
  return !isAttackUrlAllowed(url, policy.allowedHosts);
}

interface BrowserWebContentsIdentity {
  readonly id: number;
  isDestroyed(): boolean;
}

interface RegisteredBrowserWebContents extends BrowserWebContentsIdentity {
  readonly hostWebContents: BrowserWebContentsIdentity | null;
  readonly session: object;
  once(event: "destroyed", listener: () => void): void;
}

interface AttachedBrowserRegistration {
  browserId: string;
  workspaceId: string;
  webContentsId: number;
}

interface RegisterAttachedBrowserInput extends AttachedBrowserRegistration {
  sender: BrowserWebContentsIdentity;
  profileSession: object;
  findWebContents(webContentsId: number): RegisteredBrowserWebContents | null;
}

export function isPimiBrowserWebviewAttach(input: { src?: string; partition?: string }): boolean {
  return (
    isAllowedBrowserWebviewUrl(input.src) && input.partition === PIMI_BROWSER_PROFILE_PARTITION
  );
}

export function listRegisteredPimiBrowserIds(): string[] {
  return browserRegistry.listBrowserIds();
}

export function getPimiBrowserWebviewRegistry(): PimiBrowserWebviewRegistry {
  return browserRegistry;
}

export function preparePimiBrowserWebContents(contents: RegisteredBrowserWebContents): void {
  const webContentsId = contents.id;
  // Preserve Chromium throttling when the host window is hidden. Browser
  // residency and screenshot capture do not require a lifetime override.
  contents.once("destroyed", () => {
    browserRegistry.unregisterWebContents(webContentsId);
  });
}

export function registerAttachedPimiBrowser(input: RegisterAttachedBrowserInput): boolean {
  const guest = input.findWebContents(input.webContentsId);
  if (
    !guest ||
    guest.isDestroyed() ||
    guest.hostWebContents !== input.sender ||
    guest.session !== input.profileSession
  ) {
    return false;
  }

  browserRegistry.registerWebContents({
    webContentsId: input.webContentsId,
    browserId: input.browserId,
    hostWebContentsId: input.sender.id,
  });
  browserRegistry.registerWorkspace({
    browserId: input.browserId,
    workspaceId: input.workspaceId,
  });
  return true;
}

export function getPimiBrowserIdForWebContents(
  contents: BrowserWebContentsIdentity | null,
): string | null {
  if (!contents || contents.isDestroyed()) {
    return null;
  }
  return browserRegistry.getBrowserIdForWebContents(contents.id);
}

export function unregisterPimiBrowser(browserId: string): void {
  attackPolicies.delete(browserId);
  browserRegistry.unregisterBrowser(browserId);
}

export function unregisterPimiBrowserFromHost(hostWebContentsId: number, browserId: string): void {
  attackPolicies.delete(browserId);
  browserRegistry.unregisterBrowserFromHost(hostWebContentsId, browserId);
}

export function unregisterPimiBrowserHost(hostWebContentsId: number): void {
  browserRegistry.unregisterHostWebContents(hostWebContentsId);
}

export function getPimiBrowserWorkspaceId(browserId: string): string | null {
  return browserRegistry.getWorkspaceId(browserId);
}

export function listRegisteredPimiBrowserIdsForWorkspace(workspaceId: string): string[] {
  return browserRegistry.listBrowserIdsForWorkspace(workspaceId);
}

export function setWorkspaceActivePimiBrowserId(input: {
  hostWebContentsId: number;
  workspaceId: string;
  browserId: string | null;
}): void {
  browserRegistry.setWorkspaceActiveBrowser(input);
}

export function getWorkspaceActivePimiBrowserId(workspaceId: string): string | null {
  return browserRegistry.getMostRecentActiveBrowserIdForWorkspace(workspaceId);
}

export function getWorkspaceActivePimiBrowserIdForHostWindow(
  workspaceId: string,
  hostWebContentsId: number,
): string | null {
  return browserRegistry.getActiveBrowserIdForWorkspaceInHostWindow(hostWebContentsId, workspaceId);
}

export function getPimiBrowserWebContentsForHostWindow(
  browserId: string,
  hostWebContentsId: number,
): WebContents | null {
  const contentsId = browserRegistry.getWebContentsIdForBrowserInHostWindow(
    hostWebContentsId,
    browserId,
  );
  if (contentsId === null) {
    return null;
  }
  const contents = allWebContents.fromId(contentsId);
  if (contents && !contents.isDestroyed()) {
    return contents;
  }
  browserRegistry.unregisterWebContents(contentsId);
  return null;
}

export function getActivePimiBrowserWebContentsForHostWindow(
  hostWebContentsId: number,
): WebContents | null {
  const browserId = browserRegistry.getActiveBrowserIdForHostWindow(hostWebContentsId);
  if (!browserId) {
    return null;
  }
  const contentsId = browserRegistry.getWebContentsIdForBrowserInHostWindow(
    hostWebContentsId,
    browserId,
  );
  if (contentsId === null) {
    return null;
  }
  const contents = allWebContents.fromId(contentsId);
  if (contents && !contents.isDestroyed()) {
    return contents;
  }
  browserRegistry.unregisterWebContents(contentsId);
  return null;
}

function preventUnsafeBrowserWebviewNavigation(
  contents: WebContents,
  event: { preventDefault: () => void },
  url: string | undefined,
): void {
  if (!isAllowedBrowserWebviewUrl(url)) {
    event.preventDefault();
    return;
  }
  if (!url) return;
  const browserId = browserRegistry.getBrowserIdForWebContents(contents.id);
  if (browserId && isAttackNavigationRefused(browserId, url)) {
    event.preventDefault();
    const policy = attackPolicies.get(browserId);
    if (policy) {
      reportAttackNavigationRefused(contents.hostWebContents, {
        runId: policy.runId,
        browserId,
        url,
      });
    }
  }
}

export function registerBrowserWebviewNavigationGuards(contents: WebContents): void {
  contents.on("will-navigate", (event) => {
    preventUnsafeBrowserWebviewNavigation(contents, event, event.url);
  });
  contents.on("will-frame-navigate", (event) => {
    preventUnsafeBrowserWebviewNavigation(contents, event, event.url);
  });
  contents.on("will-redirect", (event) => {
    preventUnsafeBrowserWebviewNavigation(contents, event, event.url);
  });
}
