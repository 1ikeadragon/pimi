// Pimi addition to the Paseo fork. Apache-2.0.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { setImmediate } from "node:timers/promises";
import {
  darkHighlightColors,
  highlightCodeWithBudget,
  isLanguageSupported,
  lightHighlightColors,
} from "@getpaseo/highlight";
import {
  createReview,
  discoverWorktrees,
  filePatch,
  fileSource,
  openInEditor,
  patchFingerprint,
  repository,
  RequestError,
  worktreeFacts,
} from "./git.mjs";
import { createPaseoConnection } from "./paseo.mjs";
import { createTasks } from "./tasks.mjs";
import { generateTour } from "./walkthrough.mjs";

const appearances = new Set(["system", "light", "dark", "paper"]);

export async function startPimi({
  paths = [],
  port = 0,
  followPaseo = true,
  connection,
  native = false,
  watchState,
  taskState,
  appearanceState,
  onAppearanceChange,
  launchEditor,
  openDictation,
} = {}) {
  const host = "127.0.0.1";
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid Pimi port.");
  let address;
  let origin;
  const roots = [...new Set(await Promise.all(paths.map(repository)))];
  if (watchState) {
    try {
      const stored = JSON.parse(await readFile(watchState, "utf8"));
      if (
        !Array.isArray(stored) ||
        !stored.every((path) => typeof path === "string" && isAbsolute(path))
      ) {
        throw new Error("Invalid watched repository list.");
      }
      for (const path of stored) if (!roots.includes(path)) roots.push(path);
    } catch (error) {
      if (error.code !== "ENOENT")
        console.error("Could not load watched repositories:", error.message);
    }
  }
  let saveTask = Promise.resolve();
  const paseo = createPaseoConnection({ connection, native });
  const tasks = await createTasks({ file: taskState, paseo, getInventory });
  let appearance = "system";
  let appearanceWrites = Promise.resolve();
  if (appearanceState) {
    try {
      const stored = JSON.parse(await readFile(appearanceState, "utf8"));
      if (appearances.has(stored)) appearance = stored;
    } catch (error) {
      if (error.code !== "ENOENT") console.error("Could not read Pimi appearance:", error.message);
    }
  }

  async function saveAppearance({ mode }) {
    if (!appearances.has(mode)) throw new RequestError("Choose a supported appearance.");
    const save = appearanceWrites.then(async () => {
      if (appearanceState) {
        await mkdir(dirname(appearanceState), { recursive: true });
        const temporary = appearanceState + ".tmp";
        await writeFile(temporary, JSON.stringify(mode), { mode: 0o600 });
        await rename(temporary, appearanceState);
      }
      appearance = mode;
      onAppearanceChange?.(mode);
      return { mode };
    });
    appearanceWrites = save.catch(() => undefined);
    return save;
  }

  const assets = new Map(
    await Promise.all(
      [
        ["/", "index.html", "text/html; charset=utf-8"],
        ["/app.js", "app.js", "text/javascript; charset=utf-8"],
        ["/tasks.js", "tasks.js", "text/javascript; charset=utf-8"],
        ["/style.css", "style.css", "text/css; charset=utf-8"],
        ["/grain.svg", "grain.svg", "image/svg+xml"],
      ].map(async ([path, file, mime]) => [
        path,
        { mime, data: await readFile(new URL(`./public/${file}`, import.meta.url)) },
      ]),
    ),
  );
  assets.set("/syntax.css", {
    mime: "text/css; charset=utf-8",
    data: Object.entries(lightHighlightColors)
      .map(
        ([role, color]) =>
          `.syntax-${role} { color: light-dark(${color}, ${darkHighlightColors[role] ?? color}); }`,
      )
      .join("\n"),
  });
  const reviews = new Map();
  const reviewLimit = 32;
  let worktrees = new Map();
  let inventoryTask;
  let inventoryAt = 0;
  let inventory;

  function cardLane(facts, workspace, agents) {
    const state = workspace?.state;
    if (
      facts.unavailable ||
      facts.error ||
      state === "needs_input" ||
      state === "failed" ||
      agents.some((agent) => agent.needsInput || agent.status === "error")
    )
      return "attention";
    if (
      state === "running" ||
      agents.some((agent) => agent.status === "running" || agent.status === "initializing")
    )
      return "running";
    if (facts.dirty || facts.ahead || state === "attention" || workspace?.openPrUrl)
      return "review";
    return "ready";
  }

  async function loadInventory() {
    const daemonTask = paseo.directory();
    const localRoots = [...new Set([...roots, ...tasks.roots()])];
    const localDiscovery = Promise.allSettled(localRoots.map(discoverWorktrees));
    const [local, daemon] = await Promise.all([localDiscovery, daemonTask]);
    const extra = followPaseo
      ? [...new Set(daemon.workspaces.map((workspace) => workspace.root).filter(Boolean))].filter(
          (root) => !localRoots.includes(root),
        )
      : [];
    const discovery = [...local, ...(await Promise.allSettled(extra.map(discoverWorktrees)))];
    const watchedRoots = [...localRoots, ...extra];
    const listed = new Map();
    const warnings = [];
    discovery.forEach((result, index) => {
      if (result.status === "fulfilled") {
        for (const worktree of result.value) {
          if (!listed.has(worktree.path)) {
            listed.set(worktree.path, { ...worktree, root: watchedRoots[index] });
          }
        }
      } else {
        warnings.push(`${watchedRoots[index]}: ${result.reason.message}`);
      }
    });
    const byWorkspaceId = new Map(daemon.workspaces.map((workspace) => [workspace.id, workspace]));
    const byPath = new Map();
    for (const workspace of daemon.workspaces) {
      if (!workspace.path) continue;
      const canonical = await realpath(workspace.path).catch(() => workspace.path);
      byPath.set(canonical, workspace);
    }
    const agentsByPath = new Map();
    for (const agent of daemon.agents) {
      const cwd = byWorkspaceId.get(agent.workspaceId)?.path || agent.cwd;
      const path = await realpath(cwd).catch(() => cwd);
      const group = agentsByPath.get(path) ?? [];
      group.push(agent);
      agentsByPath.set(path, group);
    }

    const cards = [];
    const trackedAgents = new Set();
    const entries = [...listed.values()];
    const gitConcurrency = 6;
    for (let i = 0; i < entries.length; i += gitConcurrency) {
      const batch = await Promise.all(
        entries.slice(i, i + gitConcurrency).map(async (worktree) => {
          const facts = await worktreeFacts(worktree);
          const canonical = await realpath(worktree.path).catch(() => worktree.path);
          const workspace = byPath.get(canonical);
          const agents = agentsByPath.get(canonical) ?? [];
          for (const agent of agents) trackedAgents.add(agent.id);
          return Object.assign(facts, {
            name: workspace?.name || worktree.branch,
            lane: cardLane(facts, workspace, agents),
            agents,
            workspaceId: workspace?.id,
            prUrl: workspace?.openPrUrl,
            previews: workspace?.previews,
          });
        }),
      );
      cards.push(...batch);
    }
    worktrees = new Map(cards.map((card) => [card.path, card]));
    return {
      cards,
      repositories: watchedRoots.map((path) => ({ path, name: basename(path) || path })),
      otherAgents: daemon.agents.filter((agent) => !trackedAgents.has(agent.id)),
      daemonError: daemon.error,
      warnings,
      native,
    };
  }

  function getInventory() {
    // Concurrent tabs share the same Git and daemon reads. Fast clicks use the last inventory.
    if (inventory && Date.now() - inventoryAt < 1500) return inventory;
    inventoryTask ??= loadInventory()
      .then((result) => {
        inventory = result;
        inventoryAt = Date.now();
        return result;
      })
      .finally(() => {
        inventoryTask = undefined;
      });
    return inventoryTask;
  }

  async function jsonInput(request) {
    if (request.headers["content-type"] !== "application/json") {
      throw new RequestError("Expected application/json.", 415);
    }
    let raw = "";
    for await (const chunk of request) {
      raw += chunk;
      if (raw.length > 8192) throw new RequestError("Request body is too large.", 413);
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
    response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(value));
  }

  function getReview(id) {
    const review = reviews.get(id);
    if (!review) throw new RequestError("The review expired. Reopen it from the board.", 404);
    reviews.delete(id);
    reviews.set(id, review);
    return review;
  }

  function getFile(review, path) {
    const file = review.byPath.get(path);
    if (!file) throw new RequestError("This path is not in the selected review.", 404);
    return file;
  }

  async function startReview({ path, baseRef, prUrl, mode }) {
    if (
      typeof path !== "string" ||
      typeof baseRef !== "string" ||
      typeof prUrl !== "string" ||
      !["all", "working", "committed"].includes(mode)
    ) {
      throw new RequestError("Invalid review selection.");
    }
    const worktree = worktrees.get(path);
    if (!worktree || worktree.unavailable) {
      throw new RequestError("Select an available worktree from the board.", 404);
    }
    const review = await createReview(worktree, { baseRef, prUrl, mode });
    const id = randomUUID();
    reviews.set(id, { ...review, byPath: new Map(review.files.map((file) => [file.path, file])) });
    if (reviews.size > reviewLimit) reviews.delete(reviews.keys().next().value);
    return { id, ...review };
  }

  async function startEditor(body) {
    const review = getReview(body.id);
    const file = body.path === null ? null : getFile(review, body.path);
    if (file && (!Number.isSafeInteger(body.line) || body.line < 1)) {
      throw new RequestError("Invalid line number.");
    }
    if (file && review.live) {
      const fingerprint = patchFingerprint(await filePatch(review, file));
      if (body.fingerprint !== fingerprint) {
        throw new RequestError(
          "The diff changed since you opened it. Reload changes before opening this line.",
          409,
        );
      }
    }
    await openInEditor(review, file, body.line, launchEditor);
    return { opened: true };
  }

  async function persistRepository(root) {
    const stored = [...new Set([...roots, root])];
    await mkdir(dirname(watchState), { recursive: true });
    const temporary = watchState + ".tmp";
    await writeFile(temporary, JSON.stringify(stored), { mode: 0o600 });
    await rename(temporary, watchState);
    if (!roots.includes(root)) roots.push(root);
  }

  async function watchRepository({ path }) {
    if (typeof path !== "string" || !isAbsolute(path)) {
      throw new RequestError("Enter an absolute path to a local Git repository.");
    }
    const root = await repository(path);
    await inventoryTask;
    if (!roots.includes(root)) {
      if (watchState) {
        const save = saveTask.then(() => persistRepository(root));
        saveTask = save.catch(() => undefined);
        await save;
      } else {
        roots.push(root);
      }
    }
    inventoryAt = 0;
    return getInventory();
  }

  const postRoutes = new Map([
    ["/api/repositories", watchRepository],
    ["/api/review", startReview],
    ["/api/editor", startEditor],
    ["/api/tour", (body) => generateTour(getReview(body.id), paseo.explain)],
    ["/api/tasks/create", tasks.create],
    ["/api/tasks/repository", tasks.attachRepository],
    ["/api/tasks/save", tasks.save],
    ["/api/tasks/experiment", tasks.addIdea],
    ["/api/tasks/suggest", tasks.suggest],
    ["/api/tasks/discard", tasks.discard],
    ["/api/tasks/models", tasks.models],
    ["/api/tasks/run", tasks.run],
    ["/api/tasks/report", tasks.report],
    ["/api/appearance", saveAppearance],
    [
      "/api/dictation",
      async () => {
        if (!openDictation)
          throw new RequestError("Dictation is available in the desktop app.", 503);
        return { text: await openDictation() };
      },
    ],
  ]);

  const server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader(
      "content-security-policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
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
        const asset = assets.get(url.pathname);
        if (asset) {
          response.writeHead(200, { "content-type": asset.mime });
          response.end(
            url.pathname === "/"
              ? asset.data
                  .toString("utf8")
                  .replace('data-appearance="system"', `data-appearance="${appearance}"`)
              : asset.data,
          );
          return;
        }
        if (url.pathname === "/api/board") return json(response, await getInventory());
        if (url.pathname === "/api/tasks") return json(response, tasks.list());
        if (url.pathname === "/api/file" || url.pathname === "/api/source") {
          const review = getReview(url.searchParams.get("id"));
          const file = getFile(review, url.searchParams.get("path"));
          if (url.pathname === "/api/source") {
            const source = await fileSource(review, file);
            const tokens = isLanguageSupported(file.path)
              ? await highlightCodeWithBudget(source, file.path, { yieldToEventLoop: setImmediate })
              : null;
            return json(response, { source, tokens });
          }
          const patch = await filePatch(review, file);
          return json(response, { patch, fingerprint: patchFingerprint(patch) });
        }
      }

      if (request.method === "POST") {
        if (request.headers.origin !== origin)
          throw new RequestError("Invalid request origin.", 403);
        const handler = postRoutes.get(url.pathname);
        if (handler) return json(response, await handler(await jsonInput(request)));
      }
      throw new RequestError("Pimi could not find that route.", 404);
    } catch (error) {
      if (!response.destroyed) {
        json(
          response,
          { error: error.message },
          error instanceof RequestError ? error.status : 500,
        );
      }
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
    appearance,
    close: () => {
      server.close();
      return paseo.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = process.argv.slice(2);
  const pimi = await startPimi({
    paths: paths.length ? paths : [process.cwd()],
    port: Number(process.env.PIMI_PORT || 4781),
    followPaseo: process.env.PIMI_FOLLOW_PASEO === "1",
    taskState: process.env.PIMI_TASK_STATE,
    appearanceState: process.env.PIMI_APPEARANCE_STATE,
  });
  console.log(`Pimi is ready at ${pimi.origin}`);
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => {
      void pimi.close();
    });
}
