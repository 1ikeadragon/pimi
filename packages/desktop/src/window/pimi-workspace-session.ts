// Pimi addition to the Paseo fork. Apache-2.0.
import { session } from "electron";
import { isPimiVideoEmbed, PIMI_VIDEO_EMBED_ORIGIN } from "@getpaseo/protocol/pimi-task";

const videoAssetHosts = [
  "youtube-nocookie.com",
  "youtube.com",
  "googlevideo.com",
  "ytimg.com",
  "gstatic.com",
];

function videoAsset(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    !url.port &&
    videoAssetHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
  );
}

export function createPimiWorkspaceSession(origin: string): Electron.Session {
  // Keep the player out of the Agent Console and Browser's persistent sessions.
  const isolated = session.fromPartition("pimi-workspace", { cache: false });
  const canUsePermission = (
    permission: string,
    requestingOrigin: string | undefined,
    mainFrame: boolean,
  ) => {
    const requestOrigin = requestingOrigin && URL.parse(requestingOrigin)?.origin;
    if (mainFrame) return requestOrigin === origin && permission === "clipboard-sanitized-write";
    return (
      requestOrigin === PIMI_VIDEO_EMBED_ORIGIN &&
      ["fullscreen", "mediaKeySystem"].includes(permission)
    );
  };
  isolated.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) =>
    canUsePermission(permission, requestingOrigin, details.isMainFrame),
  );
  isolated.setPermissionRequestHandler((_contents, permission, reply, details) =>
    reply(canUsePermission(permission, details.requestingUrl, details.isMainFrame)),
  );

  const network = { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] };
  isolated.webRequest.onBeforeRequest(network, (details, reply) => {
    const url = URL.parse(details.url);
    if (!url) return reply({ cancel: true });
    if (details.resourceType === "mainFrame") return reply({ cancel: url.origin !== origin });
    if (details.resourceType === "subFrame") return reply({ cancel: !isPimiVideoEmbed(url) });
    if (url.origin === origin) {
      const frame = details.frame;
      const fromConsole = frame && !frame.parent && URL.parse(frame.url)?.origin === origin;
      return reply({ cancel: !fromConsole });
    }
    reply({ cancel: !videoAsset(url) });
  });

  isolated.webRequest.onBeforeSendHeaders(
    { urls: [`${PIMI_VIDEO_EMBED_ORIGIN}/embed/*`] },
    (details, reply) => {
      const url = URL.parse(details.url);
      if (details.resourceType === "subFrame" && url && isPimiVideoEmbed(url)) {
        // Identify the desktop app to YouTube without exposing the local workspace URL.
        const headers = Object.fromEntries(
          Object.entries(details.requestHeaders).filter(([key]) => key.toLowerCase() !== "referer"),
        );
        headers.Referer = "https://com.pimi.desktop/";
        reply({ requestHeaders: headers });
      } else {
        reply({});
      }
    },
  );
  return isolated;
}
