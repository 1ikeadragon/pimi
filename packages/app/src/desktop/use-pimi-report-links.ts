// Pimi addition to the Paseo fork. Apache-2.0.
import { useEffect } from "react";
import { PimiReportLinkTarget } from "@pimi/protocol/pimi-task";
import { parseAssistantFileLink, normalizeInlinePathTarget } from "@/assistant-file-links/parse";
import { createWorkspaceBrowser } from "@/desktop/browser/store";
import { getDesktopHost } from "@/desktop/host";
import { useStableEvent } from "@/hooks/use-stable-event";
import {
  getLastWorkspaceSelection,
  navigateToWorkspace,
  useActiveWorkspaceSelection,
  type ActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import {
  createWorkspaceFileTabTarget,
  normalizeWorkspaceFileLocation,
} from "@/workspace/file-open";

function availableWorkspace(selection: ActiveWorkspaceSelection | null) {
  if (!selection) return null;
  const session = useSessionStore.getState().sessions[selection.serverId];
  const key = resolveWorkspaceMapKeyByIdentity({
    workspaces: session?.workspaces,
    workspaceId: selection.workspaceId,
  });
  const workspace = key ? session?.workspaces?.get(key) : null;
  if (!workspace || workspace.archivingAt) return null;
  return { ...selection, workspaceId: workspace.id, workspace };
}

type ReportWorkspace = ReturnType<typeof availableWorkspace>;

function openReportWeb(
  url: URL,
  reportWorkspace: ReportWorkspace,
  selection: ActiveWorkspaceSelection | null,
): string | null {
  if (url.username || url.password)
    return "Links containing sign-in credentials cannot be opened here.";
  const destination =
    reportWorkspace ??
    availableWorkspace(selection) ??
    availableWorkspace(getLastWorkspaceSelection());
  if (!destination) return "Open a workspace in Pimi, then try this web link again.";
  const { browserId } = createWorkspaceBrowser({ initialUrl: url.href });
  navigateToWorkspace({ ...destination, target: { kind: "browser", browserId } });
  return null;
}

function openReportFile(
  href: string,
  url: URL | null,
  reportWorkspace: ReportWorkspace,
): string | null {
  if (!reportWorkspace) {
    return "This file belongs to a report workspace that is unavailable. Reconnect its host and reopen the workspace.";
  }
  // file:// paths refer to this daemon. A URL naming another host is not a local path.
  if (
    url?.protocol === "file:" &&
    (url.username || url.password || (url.hostname && url.hostname !== "localhost"))
  )
    return "This file link names another host. Open that host's workspace in Pimi first.";

  const root = reportWorkspace.workspace.workspaceDirectory;
  const target = parseAssistantFileLink(href, {
    workspaceRoot: root,
    relativePathBase: root,
    explicitLink: true,
    decodeHref: true,
  });
  const file = target && normalizeInlinePathTarget(target.path, root)?.file;
  const location =
    file &&
    normalizeWorkspaceFileLocation({
      path: file,
      lineStart: target?.lineStart,
      lineEnd: target?.lineEnd,
    });
  if (!location)
    return "This location cannot be opened as a file. Use a file path or an HTTP(S) link.";
  navigateToWorkspace({ ...reportWorkspace, target: createWorkspaceFileTabTarget(location) });
  return null;
}

export function usePimiReportLinks(): void {
  const host = getDesktopHost();
  const selection = useActiveWorkspaceSelection();
  const open = useStableEvent((value: unknown) => {
    const parsed = PimiReportLinkTarget.safeParse(value);
    if (!parsed.success) return;
    const request = parsed.data;
    const fail = (message: string) =>
      host?.pimiReportLinks?.reportError({
        reportId: request.reportId,
        message,
      });
    try {
      const reportWorkspace = availableWorkspace(
        request.serverId && request.workspaceId
          ? { serverId: request.serverId, workspaceId: request.workspaceId }
          : null,
      );
      const url = URL.parse(request.href);
      const error =
        url && ["http:", "https:"].includes(url.protocol)
          ? openReportWeb(url, reportWorkspace, selection)
          : openReportFile(request.href, url, reportWorkspace);
      if (error) fail(error);
      else host?.dismissPimiWorkspace?.();
    } catch (error) {
      console.error("Could not open Pimi report link:", error);
      fail("Pimi could not open this link. Check that its workspace and host are available.");
    }
  });
  useEffect(() => host?.pimiReportLinks?.onOpen(open), [host, open]);
}
