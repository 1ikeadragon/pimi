// Pimi addition to the Paseo fork. Apache-2.0.
import { session } from "electron";
import {
  isPimiSpaceEmbed,
  isPimiVideoEmbed,
  isPimiXEmbed,
  PIMI_VIDEO_EMBED_ORIGIN,
} from "@getpaseo/protocol/pimi-task";

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

function xAsset(url: URL, frameUrl: URL, method: string, resource: string): boolean {
  if (method !== "GET" || url.username || url.password) return false;
  switch (url.origin) {
    case "https://platform.twitter.com":
      return resource === "script" && /^\/embed\/[\w.-]+\.js$/.test(url.pathname);
    case "https://cdn.syndication.twimg.com": {
      const ids = url.searchParams.getAll("id");
      return (
        resource === "xhr" &&
        url.pathname === "/tweet-result" &&
        ids.length === 1 &&
        ids[0] === frameUrl.searchParams.get("id")
      );
    }
    case "https://abs-0.twimg.com":
      return resource === "image" && url.pathname.startsWith("/emoji/");
    case "https://pbs.twimg.com":
      return resource === "image";
    default:
      return false;
  }
}

export function createPimiWorkspaceSession(origin: string): Electron.Session {
  // Keep publishers out of the Agent Console and Browser's persistent sessions.
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
    if (details.resourceType === "subFrame") {
      return reply({ cancel: details.method !== "GET" || !isPimiSpaceEmbed(url) });
    }
    const frame = details.frame;
    const frameUrl = frame && URL.parse(frame.url);
    if (url.origin === origin) {
      const fromConsole = frame && !frame.parent && frameUrl?.origin === origin;
      return reply({ cancel: !fromConsole });
    }
    if (frameUrl && isPimiXEmbed(frameUrl)) {
      return reply({ cancel: !xAsset(url, frameUrl, details.method, details.resourceType) });
    }
    reply({ cancel: !frameUrl || !isPimiVideoEmbed(frameUrl) || !videoAsset(url) });
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
