import { requireNativeModule } from "expo-modules-core";
import { i18n } from "@/i18n/i18next";

interface PimiPushPreviewModule {
  getOrCreateKey(serverId: string): Promise<string>;
  deleteKey(serverId: string): Promise<void>;
  setHideWhenLocked(value: boolean): Promise<void>;
  setPreviewsEnabled(value: boolean): Promise<void>;
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

/** Mirrors the "message previews" setting into native storage, where the FCM service reads it
 * while the app is dead. Off also deletes every preview key, whether or not a host is reachable. */
export async function setPreviewsEnabled(value: boolean): Promise<void> {
  await native.setPreviewsEnabled(value);
}

interface PreviewPolicy {
  pushPreviews: boolean;
  pushPreviewsHideWhenLocked: boolean;
}

/**
 * A backgrounded but still connected app posts local notifications, so they obey the same two
 * settings as push. Returns the generic body (same wording as the native push service) when the message
 * must not show, or null when the preview may.
 */
export function genericBodyWhenPreviewWithheld(
  policy: PreviewPolicy,
  reason: "finished" | "permission",
): string | null {
  const withheld =
    !policy.pushPreviews || (policy.pushPreviewsHideWhenLocked && native.isDeviceLocked());
  if (!withheld) return null;
  return i18n.t(
    reason === "permission" ? "common.agentNeedsApprovalGeneric" : "common.agentFinishedGeneric",
  );
}
