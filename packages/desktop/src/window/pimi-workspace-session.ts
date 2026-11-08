// Pimi addition to the Paseo fork. Apache-2.0.
import { session } from "electron";
import {
  isPimiArxivEmbed,
  isPimiSpaceEmbed,
  isPimiVideoEmbed,
  isPimiXEmbed,
  PIMI_ARXIV_EMBED_ORIGIN,
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

const arxivStaticOrigin = "https://static.arxiv.org";
const arxivDocumentFilter = { urls: [`${PIMI_ARXIV_EMBED_ORIGIN}/html/*`] };
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
    if (frameUrl && isPimiArxivEmbed(frameUrl)) {
      return reply({ cancel: !arxivAsset(url, frameUrl, details.method, details.resourceType) });
    }
    reply({ cancel: !frameUrl || !isPimiVideoEmbed(frameUrl) || !videoAsset(url) });
  });

  isolated.webRequest.onBeforeSendHeaders(
    {
      urls: [
        `${PIMI_VIDEO_EMBED_ORIGIN}/embed/*`,
        `${PIMI_ARXIV_EMBED_ORIGIN}/*`,
        `${arxivStaticOrigin}/*`,
      ],
    },
    (details, reply) => {
      const url = URL.parse(details.url);
      if (url?.origin === PIMI_ARXIV_EMBED_ORIGIN || url?.origin === arxivStaticOrigin) {
        const requestHeaders = Object.fromEntries(
          Object.entries(details.requestHeaders).filter(
            ([key]) => !["authorization", "cookie", "referer"].includes(key.toLowerCase()),
          ),
        );
        reply({ requestHeaders });
      } else if (details.resourceType === "subFrame" && url && isPimiVideoEmbed(url)) {
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

  const reportPaperUnavailable = (
    details: Electron.OnHeadersReceivedListenerDetails | Electron.OnErrorOccurredListenerDetails,
  ) => {
    const contents = details.webContents;
    if (contents && !contents.isDestroyed()) {
      contents.send("pimi:workspace:paper-unavailable", details.url);
    }
  };
  isolated.webRequest.onHeadersReceived(arxivDocumentFilter, (details, reply) => {
    const url = URL.parse(details.url);
    if (details.resourceType !== "subFrame" || !url || !isPimiArxivEmbed(url)) return reply({});
    const headers = Object.entries(details.responseHeaders ?? {});
    const contentType = headers.find(([key]) => key.toLowerCase() === "content-type")?.[1][0];
    if (details.statusCode !== 200 || !/^text\/html(?:;|$)/i.test(contentType ?? "")) {
      // Reject redirects and alternate content before a frame can navigate or render.
      reportPaperUnavailable(details);
      return reply({ cancel: true });
    }
    const policy = headers.find(([key]) => key.toLowerCase() === "content-security-policy");
    const responseHeaders = Object.fromEntries(headers);
    responseHeaders[policy?.[0] ?? "Content-Security-Policy"] = [
      ...(policy?.[1] ?? []),
      arxivDocumentCsp,
    ];
    reply({ responseHeaders });
  });
  isolated.webRequest.onErrorOccurred(arxivDocumentFilter, (details) => {
    const url = URL.parse(details.url);
    if (
      details.resourceType === "subFrame" &&
      details.error !== "net::ERR_ABORTED" &&
      url &&
      isPimiArxivEmbed(url)
    ) {
      reportPaperUnavailable(details);
    }
  });
  return isolated;
}
