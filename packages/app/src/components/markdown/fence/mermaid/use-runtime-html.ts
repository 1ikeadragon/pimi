import { useEffect, useState } from "react";

// `runtime/html.gen.ts` is a 3.5 MB string. Nothing imports it statically: the first diagram that
// mounts loads it with `import()`, so it stays out of the app's startup bundle. Every diagram
// after it shares the one promise.
let loading: Promise<string> | null = null;
let loaded: string | null = null;

function loadRuntimeHtml(): Promise<string> {
  loading ??= import("./runtime/html.gen").then(
    (module) => {
      loaded = module.mermaidRuntimeHtml;
      return module.mermaidRuntimeHtml;
    },
    (error: unknown) => {
      // A failed fetch must not be remembered, or no diagram could ever load in this session.
      loading = null;
      throw error;
    },
  );
  return loading;
}

export interface MermaidRuntimeHtml {
  /** The runtime document, or null while it loads or after it failed to load. */
  html: string | null;
  failed: boolean;
}

export function useMermaidRuntimeHtml(): MermaidRuntimeHtml {
  const [html, setHtml] = useState<string | null>(loaded);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (html !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const value = await loadRuntimeHtml();
        if (!cancelled) setHtml(value);
      } catch (error) {
        console.error("[mermaid] Failed to load the diagram runtime", error);
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [html]);

  return { html, failed };
}
