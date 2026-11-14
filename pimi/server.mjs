// Pimi. PolyForm-Noncommercial-1.0.0.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PIMI_ARXIV_EMBED_ORIGIN,
  PIMI_SPACE_REQUEST_BYTES,
  PIMI_VIDEO_EMBED_ORIGIN,
  PIMI_X_EMBED_PAGE,
} from "@pimi/protocol/pimi-task";
import { RequestError } from "./git.mjs";
import { createPimiConnection } from "./pimi.mjs";
import { createSpacePosters } from "./space-poster.mjs";
import { runVoiceCommand } from "./voice-command.mjs";

const appearances = new Set([
  "system",
  "light",
  "dark",
  "paper",
  "sakura",
  "cel-night",
  "ayu-light",
  "one-dark",
  "nord",
  "gruvbox",
  "catppuccin-mocha",
]);
async function standaloneAppearance(file) {
  let mode = "system";
  let writes = Promise.resolve();
  if (file) {
    try {
      const stored = JSON.parse(await readFile(file, "utf8"));
      if (appearances.has(stored)) mode = stored;
    } catch (error) {
      if (error.code !== "ENOENT") console.error("Could not read Pimi appearance:", error.message);
    }
  }
  return {
    read: () => mode,
    save({ mode: requestedMode }) {
      if (!appearances.has(requestedMode)) throw new RequestError("Choose a supported appearance.");
      const save = writes.then(async () => {
        if (file) {
          await mkdir(dirname(file), { recursive: true });
          const temporary = file + ".tmp";
          await writeFile(temporary, JSON.stringify(requestedMode), {
            mode: 0o600,
          });
          await rename(temporary, file);
        }
        mode = requestedMode;
        return { mode };
      });
      writes = save.catch(() => undefined);
      return save;
    },
  };
}

export async function startPimi({
  port = 0,
  connection,
  native = false,
  dataHome,
  appearanceState,
  getAppearance,
  onActivity = () => {},
} = {}) {
  const host = "127.0.0.1";
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid Pimi port.");
  let address;
  let origin;
  let closed = false;
  const pimi = createPimiConnection({ connection, native, dataHome });
  const appearance = getAppearance
    ? { read: getAppearance }
    : await standaloneAppearance(appearanceState);

  const unsubscribePimi = pimi.subscribe((event) => {
    if (!closed && event.activity) onActivity(event.activity);
  });

  const assets = new Map(
    await Promise.all(
      [
        ["/", "index.html", "text/html; charset=utf-8"],
        ["/app.js", "app.js", "text/javascript; charset=utf-8"],
        ["/memory.js", "memory.js", "text/javascript; charset=utf-8"],
        ["/spaces.js", "spaces.js", "text/javascript; charset=utf-8"],
        ["/spaces.css", "spaces.css", "text/css; charset=utf-8"],
        ["/style.css", "style.css", "text/css; charset=utf-8"],
        ["/pimi-mark.svg", "pimi-mark.svg", "image/svg+xml"],
      ].map(async ([path, file, mime]) => [
        path,
        {
          mime,
          data: await readFile(new URL(`./public/${file}`, import.meta.url)),
        },
      ]),
    ),
  );
  const textures = new URL(
    native ? "./public/pimi-textures/" : "../packages/app/public/pimi-textures/",
    import.meta.url,
  );
  await Promise.all(
    [
      "appearance.css",
      "blush.svg",
      "paper.svg",
      "graphite.svg",
      "voice-pimi.svg",
      "sakura.svg",
      "cel-night.svg",
    ].map(async (file) => {
      assets.set("/pimi-textures/" + file, {
        mime: file.endsWith(".css") ? "text/css; charset=utf-8" : "image/svg+xml",
        data: await readFile(new URL(file, textures)),
      });
    }),
  );
  async function jsonInput(request, limit = 8192) {
    if (request.headers["content-type"] !== "application/json") {
      throw new RequestError("Expected application/json.", 415);
    }
    let raw = "";
    request.setEncoding("utf8");
    for await (const chunk of request) {
      raw += chunk;
      if (raw.length > limit) throw new RequestError("Request body is too large.", 413);
    }
    try {
      const value = JSON.parse(raw);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      // Invalid JSON and invalid top-level types have the same request error.
    }
    throw new RequestError("Invalid JSON request.");
  }

  function json(response, value, status = 200) {
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
    });
    response.end(JSON.stringify(value));
  }

  function requestFailed(response, error) {
    if (!response.destroyed) {
      json(response, { error: error.message }, error instanceof RequestError ? error.status : 500);
    }
  }

  const postRoutes = new Map([
    ["/api/memory", pimi.memory],
    ["/api/spaces", pimi.spaces],
    ...(appearance.save ? [["/api/appearance", appearance.save]] : []),
  ]);

  const postBodyLimits = new Map([["/api/spaces", PIMI_SPACE_REQUEST_BYTES]]);
  async function respondSpaceImage(request, response, id) {
    if (request.headers["sec-fetch-site"] !== "same-origin") {
      throw new RequestError("Open this image in Pimi Spaces.", 403);
    }
    const { mime, data } = await pimi.spaces({ action: "image", id });
    // A card's image never changes under its id, so the window keeps it instead of asking again.
    response.writeHead(200, {
      "content-type": mime,
      "cache-control": "private, max-age=31536000, immutable",
    });
    response.end(Buffer.from(data, "base64"));
  }

  const spacePosters = createSpacePosters();
  async function respondSpacePoster(request, response, id) {
    if (request.headers["sec-fetch-site"] !== "same-origin") {
      throw new RequestError("Open this poster in Pimi Spaces.", 403);
    }
    const data = await spacePosters.poster(id);
    if (!data) throw new RequestError("This video has no poster.", 404);
    // A video's poster is kept by the window, so Spaces never asks again.
    response.writeHead(200, {
      "content-type": "image/jpeg",
      "cache-control": "private, max-age=31536000, immutable",
    });
    response.end(data);
  }

  const server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("permissions-policy", "autoplay=()");
    response.setHeader(
      "content-security-policy",
      `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-src ${PIMI_VIDEO_EMBED_ORIGIN}/embed/ ${PIMI_X_EMBED_PAGE} ${PIMI_ARXIV_EMBED_ORIGIN}/html/; frame-ancestors 'none'; form-action 'self'; base-uri 'none'`,
    );

    try {
      if (
        request.headers.host !== address ||
        (request.headers.origin && request.headers.origin !== origin) ||
        request.headers["sec-fetch-site"] === "cross-site"
      ) {
        throw new RequestError("This request must come from the local Pimi window.", 403);
      }
      const url = new URL(request.url, origin);
      if (request.method === "GET") {
        if (url.pathname === "/api/spaces/image") {
          await respondSpaceImage(request, response, url.searchParams.get("id"));
          return;
        }
        if (url.pathname === "/api/spaces/poster") {
          await respondSpacePoster(request, response, url.searchParams.get("v"));
          return;
        }
        const asset = assets.get(url.pathname);
        if (asset) {
          response.writeHead(200, { "content-type": asset.mime });
          response.end(
            url.pathname === "/"
              ? asset.data
                  .toString("utf8")
                  .replace('data-appearance="system"', `data-appearance="${appearance.read()}"`)
              : asset.data,
          );
          return;
        }
      }

      if (request.method === "POST") {
        if (request.headers.origin !== origin)
          throw new RequestError("Invalid request origin.", 403);
        const handler = postRoutes.get(url.pathname);
        if (handler) {
          const body = await jsonInput(request, postBodyLimits.get(url.pathname));
          return json(response, await handler(body, response));
        }
      }
      throw new RequestError("Pimi could not find that route.", 404);
    } catch (error) {
      requestFailed(response, error);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  address = `${host}:${server.address().port}`;
  origin = `http://${address}`;
  return {
    origin,
    appearance: appearance.read(),
    observeWorkspaces: () => pimi.observeWorkspaces(),
    importTasks: (tasks) => pimi.taskImport(tasks),
    localServerId: () => pimi.localServerId(),
    runVoiceCommand: (input, onStatus) => runVoiceCommand(input, { pimi }, onStatus),
    close: () => {
      closed = true;
      unsubscribePimi();
      server.close();
      return pimi.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pimi = await startPimi({
    port: Number(process.env.PIMI_BOARD_PORT || 4781),
    appearanceState: process.env.PIMI_APPEARANCE_STATE,
  });
  console.log(`Pimi is ready at ${pimi.origin}`);
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => {
      void pimi.close();
    });
}
