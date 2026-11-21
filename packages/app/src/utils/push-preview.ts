// Android push message previews. The native module (modules/pimi-push-preview) keeps one
// notification key per host and decrypts previews inside the FCM service. Other platforms have no
// push previews, so this base file is a no-op; push-preview.android.ts is the real one.

/** Creates (or returns) this device's preview key for a host. The key is a bearer secret: hand it
 * to the daemon over the session and never store or log it. */
export async function getOrCreatePreviewKey(_serverId: string): Promise<string | null> {
  return null;
}

export async function deletePreviewKey(_serverId: string): Promise<void> {}

export async function setPreviewsHiddenWhileLocked(_value: boolean): Promise<void> {}

export function isDeviceLocked(): boolean {
  return false;
}

interface PreviewPolicy {
  pushPreviews: boolean;
  pushPreviewsHideWhenLocked: boolean;
}

/** Body for a local attention notification that must not show the message, or null to show it. */
export function genericBodyWhenPreviewWithheld(
  _policy: PreviewPolicy,
  _reason: "finished" | "permission",
): string | null {
  return null;
}
