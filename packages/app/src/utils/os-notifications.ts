import { Asset } from "expo-asset";
import { Platform } from "react-native";
import { i18n } from "@/i18n/i18next";
import { getDesktopHost } from "@/desktop/host";
import { parseNotificationOpenTarget, WEB_NOTIFICATION_CLICK_EVENT } from "@/notification-open";
import { isNative } from "@/constants/platform";

interface OsNotificationPayload {
  // Native only: a stable id. Android posts it as the notification tag, and a push (FCM)
  // notification with the same tag replaces it instead of stacking a duplicate.
  identifier?: string;
  title: string;
  body?: string;
  data?: Record<string, unknown>;
}

export interface WebNotificationClickDetail {
  data?: Record<string, unknown>;
}

interface WebNotificationInstance {
  addEventListener: (type: "click", listener: (event: Event) => void) => void;
}

let permissionRequest: Promise<boolean> | null = null;
let notificationIconUrl: string | null | undefined;

function getDesktopNotificationSender():
  | ((payload: {
      title: string;
      body?: string;
      data?: Record<string, unknown>;
    }) => Promise<boolean>)
  | null {
  const sendNotification = getDesktopHost()?.notification?.sendNotification;
  return typeof sendNotification === "function"
    ? (sendNotification as (payload: {
        title: string;
        body?: string;
        data?: Record<string, unknown>;
      }) => Promise<boolean>)
    : null;
}

function getWebNotificationConstructor(): {
  permission: string;
  requestPermission?: () => Promise<string>;
  new (
    title: string,
    options?: {
      body?: string;
      data?: Record<string, unknown>;
      icon?: string;
    },
  ): unknown;
} | null {
  const NotificationConstructor = (
    globalThis as {
      Notification?: {
        permission: string;
        requestPermission?: () => Promise<string>;
        new (
          title: string,
          options?: { body?: string; data?: Record<string, unknown>; icon?: string },
        ): unknown;
      };
    }
  ).Notification;
  return NotificationConstructor ?? null;
}

async function ensureNotificationPermission(): Promise<boolean> {
  const NotificationConstructor = getWebNotificationConstructor();
  if (!NotificationConstructor) {
    return false;
  }
  if (NotificationConstructor.permission === "granted") {
    return true;
  }
  if (NotificationConstructor.permission === "denied") {
    return false;
  }
  if (permissionRequest) {
    return permissionRequest;
  }
  permissionRequest = Promise.resolve(
    NotificationConstructor.requestPermission
      ? NotificationConstructor.requestPermission()
      : "denied",
  ).then((permission) => permission === "granted");
  const result = await permissionRequest;
  permissionRequest = null;
  return result;
}

const ANDROID_NOTIFICATION_CHANNEL_ID = "agent-activity";
let nativePermissionRequest: Promise<boolean> | null = null;

// Loaded lazily: expo-notifications is native-only and must not evaluate on web or desktop.
async function ensureNativeNotificationPermission(): Promise<boolean> {
  nativePermissionRequest ??= (async () => {
    const Notifications = await import("expo-notifications");
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync(ANDROID_NOTIFICATION_CHANNEL_ID, {
        name: i18n.t("common.agentNotificationChannel"),
        importance: Notifications.AndroidImportance.HIGH,
      });
    }
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return true;
    if (!current.canAskAgain) return false;
    return (await Notifications.requestPermissionsAsync()).granted;
  })().catch((error) => {
    console.warn("[OsNotifications] Failed to set up native notifications", error);
    return false;
  });
  const granted = await nativePermissionRequest;
  // A denied or failed result is retried next time; a grant is remembered for the session.
  if (!granted) nativePermissionRequest = null;
  return granted;
}

async function sendNativeNotification(payload: OsNotificationPayload): Promise<boolean> {
  if (!(await ensureNativeNotificationPermission())) return false;
  const Notifications = await import("expo-notifications");
  await Notifications.scheduleNotificationAsync({
    ...(payload.identifier ? { identifier: payload.identifier } : {}),
    content: { title: payload.title, body: payload.body, data: payload.data },
    trigger: Platform.OS === "android" ? { channelId: ANDROID_NOTIFICATION_CHANNEL_ID } : null,
  });
  return true;
}

export async function ensureOsNotificationPermission(): Promise<boolean> {
  if (isNative) {
    return await ensureNativeNotificationPermission();
  }
  return await ensureNotificationPermission();
}

function hasNotificationClickTarget(data: Record<string, unknown> | undefined): boolean {
  return parseNotificationOpenTarget(data) !== null;
}

function getWebNotificationIconUrl(): string | undefined {
  if (notificationIconUrl !== undefined) {
    return notificationIconUrl ?? undefined;
  }

  try {
    const asset = Asset.fromModule(require("../../assets/images/notification-icon.png"));
    notificationIconUrl = asset.uri ?? null;
  } catch {
    notificationIconUrl = null;
  }

  return notificationIconUrl ?? undefined;
}

function dispatchWebNotificationClick(detail: WebNotificationClickDetail): boolean {
  const dispatch = (globalThis as { dispatchEvent?: (event: Event) => boolean }).dispatchEvent;
  const CustomEventConstructor = (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent;

  if (typeof dispatch !== "function" || !CustomEventConstructor) {
    return false;
  }

  const event = new CustomEventConstructor<WebNotificationClickDetail>(
    WEB_NOTIFICATION_CLICK_EVENT,
    {
      detail,
      cancelable: true,
    },
  );
  return !dispatch(event);
}

function attachWebClickHandler(
  notification: WebNotificationInstance,
  data: Record<string, unknown> | undefined,
): void {
  notification.addEventListener("click", () => {
    dispatchWebNotificationClick({ data });
  });
}

export async function sendOsNotification(payload: OsNotificationPayload): Promise<boolean> {
  if (isNative) {
    return await sendNativeNotification(payload).catch((error) => {
      console.warn("[OsNotifications] Failed to present notification", error);
      return false;
    });
  }

  const desktopNotificationSender = getDesktopNotificationSender();
  if (desktopNotificationSender) {
    return await desktopNotificationSender(payload);
  }

  const NotificationConstructor = getWebNotificationConstructor();
  if (NotificationConstructor) {
    const granted = await ensureNotificationPermission();
    if (granted) {
      const notification = new NotificationConstructor(payload.title, {
        body: payload.body,
        data: payload.data,
        icon: getWebNotificationIconUrl(),
      }) as WebNotificationInstance;
      if (hasNotificationClickTarget(payload.data)) {
        attachWebClickHandler(notification, payload.data);
      }
      return true;
    }
  }

  return false;
}
