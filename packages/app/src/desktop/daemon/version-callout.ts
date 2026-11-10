import type { DesktopDaemonStatus } from "@/desktop/daemon/desktop-daemon";
import { isVersionMismatch } from "@/desktop/updates/desktop-updates";
import { i18n } from "@/i18n/i18next";

export interface DaemonVersionCalloutInput {
  isDesktopApp: boolean;
  manageBuiltInDaemon: boolean;
  isDaemonStarting: boolean;
  appVersion: string | null;
  daemon: Pick<DesktopDaemonStatus, "status" | "desktopManaged" | "version"> | null;
  /** The version the connected local daemon reports, which outlives a restart done elsewhere. */
  connectedDaemonVersion: string | null;
  isRestarting: boolean;
  restartError: string | null;
  isDismissed: boolean;
}

export interface DaemonVersionCalloutDescriptor {
  id: "desktop-daemon-version";
  priority: number;
  title: string;
  description: string;
  warning: string | null;
  variant: "default" | "error";
  actionLabel: string;
  actionDisabled: boolean;
  testID: "daemon-version-callout";
}

const BASE = {
  id: "desktop-daemon-version",
  priority: 150,
  testID: "daemon-version-callout",
} as const;

function isOutdatedManagedDaemon(input: DaemonVersionCalloutInput): boolean {
  const { daemon } = input;
  if (!daemon || daemon.status !== "running" || !daemon.desktopManaged) return false;
  return isVersionMismatch(input.appVersion, input.connectedDaemonVersion ?? daemon.version);
}

/**
 * The callout for a desktop-managed local daemon the app left on another version because its
 * agents were working. A daemon the user started is theirs to update, so it gets none.
 */
export function resolveDaemonVersionCallout(
  input: DaemonVersionCalloutInput,
): DaemonVersionCalloutDescriptor | null {
  if (!input.isDesktopApp || !input.manageBuiltInDaemon) return null;

  if (input.isRestarting) {
    return {
      ...BASE,
      title: i18n.t("desktop.daemon.versionCallout.title"),
      description: i18n.t("desktop.daemon.versionCallout.restartingDescription"),
      warning: null,
      variant: "default",
      actionLabel: i18n.t("desktop.daemon.versionCallout.restarting"),
      actionDisabled: true,
    };
  }

  if (input.isDismissed) return null;

  if (input.restartError) {
    return {
      ...BASE,
      title: i18n.t("desktop.daemon.versionCallout.failedTitle"),
      description: input.restartError,
      warning: null,
      variant: "error",
      actionLabel: i18n.t("common.actions.retry"),
      actionDisabled: false,
    };
  }

  if (input.isDaemonStarting || !isOutdatedManagedDaemon(input)) return null;

  return {
    ...BASE,
    title: i18n.t("desktop.daemon.versionCallout.title"),
    description: i18n.t("desktop.daemon.versionCallout.description", {
      daemonVersion: input.connectedDaemonVersion ?? input.daemon?.version,
      appVersion: input.appVersion,
    }),
    warning: i18n.t("desktop.daemon.versionCallout.warning"),
    variant: "default",
    actionLabel: i18n.t("desktop.daemon.versionCallout.restart"),
    actionDisabled: false,
  };
}
