import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { readHtmlPreviewHeight, withPreviewCsp, type HtmlPreviewEmbed } from "./html-preview-csp";

// `allow-scripts` alone: the file gets an opaque origin, so a plan page can run
// its own scripts (Excalidraw, charts) but cannot reach the Pimi app's DOM,
// cookies, or storage, and cannot navigate the top window. Agent-written HTML is
// not trusted markup. No popup tokens — a preview is a viewer, not a browser, and
// escaping the sandbox to open one buys nothing for reading a local plan. The same
// isolation means storage APIs throw inside the frame; pages that want to persist
// state have to export.
//
// A sandboxed frame may still navigate *itself*, and nothing in CSP stops that
// (see html-preview-csp.ts). That is the one hole left on web, it is bounded to
// the page's own contents, and it is documented in SECURITY.md rather than papered
// over with a directive browsers ignore.
const SANDBOX = "allow-scripts";

export function FileHtmlPreview({
  html,
  title,
  testID,
  embed,
  onContentHeight,
}: {
  html: string;
  title?: string;
  testID?: string;
  /** Themes the document. */
  embed?: HtmlPreviewEmbed;
  onContentHeight?: (height: number) => void;
}) {
  const { t } = useTranslation();
  const frame = useRef<HTMLIFrameElement>(null);
  // A document URL lets the browser resolve fragment links within the preview.
  // srcDoc would inherit the app URL and navigate the frame back into Pimi.
  const reportHeight = Boolean(onContentHeight);
  const source = useMemo(
    () =>
      `data:text/html;charset=utf-8,${encodeURIComponent(withPreviewCsp(html, embed, reportHeight))}`,
    [html, embed, reportHeight],
  );
  useEffect(() => {
    if (!onContentHeight) return;
    // The frame is untrusted. Only its own window is listened to, and only a height is read.
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const height = readHtmlPreviewHeight(event.data);
      if (height !== null) onContentHeight(height);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [onContentHeight]);
  const style = useMemo(
    () => ({
      flex: 1,
      minHeight: 0,
      border: "none",
      backgroundColor: embed ? "transparent" : "white",
    }),
    [embed],
  );
  return (
    <iframe
      ref={frame}
      data-testid={testID}
      title={title ?? t("panels.file.filePanels.builtin.html")}
      src={source}
      sandbox={SANDBOX}
      referrerPolicy="no-referrer"
      style={style}
    />
  );
}
