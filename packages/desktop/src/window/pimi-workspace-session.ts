// Pimi. PolyForm-Noncommercial-1.0.0.
import { NETWORK_PURPOSE } from "@pimi/protocol/network-activity";
import { observeSessionNetwork } from "../diagnostics/network-activity.js";
import { session } from "electron";
import {
  isPimiArxivEmbed,
  isPimiSpaceEmbed,
  isPimiVideoEmbed,
  isPimiXEmbed,
  PIMI_ARXIV_EMBED_ORIGIN,
  PIMI_VIDEO_EMBED_ORIGIN,
} from "@pimi/protocol/pimi-task";

function videoAsset(url: URL, method: string, resource: string): boolean {
  if (url.protocol !== "https:" || url.port || url.username || url.password) return false;
  const { hostname, pathname } = url;
  if (["www.youtube-nocookie.com", "www.youtube.com"].includes(hostname)) {
    if (resource === "xhr" && method === "POST") return pathname === "/youtubei/v1/player";
    return (
      method === "GET" &&
      ["script", "stylesheet", "image"].includes(resource) &&
      pathname.startsWith("/s/player/")
    );
  }
  if (hostname.endsWith(".googlevideo.com")) {
    return method === "GET" && ["media", "xhr"].includes(resource) && pathname === "/videoplayback";
  }
  if (method !== "GET") return false;
  if (["i.ytimg.com", "i9.ytimg.com"].includes(hostname)) {
    return resource === "image" && /^\/(?:vi|vi_webp|sb)\//.test(pathname);
  }
  return hostname === "fonts.gstatic.com" && resource === "font" && pathname.startsWith("/s/");
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
      return (
        resource === "image" &&
        /^\/(?:media|profile_images|ext_tw_video_thumb|amplify_video_thumb)\//.test(url.pathname)
      );
    default:
      return false;
  }
}

const arxivStaticOrigin = "https://static.arxiv.org";
const arxivDocumentPrefix = `${PIMI_ARXIV_EMBED_ORIGIN}/html/`;
const arxivDocumentCsp = [
  "default-src 'none'",
  `style-src 'unsafe-inline' ${PIMI_ARXIV_EMBED_ORIGIN} ${arxivStaticOrigin}`,
  `img-src data: ${PIMI_ARXIV_EMBED_ORIGIN}`,
  `font-src ${PIMI_ARXIV_EMBED_ORIGIN} ${arxivStaticOrigin}`,
  "base-uri 'none'",
  "form-action 'none'",
  "sandbox",
].join("; ");

function arxivStaticAsset(url: URL, resource: string): boolean {
  if (url.search) return false;
  const designSystem = "/static/design-system/latest/";
  if (!url.pathname.startsWith(designSystem)) return false;
  const asset = url.pathname.slice(designSystem.length);
  if (resource === "stylesheet")
    return asset === "fonts.css" || asset === "design-system-components.css";
  return (
    resource === "font" &&
    /^fonts\/(?:IBMPlex(?:Sans(?:Condensed)?|Mono|Serif)-[A-Za-z]+|STIXTwoMath-Regular)\.woff2$/.test(
      asset,
    )
  );
}

function arxivAsset(url: URL, frameUrl: URL, method: string, resource: string): boolean {
  if (method !== "GET" || url.username || url.password) return false;
  if (url.origin === arxivStaticOrigin) return arxivStaticAsset(url, resource);
  if (url.origin !== PIMI_ARXIV_EMBED_ORIGIN) return false;
  if (resource === "font") {
    return (
      !url.search &&
      /^\/static\/browse\/\d+\.\d+\.\d+\/fonts\/STIXTwoMath-Regular\.woff2$/.test(url.pathname)
    );
  }
  if (resource === "stylesheet") {
    return (
      (!url.search &&
        /^\/static\/browse\/\d+\.\d+\.\d+\/css\/(?:arxiv-html-papers(?:-theme)?(?:-\d{8})?|ar5iv\.\d+\.\d+\.\d+\.min)\.css$/.test(
          url.pathname,
        )) ||
      (/^\/static\/base\/\d+\.\d+\.\d+\/css\/arxiv-header-footer\.css$/.test(url.pathname) &&
        (!url.search || /^\?v=\d{8}$/.test(url.search)))
    );
  }
  if (resource !== "image" || url.search || !url.pathname.startsWith(frameUrl.pathname))
    return false;
  let assetPath = url.pathname.slice(frameUrl.pathname.length);
  if (!/v[1-9]\d*$/.test(frameUrl.pathname)) assetPath = assetPath.replace(/^v[1-9]\d*(?=\/)/, "");
  return (
    /^\/(?:[\w.~%-]+\/)*[\w.~%-]+\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(assetPath) &&
    !/%(?!20)/.test(assetPath)
  );
}

function publisherAsset(url: URL, frameUrl: URL, method: string, resource: string): boolean {
  if (isPimiXEmbed(frameUrl)) return xAsset(url, frameUrl, method, resource);
  if (isPimiArxivEmbed(frameUrl)) return arxivAsset(url, frameUrl, method, resource);
  return isPimiVideoEmbed(frameUrl) && videoAsset(url, method, resource);
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
      const parentUrl = details.frame?.parent?.url;
      return reply({
        cancel:
          details.method !== "GET" ||
          !isPimiSpaceEmbed(url) ||
          Boolean(parentUrl && URL.parse(parentUrl)?.origin !== origin),
      });
    }
    const frame = details.frame;
    const frameUrl = frame && URL.parse(frame.url);
    if (url.origin === origin) {
      const fromConsole = frame && !frame.parent && frameUrl?.origin === origin;
      return reply({ cancel: !fromConsole });
    }
    reply({
      cancel: !frameUrl || !publisherAsset(url, frameUrl, details.method, details.resourceType),
    });
  });

  isolated.webRequest.onBeforeSendHeaders(network, (details, reply) => {
    const url = URL.parse(details.url);
    if (!url || url.origin === origin) return reply({});
    const requestHeaders = Object.fromEntries(
      Object.entries(details.requestHeaders).filter(
        ([key]) => !["authorization", "cookie", "referer"].includes(key.toLowerCase()),
      ),
    );
    if (details.resourceType === "subFrame" && isPimiVideoEmbed(url)) {
      // YouTube requires an embed referrer. Never send the local workspace URL.
      requestHeaders.Referer = "https://com.pimi.desktop/";
    }
    reply({ requestHeaders });
  });

  const reportPaperUnavailable = (
    details: Electron.OnHeadersReceivedListenerDetails | Electron.OnErrorOccurredListenerDetails,
  ) => {
    const contents = details.webContents;
    if (contents && !contents.isDestroyed()) {
      contents.send("pimi:workspace:paper-unavailable", details.url);
    }
  };
  isolated.webRequest.onHeadersReceived(network, (details, reply) => {
    const url = URL.parse(details.url);
    if (!url || url.origin === origin) return reply({});
    const headers = Object.entries(details.responseHeaders ?? {}).filter(
      ([key]) => key.toLowerCase() !== "set-cookie",
    );
    const responseHeaders = Object.fromEntries(headers);
    if (details.resourceType !== "subFrame" || !isPimiArxivEmbed(url))
      return reply({ responseHeaders });
    const contentType = headers.find(([key]) => key.toLowerCase() === "content-type")?.[1][0];
    if (details.statusCode !== 200 || !/^text\/html(?:;|$)/i.test(contentType ?? "")) {
      // Reject redirects and alternate content before a frame can navigate or render.
      reportPaperUnavailable(details);
      return reply({ cancel: true });
    }
    const policy = headers.find(([key]) => key.toLowerCase() === "content-security-policy");
    responseHeaders[policy?.[0] ?? "Content-Security-Policy"] = [
      ...(policy?.[1] ?? []),
      arxivDocumentCsp,
    ];
    reply({ responseHeaders });
  });
  // Electron keeps one onErrorOccurred per session, so the paper check runs inside the observer.
  observeSessionNetwork(isolated, {
    source: "app",
    purpose: NETWORK_PURPOSE.spaces,
    onErrorOccurred: (details) => {
      if (!details.url.startsWith(arxivDocumentPrefix)) return;
      const url = URL.parse(details.url);
      if (
        details.resourceType === "subFrame" &&
        details.error !== "net::ERR_ABORTED" &&
        url &&
        isPimiArxivEmbed(url)
      ) {
        reportPaperUnavailable(details);
      }
    },
  });
  return isolated;
}
