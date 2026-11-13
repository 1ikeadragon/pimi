/** The workspace this window's focused route shows, which the browser_show tool reads. */
let visibleWorkspaceKey: string | null = null;

export function setVisibleWorkspaceKey(key: string): void {
  visibleWorkspaceKey = key;
}

/** Clears only when the key is still the visible one, so a screen unmounting late cannot hide its successor. */
export function clearVisibleWorkspaceKey(key: string): void {
  if (visibleWorkspaceKey === key) visibleWorkspaceKey = null;
}

export function isWorkspaceOnScreen(key: string): boolean {
  return visibleWorkspaceKey === key && document.visibilityState === "visible";
}
