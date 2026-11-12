import type { BrowserElementAttachment } from "@/attachments/types";

export type BrowserElementSelection = Omit<BrowserElementAttachment, "formatted" | "comment"> & {
  attributes?: Record<string, string>;
};

export type ElementSelectorMode = "annotate" | "screenshot";

export type ElementSelectorOutcome =
  | { type: "selected"; mode: ElementSelectorMode; selection: BrowserElementSelection }
  | { type: "cancelled" }
  | { type: "failed"; reason: "loading" | "timeout" | "unavailable" };

export type ElementSelectorStartResult = "started" | "loading" | "unavailable";

export interface ElementSelectorWebview extends HTMLElement {
  isLoading?: () => boolean;
  executeJavaScript?: (code: string) => Promise<unknown>;
}

interface ElementSelectorSession {
  mode: ElementSelectorMode;
  token: string;
  webview: ElementSelectorWebview;
  onFinish: (outcome: ElementSelectorOutcome) => void;
  stopPolling?: () => void;
  timeoutId?: number;
}

export interface ElementSelectorController {
  start(input: {
    webview: ElementSelectorWebview;
    mode: ElementSelectorMode;
    onFinish: (outcome: ElementSelectorOutcome) => void;
  }): ElementSelectorStartResult;
  cancel(): void;
  stopForWebview(webview: ElementSelectorWebview): void;
}

export interface ElementSelectorRuntime {
  token(): string;
  install(
    webview: ElementSelectorWebview,
    sessionToken: string,
  ): Promise<"installed" | "loading" | "unavailable">;
  watch(
    webview: ElementSelectorWebview,
    sessionToken: string,
    onResult: (selection: BrowserElementSelection | null) => void,
  ): () => void;
  clear(webview: ElementSelectorWebview, sessionToken: string): void;
  destroy(webview: ElementSelectorWebview, sessionToken: string): void;
  timeout(callback: () => void): number;
  cancelTimeout(timeoutId: number): void;
}

const SELECTOR_TIMEOUT_MS = 30_000;

function executeWebviewJavaScript(webview: ElementSelectorWebview, code: string): Promise<unknown> {
  if (!webview.isConnected) {
    return Promise.resolve(null);
  }
  try {
    return webview.executeJavaScript?.(code) ?? Promise.resolve(null);
  } catch (error) {
    return Promise.reject(error);
  }
}

function ignoreWebviewJavaScriptError() {}

function destroyWebviewSelector(webview: ElementSelectorWebview, sessionToken: string): void {
  const token = JSON.stringify(sessionToken);
  void executeWebviewJavaScript(
    webview,
    `if (window.__pimiSelector?.sessionToken === ${token}) window.__pimiSelector.destroy();`,
  ).catch(ignoreWebviewJavaScriptError);
}

function clearWebviewSelector(webview: ElementSelectorWebview, sessionToken: string): void {
  const token = JSON.stringify(sessionToken);
  void executeWebviewJavaScript(
    webview,
    `if (window.__pimiSelector?.sessionToken === ${token}) window.__pimiSelector.destroy(); if (window.__pimiSelectorResult?.__pimiSessionToken === ${token}) window.__pimiSelectorResult = null;`,
  ).catch(ignoreWebviewJavaScriptError);
}

function readSelectorInstallation(
  value: unknown,
  sessionToken: string,
): "installed" | "loading" | "unavailable" {
  if (value === null || typeof value !== "object") {
    return "unavailable";
  }
  if (Reflect.get(value, "sessionToken") !== sessionToken) {
    return "unavailable";
  }
  if (Reflect.get(value, "installed") === true) {
    return "installed";
  }
  return Reflect.get(value, "reason") === "document-loading" ? "loading" : "unavailable";
}

function startSelectorResultPolling(input: {
  webview: ElementSelectorWebview;
  sessionToken: string;
  onResult: (selection: BrowserElementSelection | null) => void;
}): () => void {
  const { webview, sessionToken, onResult } = input;
  const token = JSON.stringify(sessionToken);
  let stopped = false;
  let timerId: number | undefined;

  const schedule = () => {
    if (!stopped) {
      timerId = window.setTimeout(poll, 200);
    }
  };
  const poll = () => {
    void (async () => {
      try {
        const raw = await executeWebviewJavaScript(
          webview,
          `JSON.stringify(window.__pimiSelectorResult?.__pimiSessionToken === ${token} ? window.__pimiSelectorResult : null)`,
        );
        const result = typeof raw === "string" ? JSON.parse(raw) : null;
        if (!result) {
          schedule();
          return;
        }
        stopped = true;
        await executeWebviewJavaScript(
          webview,
          `if (window.__pimiSelectorResult?.__pimiSessionToken === ${token}) window.__pimiSelectorResult = null;`,
        ).catch(ignoreWebviewJavaScriptError);
        const cancelled = result.__cancelled === true;
        delete result.__cancelled;
        delete result.__pimiSessionToken;
        onResult(cancelled ? null : (result as BrowserElementSelection));
      } catch {
        schedule();
      }
    })();
  };

  schedule();
  return () => {
    stopped = true;
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
    }
  };
}

function buildElementSelectorScript(sessionToken: string): string {
  const token = JSON.stringify(sessionToken);
  return `
    (function() {
      var sessionToken = ${token};
      if (document.readyState === 'loading' || !document.head || !document.documentElement) {
        return { installed: false, reason: 'document-loading', sessionToken: sessionToken };
      }
      if (window.__pimiSelector) { window.__pimiSelector.destroy(); }
      window.__pimiSelectorResult = null;
      var style = document.createElement('style');
      style.textContent = [
        '.__pimi-hover { outline: 2px solid #3b82f6 !important; outline-offset: 2px !important; cursor: crosshair !important; }',
        '.__pimi-select-mode, .__pimi-select-mode * { cursor: crosshair !important; pointer-events: auto !important; user-select: none !important; }',
        '.__pimi-select-mode *, .__pimi-select-mode *::before, .__pimi-select-mode *::after { animation: none !important; transition: none !important; }',
        '.__pimi-select-mode a, .__pimi-select-mode button, .__pimi-select-mode input, .__pimi-select-mode select, .__pimi-select-mode textarea, .__pimi-select-mode [role="button"], .__pimi-select-mode [onclick] { pointer-events: none !important; }',
        '.__pimi-select-mode iframe, .__pimi-select-mode video, .__pimi-select-mode audio { pointer-events: none !important; }',
        '.__pimi-hover-label { position: fixed; z-index: 2147483647; pointer-events: none; max-width: 360px; padding: 4px 8px; border-radius: 6px; background: rgba(24,24,27,0.96); color: #fff; font: 500 11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace; box-shadow: 0 2px 10px rgba(0,0,0,0.35); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
        '.__pimi-hover-label .__pimi-tag { color: #93c5fd; }',
        '.__pimi-hover-label .__pimi-id { color: #fca5a5; }',
        '.__pimi-hover-label .__pimi-cls { color: #fcd34d; }',
        '.__pimi-hover-label .__pimi-dim { color: #a1a1aa; margin-left: 6px; }',
        '.__pimi-hover-label .__pimi-comp { color: #86efac; margin-left: 6px; }',
      ].join('\\n');
      document.head.appendChild(style);
      document.documentElement.classList.add('__pimi-select-mode');
      var hoverLabel = document.createElement('div');
      hoverLabel.className = '__pimi-hover-label';
      hoverLabel.style.display = 'none';
      document.documentElement.appendChild(hoverLabel);
      var last = null;
      function escapeHtml(value) {
        return String(value).replace(/[&<>"]/g, function(ch) {
          return ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : '&quot;';
        });
      }
      function describeElement(el) {
        var tag = el.tagName ? el.tagName.toLowerCase() : 'node';
        var parts = ['<span class="__pimi-tag">' + escapeHtml(tag) + '</span>'];
        if (el.id) {
          parts.push('<span class="__pimi-id">#' + escapeHtml(el.id) + '</span>');
        }
        if (el.classList && el.classList.length) {
          var cls = Array.prototype.slice.call(el.classList, 0, 2)
            .filter(function(c) { return c.indexOf('__pimi') !== 0; })
            .map(function(c) { return '.' + escapeHtml(c); })
            .join('');
          if (cls) parts.push('<span class="__pimi-cls">' + cls + '</span>');
        }
        var comp = getReactSource(el);
        if (comp && comp.componentName) {
          parts.push('<span class="__pimi-comp">&lt;' + escapeHtml(comp.componentName) + '&gt;</span>');
        }
        var rect = el.getBoundingClientRect();
        parts.push('<span class="__pimi-dim">' + Math.round(rect.width) + '×' + Math.round(rect.height) + '</span>');
        return { html: parts.join(''), rect: rect };
      }
      function positionLabel(rect, e) {
        var lw = hoverLabel.offsetWidth || 0;
        var lh = hoverLabel.offsetHeight || 0;
        var top = rect.top - lh - 6;
        if (top < 4) top = rect.bottom + 6;
        if (top + lh > window.innerHeight - 4) top = Math.max(4, e.clientY - lh - 6);
        var left = rect.left;
        if (left + lw > window.innerWidth - 4) left = Math.max(4, window.innerWidth - lw - 4);
        if (left < 4) left = 4;
        hoverLabel.style.top = Math.round(top) + 'px';
        hoverLabel.style.left = Math.round(left) + 'px';
      }
      function onMove(e) {
        e.preventDefault();
        e.stopPropagation();
        if (last) last.classList.remove('__pimi-hover');
        var el = e.target;
        el.classList.add('__pimi-hover');
        last = el;
        try {
          var info = describeElement(el);
          hoverLabel.innerHTML = info.html;
          hoverLabel.style.display = 'block';
          positionLabel(info.rect, e);
        } catch (err) {
          hoverLabel.style.display = 'none';
        }
      }
      function buildSelector(el) {
        if (el.id) return '#' + el.id;
        var path = [];
        while (el && el.nodeType === 1) {
          var seg = el.tagName.toLowerCase();
          if (el.id) { path.unshift('#' + el.id); break; }
          var sib = el, nth = 1;
          while (sib = sib.previousElementSibling) { if (sib.tagName === el.tagName) nth++; }
          if (nth > 1) seg += ':nth-of-type(' + nth + ')';
          path.unshift(seg);
          el = el.parentElement;
        }
        return path.join(' > ');
      }
      function getReactSource(el) {
        var keys = Object.keys(el);
        for (var i = 0; i < keys.length; i++) {
          if (keys[i].startsWith('__reactFiber$') || keys[i].startsWith('__reactInternalInstance$')) {
            var fiber = el[keys[i]];
            while (fiber) {
              if (fiber._debugSource) {
                return {
                  fileName: fiber._debugSource.fileName || null,
                  lineNumber: fiber._debugSource.lineNumber || null,
                  columnNumber: fiber._debugSource.columnNumber || null,
                  componentName: (fiber.type && (typeof fiber.type === 'string' ? fiber.type : fiber.type.displayName || fiber.type.name)) || null
                };
              }
              if (fiber._debugOwner) { fiber = fiber._debugOwner; }
              else if (fiber.return) { fiber = fiber.return; }
              else break;
            }
          }
        }
        return null;
      }
      function getParentChain(el, depth) {
        var chain = [];
        var cur = el.parentElement;
        for (var i = 0; i < (depth || 5) && cur; i++) {
          var desc = cur.tagName.toLowerCase();
          if (cur.id) desc += '#' + cur.id;
          if (cur.className && typeof cur.className === 'string') { var cls = cur.className.trim().split(/\\s+/).filter(function(c) { return c && c.indexOf('__pimi') !== 0; }).slice(0,2).join('.'); if (cls) desc += '.' + cls; }
          chain.push(desc);
          cur = cur.parentElement;
        }
        return chain;
      }
      function getChildSummary(el, max) {
        var kids = [];
        for (var i = 0; i < Math.min(el.children.length, max || 8); i++) {
          var c = el.children[i];
          var desc = c.tagName.toLowerCase();
          if (c.id) desc += '#' + c.id;
          kids.push(desc);
        }
        if (el.children.length > (max || 8)) kids.push('...(' + el.children.length + ' total)');
        return kids;
      }
      function getRelevantStyles(el) {
        var cs = window.getComputedStyle(el);
        var pick = ['display','position','width','height','color','background-color','font-size','font-family','padding','margin','border','flex','grid-template-columns','gap','overflow','opacity','z-index'];
        var out = {};
        pick.forEach(function(p) {
          var v = cs.getPropertyValue(p);
          if (v && v !== 'none' && v !== 'normal' && v !== 'auto' && v !== '0px' && v !== 'rgba(0, 0, 0, 0)') out[p] = v;
        });
        return out;
      }
      function onClick(e) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        var el = e.target;
        if (last) last.classList.remove('__pimi-hover');
        hoverLabel.style.display = 'none';
        var attrs = {};
        for (var i = 0; i < el.attributes.length; i++) {
          attrs[el.attributes[i].name] = el.attributes[i].value;
        }
        var rect = el.getBoundingClientRect();
        var result = {
          tag: el.tagName.toLowerCase(),
          text: (el.innerText || '').substring(0, 500),
          selector: buildSelector(el),
          attributes: attrs,
          url: location.href,
          outerHTML: el.outerHTML.substring(0, 2000),
          computedStyles: getRelevantStyles(el),
          __pimiSessionToken: sessionToken,
          boundingRect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
          reactSource: getReactSource(el),
          parentChain: getParentChain(el, 5),
          children: getChildSummary(el, 8)
        };
        destroy();
        window.__pimiSelectorResult = result;
      }
      function onKey(e) {
        if (e.key === 'Escape') {
          destroy();
          window.__pimiSelectorResult = { __cancelled: true, __pimiSessionToken: sessionToken };
        }
      }
      function blockEvent(e) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      }
      function destroy() {
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('mousedown', blockEvent, true);
        document.removeEventListener('mouseup', blockEvent, true);
        document.removeEventListener('pointerdown', blockEvent, true);
        document.removeEventListener('pointerup', blockEvent, true);
        document.removeEventListener('touchstart', blockEvent, true);
        document.removeEventListener('touchend', blockEvent, true);
        document.removeEventListener('focus', blockEvent, true);
        document.removeEventListener('submit', blockEvent, true);
        document.documentElement.classList.remove('__pimi-select-mode');
        if (last) last.classList.remove('__pimi-hover');
        if (hoverLabel.parentNode) hoverLabel.parentNode.removeChild(hoverLabel);
        style.remove();
        window.__pimiSelector = null;
      }
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKey, true);
      document.addEventListener('mousedown', blockEvent, true);
      document.addEventListener('mouseup', blockEvent, true);
      document.addEventListener('pointerdown', blockEvent, true);
      document.addEventListener('pointerup', blockEvent, true);
      document.addEventListener('touchstart', blockEvent, true);
      document.addEventListener('touchend', blockEvent, true);
      document.addEventListener('focus', blockEvent, true);
      document.addEventListener('submit', blockEvent, true);
      window.__pimiSelector = { destroy: destroy, sessionToken: sessionToken };
      return { installed: true, sessionToken: sessionToken };
    })()
  `;
}

function browserSelectorRuntime(): ElementSelectorRuntime {
  let sequence = 0;
  return {
    token() {
      sequence += 1;
      return `${sequence}:${crypto.randomUUID()}`;
    },
    async install(webview, sessionToken) {
      const result = await executeWebviewJavaScript(
        webview,
        buildElementSelectorScript(sessionToken),
      );
      return readSelectorInstallation(result, sessionToken);
    },
    watch: (webview, sessionToken, onResult) =>
      startSelectorResultPolling({ webview, sessionToken, onResult }),
    clear: clearWebviewSelector,
    destroy: destroyWebviewSelector,
    timeout: (callback) => window.setTimeout(callback, SELECTOR_TIMEOUT_MS),
    cancelTimeout: (timeoutId) => window.clearTimeout(timeoutId),
  };
}

class ElementSelectorOwner implements ElementSelectorController {
  private current: ElementSelectorSession | null = null;

  constructor(private readonly runtime: ElementSelectorRuntime) {}

  start({
    webview,
    mode,
    onFinish,
  }: Parameters<ElementSelectorController["start"]>[0]): ElementSelectorStartResult {
    if (!webview.isConnected) return "unavailable";
    if (webview.isLoading?.()) return "loading";
    if (this.current) this.finish(this.current, { type: "cancelled" }, "clear");
    const session: ElementSelectorSession = {
      mode,
      token: this.runtime.token(),
      webview,
      onFinish,
    };
    this.current = session;
    session.timeoutId = this.runtime.timeout(() =>
      this.finish(session, { type: "failed", reason: "timeout" }, "destroy"),
    );
    void this.install(session);
    return "started";
  }

  cancel(): void {
    if (this.current) this.finish(this.current, { type: "cancelled" }, "clear");
  }

  stopForWebview(webview: ElementSelectorWebview): void {
    if (this.current?.webview === webview) {
      this.finish(this.current, { type: "cancelled" }, "destroy");
    }
  }

  private async install(session: ElementSelectorSession): Promise<void> {
    let state: "installed" | "loading" | "unavailable";
    try {
      state = await this.runtime.install(session.webview, session.token);
    } catch {
      this.finish(session, { type: "failed", reason: "unavailable" }, "destroy");
      return;
    }
    if (this.current !== session) {
      if (state === "installed") this.runtime.destroy(session.webview, session.token);
      return;
    }
    if (state !== "installed") {
      this.finish(session, { type: "failed", reason: state }, null);
      return;
    }
    session.stopPolling = this.runtime.watch(session.webview, session.token, (selection) =>
      this.finish(
        session,
        selection ? { type: "selected", mode: session.mode, selection } : { type: "cancelled" },
        null,
      ),
    );
  }

  private finish(
    session: ElementSelectorSession,
    outcome: ElementSelectorOutcome,
    cleanup: "clear" | "destroy" | null,
  ): boolean {
    if (this.current !== session) return false;
    session.stopPolling?.();
    session.stopPolling = undefined;
    if (session.timeoutId !== undefined) {
      this.runtime.cancelTimeout(session.timeoutId);
      session.timeoutId = undefined;
    }
    this.current = null;
    if (cleanup) this.runtime[cleanup](session.webview, session.token);
    session.onFinish(outcome);
    return true;
  }
}

export function createElementSelectorController(
  runtime: ElementSelectorRuntime = browserSelectorRuntime(),
): ElementSelectorController {
  return new ElementSelectorOwner(runtime);
}
