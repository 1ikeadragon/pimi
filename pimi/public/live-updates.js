// Pimi. Apache-2.0.
export function connectLiveUpdates({ refreshBoard, refreshTasks, status }) {
  let source;
  let pendingBoard = true;
  let pendingTasks = true;
  let flushing = false;
  let timer;
  let fallback;
  let stopped = false;
  const visible = () =>
    !document.hidden && document.documentElement.dataset.workspaceLayout !== "hidden";

  async function flush() {
    if (stopped || flushing || !visible()) return;
    const board = pendingBoard;
    const tasks = pendingTasks;
    pendingBoard = pendingTasks = false;
    flushing = true;
    try {
      const results = await Promise.all([
        board ? refreshBoard() : true,
        tasks ? refreshTasks() : true,
      ]);
      if (results.includes(false)) {
        status("Updates are delayed. Retrying automatically.");
        startFallback();
      } else if (source?.readyState === EventSource.OPEN) {
        clearInterval(fallback);
        fallback = undefined;
        status("");
      }
    } finally {
      flushing = false;
      if (pendingBoard || pendingTasks) schedule();
    }
  }

  function schedule() {
    if (timer || stopped || !visible()) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, 100);
  }

  function invalidate(board = true, tasks = true) {
    pendingBoard ||= board;
    pendingTasks ||= tasks;
    schedule();
  }

  function startFallback() {
    if (fallback) return;
    // EventSource reconnects itself. Poll only while streaming is unavailable,
    // with the same coalescing and single in-flight refresh as live events.
    fallback = setInterval(() => invalidate(), 10000);
  }

  function open() {
    if (source || stopped || !visible()) return;
    if (!window.EventSource) {
      status("Live connection unavailable. Checking for changes automatically.");
      startFallback();
      invalidate();
      return;
    }
    source = new EventSource("/api/events");
    source.addEventListener("ready", () => {
      clearInterval(fallback);
      fallback = undefined;
      status("");
      invalidate();
    });
    source.addEventListener("board", () => invalidate(true, false));
    source.addEventListener("tasks", () => invalidate(false, true));
    source.addEventListener("retry", () => {
      status("Updates are delayed. Retrying automatically.");
      startFallback();
    });
    source.addEventListener("error", () => {
      status("Reconnecting to live updates… Your current view is preserved.");
      startFallback();
    });
  }

  function visibilityChanged() {
    if (!visible()) {
      source?.close();
      source = undefined;
      clearInterval(fallback);
      fallback = undefined;
      return;
    }
    open();
    invalidate();
  }
  document.addEventListener("visibilitychange", visibilityChanged);
  window.addEventListener("pimi-layout-change", visibilityChanged);
  window.addEventListener("online", () => invalidate());
  window.addEventListener("pagehide", () => {
    stopped = true;
    source?.close();
    source = undefined;
    clearInterval(fallback);
    clearTimeout(timer);
    fallback = timer = undefined;
  });
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    stopped = false;
    visibilityChanged();
  });
  open();
  invalidate();
}
