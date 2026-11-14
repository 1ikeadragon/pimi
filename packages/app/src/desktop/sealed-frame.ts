import { useEffect, useState } from "react";
import { getDesktopHost } from "@/desktop/host";

// On desktop the console's CSP allows no inline script, and a srcdoc, data: or blob: frame
// inherits it. Sandboxed documents that run inline scripts are served by the desktop main
// process from pimi://frame/<token> with their own policy. Plain web has no bridge and keeps
// the old inline path.
export function hasSealedFrames(): boolean {
  return Boolean(getDesktopHost()?.sealedFrames);
}

/** The pimi://frame URL for `html`, or null while it registers. Released on change and unmount. */
export function useSealedFrameUrl(kind: "preview", html: string): string | null {
  const [state, setState] = useState<{ html: string; url: string } | null>(null);
  useEffect(() => {
    const frames = getDesktopHost()?.sealedFrames;
    if (!frames) return;
    let url: string | null = null;
    let cancelled = false;
    void (async () => {
      const created = await frames.put(kind, html);
      if (cancelled) {
        void frames.release(created);
        return;
      }
      url = created;
      setState({ html, url: created });
    })();
    return () => {
      cancelled = true;
      if (url) void frames.release(url);
    };
  }, [kind, html]);
  return state?.html === html ? state.url : null;
}

let mermaidRuntimeUrl: Promise<string> | null = null;

/** Registered once per window and shared by every diagram; main drops it with the window. */
export function sealedMermaidRuntimeUrl(html: string): Promise<string> {
  const frames = getDesktopHost()?.sealedFrames;
  if (!frames) throw new Error("Sealed frames are not available.");
  mermaidRuntimeUrl ??= frames.put("mermaid", html).catch((error: unknown) => {
    mermaidRuntimeUrl = null;
    throw error;
  });
  return mermaidRuntimeUrl;
}
