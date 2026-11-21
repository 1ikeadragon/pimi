import { requireNativeModule } from "expo-modules-core";

interface PimiPushPreviewModule {
  getOrCreateKey(serverId: string): Promise<string>;
  deleteKey(serverId: string): Promise<void>;
  setHideWhenLocked(value: boolean): Promise<void>;
  isDeviceLocked(): boolean;
}

const native = requireNativeModule<PimiPushPreviewModule>("PimiPushPreview");

export async function getOrCreatePreviewKey(serverId: string): Promise<string | null> {
  return await native.getOrCreateKey(serverId);
}

export async function deletePreviewKey(serverId: string): Promise<void> {
  await native.deleteKey(serverId);
}

export async function setPreviewsHiddenWhileLocked(value: boolean): Promise<void> {
  await native.setHideWhenLocked(value);
}

export function isDeviceLocked(): boolean {
  return native.isDeviceLocked();
}

interface PreviewPolicy {
  pushPreviews: boolean;
  pushPreviewsHideWhenLocked: boolean;
}

/**
 * A backgrounded but still connected app posts local notifications, so they obey the same two
 * settings as push. Returns the generic body (same text the push service uses) when the message
 * must not show, or null when the preview may.
 */
export function genericBodyWhenPreviewWithheld(
  policy: PreviewPolicy,
  reason: "finished" | "permission",
): string | null {
  const withheld =
    !policy.pushPreviews || (policy.pushPreviewsHideWhenLocked && native.isDeviceLocked());
  if (!withheld) return null;
  return reason === "permission" ? "An agent needs your approval." : "An agent finished.";
}
