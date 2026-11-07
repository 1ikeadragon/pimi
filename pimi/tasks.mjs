// Pimi addition to the Paseo fork. Apache-2.0.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

import { commit, RequestError } from "./git.mjs";

const taskFields = z.object({
  title: z.string().trim().min(1).max(100),
  brief: z.string().trim().min(1).max(2400),
  done: z.boolean(),
});
const ideaFields = z.object({
  title: z.string().trim().min(1).max(55),
  hypothesis: z.string().trim().min(1).max(1600),
});
const modelConfig = z.object({
  provider: z.string().min(1),
  thinkingOptionId: z.string().optional(),
});
const experimentSchema = ideaFields.extend({
  id: z.uuid(),
  path: z.string().nullable(),
  workspaceId: z.string().nullable(),
  launch: z.object({ config: modelConfig, prompt: z.string() }).nullable(),
  error: z.string().nullable(),
  report: z.string().max(24000),
  reportSource: z.enum(["agent", "manual"]).nullable(),
  reportTruncated: z.boolean(),
});
const taskSchema = taskFields.extend({
  id: z.uuid(),
  root: z.string(),
  base: z.string(),
  experiments: z.array(experimentSchema),
});
const maxExperiments = 8;
const modelInput = z.object({ id: z.uuid(), model: z.string().min(1).max(512) });

function makeExperiment(idea, card) {
  return {
    ...idea,
    id: randomUUID(),
    path: card?.path ?? null,
    workspaceId: card?.workspaceId ?? null,
    launch: null,
    error: null,
    report: "",
    reportSource: null,
    reportTruncated: false,
  };
}

function readInput(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new RequestError(`${issue.path.join(".") || "Input"}: ${issue.message}`);
  }
  return result.data;
}

function getTask(tasks, id) {
  const task = tasks.find((entry) => entry.id === id);
  if (!task) throw new RequestError("Task not found.", 404);
  return task;
}

function getExperiment(task, id) {
  const experiment = task.experiments.find((entry) => entry.id === id);
  if (!experiment) throw new RequestError("Experiment not found.", 404);
  return experiment;
}

function checkOpen(task) {
  if (task.done) throw new RequestError("Reopen this task to change its experiments.", 409);
}

function experimentPrompt(task, experiment) {
  return [
    "Explore this implementation in your assigned worktree.",
    "Keep all changes local to this worktree. Do not commit, push, open a pull request, or start other agents.",
    "Work on this experiment only. Inspect the code, implement a focused prototype and verify what you can.",
    "Your final message is the experiment report. Include the outcome, files or areas changed, what you verified, and tradeoffs or open questions. Distinguish checks you ran from assumptions.",
    `Task: ${task.title}\n${task.brief}`,
    `Experiment: ${experiment.title}\n${experiment.hypothesis}`,
  ].join("\n\n");
}

export async function createTasks({ file, paseo, getInventory }) {
  let state = [];
  let tail = Promise.resolve();
  const running = new Set();
  let readError;
  if (file) {
    try {
      state = z.array(taskSchema).parse(JSON.parse(await readFile(file, "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.error("Could not read Pimi tasks:", error.message);
        readError = "The task file could not be read. Its contents have been preserved.";
      }
    }
  }

  function update(change) {
    const next = tail.then(async () => {
      if (readError) throw new RequestError(readError, 503);
      const draft = structuredClone(state);
      const result = change(draft);
      if (file) {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file + ".tmp", JSON.stringify(draft), { mode: 0o600 });
        await rename(file + ".tmp", file);
      }
      state = draft;
      return result;
    });
    tail = next.catch(() => undefined);
    return next;
  }

  async function create(body) {
    const input = readInput(
      taskFields.pick({ title: true, brief: true }).extend({
        root: z.string(),
      }),
      body,
    );
    const { repositories } = await getInventory();
    if (!repositories.some((repository) => repository.path === input.root)) {
      throw new RequestError("Choose a repository from Worktrees.");
    }
    const task = {
      ...input,
      id: randomUUID(),
      base: await commit(input.root, "HEAD"),
      done: false,
      experiments: [],
    };
    return update((draft) => {
      draft.unshift(task);
      return task;
    });
  }

  function save(body) {
    const { id, ...input } = readInput(taskFields.extend({ id: z.uuid() }), body);
    return update((draft) => {
      const task = getTask(draft, id);
      if (input.done && running.has(id)) throw new RequestError("Wait for launch to finish.", 409);
      return Object.assign(task, input);
    });
  }

  async function addIdea(body) {
    const { id, path, ...idea } = readInput(
      ideaFields.extend({
        id: z.uuid(),
        path: z.string().optional(),
      }),
      body,
    );
    const card = path && (await getInventory()).cards.find((entry) => entry.path === path);
    return update((draft) => {
      const task = getTask(draft, id);
      checkOpen(task);
      if (task.experiments.length >= maxExperiments) {
        throw new RequestError(`A task can hold up to ${maxExperiments} experiments.`);
      }
      if (path && (!card || card.root !== task.root || card.unavailable)) {
        throw new RequestError("Choose an available worktree from this repository.");
      }
      if (
        card &&
        task.experiments.some(
          (entry) =>
            entry.path === card.path ||
            (card.workspaceId && entry.workspaceId === card.workspaceId),
        )
      )
        throw new RequestError("This worktree is already linked.", 409);
      const experiment = makeExperiment(idea, card);
      task.experiments.push(experiment);
      return experiment;
    });
  }

  async function selectModel(task, model) {
    const { models } = await paseo.taskModels(task.root);
    const selected = models.find((entry) => entry.id === model);
    if (!selected)
      throw new RequestError("This model is unavailable. Refresh the model list.", 409);
    return selected;
  }

  async function suggest(body) {
    const { id, model } = readInput(modelInput, body);
    const task = getTask(state, id);
    checkOpen(task);
    if (running.has(id)) throw new RequestError("Another task operation is in progress.", 409);
    if (task.experiments.length > maxExperiments - 2)
      throw new RequestError("Make room for two drafts first.");
    running.add(id);
    try {
      const selected = await selectModel(task, model);
      const separator = selected.id.indexOf("/");
      const ideas = z
        .array(ideaFields)
        .length(2)
        .safeParse(
          await paseo.suggestExperiments(task, {
            provider: selected.id.slice(0, separator),
            model: selected.id.slice(separator + 1),
            thinkingOptionId: selected.thinkingOptionId,
          }),
        );
      if (!ideas.success)
        throw new RequestError("The model did not return two usable experiments.", 502);
      return update((draft) => {
        const current = getTask(draft, id);
        checkOpen(current);
        if (current.experiments.length > maxExperiments - 2)
          throw new RequestError("Make room for two drafts first.");
        const titles = new Set(current.experiments.map((item) => item.title.toLowerCase()));
        const experiments = ideas.data.map((idea) => {
          const title = idea.title.toLowerCase();
          if (titles.has(title))
            throw new RequestError(
              "The model returned a duplicate idea. Try again or add a draft manually.",
            );
          titles.add(title);
          return makeExperiment(idea);
        });
        current.experiments.push(...experiments);
        return experiments;
      });
    } finally {
      running.delete(id);
    }
  }

  function discard(body) {
    const { id, experimentId } = readInput(
      z.object({ id: z.uuid(), experimentId: z.uuid() }),
      body,
    );
    return update((draft) => {
      const task = getTask(draft, id);
      checkOpen(task);
      const experiment = getExperiment(task, experimentId);
      if (running.has(id) || experiment.path || experiment.launch || experiment.report) {
        throw new RequestError("Only unused drafts can be discarded.", 409);
      }
      task.experiments = task.experiments.filter((item) => item.id !== experimentId);
      return { discarded: true };
    });
  }

  async function run(body) {
    const { id, model } = readInput(modelInput, body);
    if (running.has(id)) throw new RequestError("Experiments are already starting.", 409);
    const task = getTask(state, id);
    checkOpen(task);
    // Limit simultaneous provider and workspace setup calls per task.
    const drafts = task.experiments.filter((entry) => !entry.path && !entry.report);
    if (!drafts.length) throw new RequestError("Add an experiment to start.");
    const pending = drafts
      .filter((entry) => !entry.launch || entry.launch.config.provider === model)
      .slice(0, 4);
    if (!pending.length) {
      throw new RequestError("Retry unfinished launches with their original model.", 409);
    }

    running.add(id);
    try {
      const selected = await selectModel(task, model);
      const config = {
        provider: selected.id,
        ...(selected.thinkingOptionId ? { thinkingOptionId: selected.thinkingOptionId } : {}),
      };
      try {
        await paseo.checkTaskModel(config);
      } catch (error) {
        throw new RequestError(
          `Model check failed: ${error.message} Choose another model or check Agent Console settings.`,
          502,
        );
      }
      const launches = await update((draft) => {
        const current = getTask(draft, id);
        checkOpen(current);
        return pending.map(({ id: experimentId }) => {
          const experiment = getExperiment(current, experimentId);
          if (experiment.report)
            throw new RequestError("An experiment changed. Review the drafts and try again.", 409);
          experiment.workspaceId ??= `wks_${experiment.id.replaceAll("-", "").slice(0, 16)}`;
          experiment.launch ??= { config, prompt: experimentPrompt(current, experiment) };
          experiment.error = null;
          return experiment;
        });
      });
      return await Promise.all(
        launches.map(async (experiment) => {
          let path;
          let error;
          try {
            path = await paseo.launchExperiment(task, experiment);
            if (!path) throw new Error("The workspace did not return a checkout path.");
          } catch (cause) {
            error = cause.message;
          }
          return update((draft) => {
            const current = getExperiment(getTask(draft, id), experiment.id);
            current.path = path ?? null;
            current.error = error ?? null;
            return { id: current.id, error: current.error };
          });
        }),
      );
    } finally {
      running.delete(id);
    }
  }

  async function report(body) {
    const { id, experimentId, text } = readInput(
      z.object({
        id: z.uuid(),
        experimentId: z.uuid(),
        text: z.string().trim().max(5000).optional(),
      }),
      body,
    );
    const task = getTask(state, id);
    checkOpen(task);
    const experiment = getExperiment(task, experimentId);
    if (text === undefined && !experiment.launch) {
      throw new RequestError("This experiment has no Pimi agent.");
    }
    const result = text ?? (await paseo.experimentReport(experimentId));
    return update((draft) => {
      const currentTask = getTask(draft, id);
      checkOpen(currentTask);
      const current = getExperiment(currentTask, experimentId);
      if (text === undefined && current.reportSource) return current;
      current.report = result.slice(0, 24000);
      current.reportSource = text === undefined ? "agent" : "manual";
      if (!current.report) current.reportSource = null;
      current.reportTruncated = result.length > 24000;
      return current;
    });
  }

  return {
    roots: () => [...new Set(state.map((task) => task.root))],
    list: () => ({ tasks: state, error: readError }),
    create,
    save,
    addIdea,
    suggest,
    discard,
    models: ({ id }) => paseo.taskModels(getTask(state, id).root),
    run,
    report,
  };
}
