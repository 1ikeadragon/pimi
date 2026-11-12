// Pimi. Apache-2.0.
// A YouTube card shows a static poster until it is played. The window asks this daemon-side
// helper, never YouTube, so the thumbnail is fetched once per video and kept for the session;
// the response is immutable for the window's own HTTP cache across restarts.
const POSTER_ORIGIN = "https://i.ytimg.com";
const MAX_POSTER_BYTES = 512 * 1024;
const MAX_POSTERS = 300;
const FETCH_CONCURRENCY = 4;
const FETCH_TIMEOUT_MS = 8000;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export function createSpacePosters() {
  const posters = new Map();
  let running = 0;
  const waiting = [];

  async function slot() {
    if (running >= FETCH_CONCURRENCY) await new Promise((resolve) => waiting.push(resolve));
    running++;
  }

  async function download(id) {
    await slot();
    try {
      const response = await fetch(`${POSTER_ORIGIN}/vi/${id}/hqdefault.jpg`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: "error",
      });
      const data = Buffer.from(await response.arrayBuffer());
      if (
        !response.ok ||
        response.headers.get("content-type") !== "image/jpeg" ||
        data.length > MAX_POSTER_BYTES
      )
        return null;
      return data;
    } catch {
      return null;
    } finally {
      running--;
      waiting.shift()?.();
    }
  }

  return {
    /** The JPEG poster of a YouTube video, or null when it cannot be had (not cached). */
    poster(id) {
      if (!VIDEO_ID.test(id ?? "")) return Promise.resolve(null);
      let pending = posters.get(id);
      if (!pending) {
        pending = download(id);
        pending.then((data) => data || posters.delete(id));
        posters.set(id, pending);
        while (posters.size > MAX_POSTERS) posters.delete(posters.keys().next().value);
      }
      return pending;
    },
  };
}
