// Pimi addition to the Paseo fork. Apache-2.0.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { z } from "zod";
import {
  PimiExperimentFields,
  PimiTaskAgentGetInput,
  PimiTaskAgentListInput,
  PimiTaskAgentUpdateInput,
  PimiTaskFields,
  PimiStoredTaskMode,
  PimiTaskProposal,
  PimiTaskStage,
} from "@getpaseo/protocol/pimi-task";

import { workspaceLabelKey } from "@getpaseo/protocol/workspace-labels";

import { commit, RequestError } from "./git.mjs";

const taskFields = PimiTaskFields.extend({ done: z.boolean() });
const ideaFields = PimiExperimentFields;
const taskSource = PimiTaskProposal.shape.source;
const modelConfig = z.object({
  provider: z.string().min(1),
  thinkingOptionId: z.string().optional(),
});
const experimentSchema = ideaFields.extend({
  id: z.uuid(),
  root: z.string().nullable().optional(),
  path: z.string().nullable(),
  workspaceId: z.string().nullable(),
  launch: z
    .object({
      config: modelConfig,
      prompt: z.string(),
      mode: PimiStoredTaskMode.optional(),
      parent: taskSource.optional(),
    })
    .nullable(),
  error: z.string().nullable(),
  report: z.string().max(24000),
  reportSource: z.enum(["agent", "manual"]).nullable(),
  reportTruncated: z.boolean(),
});
const taskSchema = taskFields.extend({
  mode: PimiStoredTaskMode.optional(),
  id: z.uuid(),
  stage: PimiTaskStage.nullable().optional(),
  root: z.string().nullable(),
  base: z.string().nullable(),
  repositories: z.array(z.object({ root: z.string().min(1), base: z.string().min(1) })).optional(),
  source: taskSource.optional(),
  experiments: z.array(experimentSchema),
});
const maxExperiments = 8;
const agentTaskPageSize = 50;
const modelInput = z.object({ id: z.uuid(), model: z.string().min(1).max(512) });

function makeExperiment(idea, card, root = null) {
  return {
    ...idea,
    id: randomUUID(),
    root: card?.root ?? root,
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
  if (!experiment) throw new RequestError("Work item not found.", 404);
  return experiment;
}

function checkOpen(task) {
  if (task.done) throw new RequestError("Reopen this task to change its work items.", 409);
}

function pinRepository(task, root, base) {
  task.repositories.push({ root, base });
  if (!task.root) {
    task.root = root;
    task.base = base;
    for (const item of task.experiments) item.root ??= root;
  }
}

function taskSummary({ id, title, done, stage, repositories, labels, mode }) {
  return {
    id,
    title,
    done,
    stage: stage ?? (done ? "done" : null),
    repositories,
    labels: labels ?? [],
    mode: mode ?? "worktree",
  };
}

function taskDetails(task) {
  return {
    ...taskSummary(task),
    brief: task.brief,
    work: task.experiments.map(({ id, title, hypothesis, path, root, workspaceId, report }) => ({
      id,
      title,
      brief: hypothesis,
      path,
      repository: root,
      workspaceId,
      hasReport: Boolean(report),
    })),
  };
}

function modelDirectory(task) {
  if (task.mode === "chat") return tmpdir();
  if (!task.root || !task.base) throw new RequestError("Attach a repository to start agents.", 409);
  return task.root;
}

function experimentPrompt(task, experiment, mode, repository) {
  const instructions =
    mode === "chat"
      ? [
          "Complete this work item. Save notes and artifacts in your own working directory. Do not create a Git worktree or start other agents.",
          ...(repository ? [`Reference repository (read only): ${repository.root}`] : []),
        ]
      : [
          "Complete the work item in your assigned worktree.",
          "Keep all changes local to this worktree. Do not commit, push, open a pull request, or start other agents.",
        ];
  return [
    ...instructions,
    "Work on this item only. Follow the brief, then verify what you can.",
    "Your final message becomes the report. Include the outcome, files or areas changed, what you verified, and open questions. Distinguish checks you ran from assumptions.",
    `Task: ${task.title}\n${task.brief}`,
    `Work item: ${experiment.title}\n${experiment.hypothesis}`,
  ].join("\n\n");
}

export async function createTasks({ file, paseo, getInventory, onChange = () => {} }) {
  let state = [];
  let tail = Promise.resolve();
  const running = new Set();
  let readError;
  if (file) {
    try {
      state = z.array(taskSchema).parse(JSON.parse(await readFile(file, "utf8")));
      for (const task of state) {
        // An absent override preserves legacy closed tasks; an explicit override owns done.
        if (task.stage !== undefined) task.done = task.stage === "done";
        if (task.mode === "research") task.mode = "chat";
        if (!task.mode || task.mode === "code") task.mode = "worktree";
        task.repositories ??= task.root && task.base ? [{ root: task.root, base: task.base }] : [];
        for (const item of task.experiments) item.root ??= task.root;
      }
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
      onChange();
      return result;
    });
    tail = next.catch(() => undefined);
    return next;
  }

  async function repositoryBase(root) {
    if (!root) return null;
    const { repositories } = await getInventory();
    if (!repositories.some((repository) => repository.path === root)) {
      throw new RequestError("Choose a repository from Work.");
    }
    return commit(root, "HEAD");
  }

  async function validateLabels(names, previous = []) {
    if (names === undefined) return undefined;
    if (!names.length) return [];
    const { labels } = await paseo.labels();
    const catalog = new Map(labels.map((label) => [workspaceLabelKey(label.name), label.name]));
    const retained = new Map(previous.map((name) => [workspaceLabelKey(name), name]));
    return [
      ...new Set(
        names.map((name) => {
          const key = workspaceLabelKey(name);
          const canonical = catalog.get(key) ?? retained.get(key);
          if (!canonical)
            throw new RequestError(`Label “${name}” is not in Paseo. Choose an existing label.`);
          return canonical;
        }),
      ),
    ];
  }

  async function create(body) {
    const input = readInput(
      PimiTaskFields.extend({
        root: z.string().min(1).nullable(),
        proposal: PimiTaskProposal.omit({ title: true, brief: true, mode: true }).optional(),
      }),
      body,
    );
    const { proposal, ...fields } = input;
    const existing = proposal && state.find((task) => task.id === proposal.id);
    if (existing) return existing;
    fields.labels = await validateLabels(fields.labels);
    const base = await repositoryBase(input.root);
    const task = {
      ...fields,
      mode: fields.mode ?? "chat",
      id: proposal?.id ?? randomUUID(),
      base,
      repositories: input.root ? [{ root: input.root, base }] : [],
      done: false,
      source: proposal?.source,
      experiments: (proposal?.experiments ?? []).map((idea) =>
        makeExperiment(idea, null, input.root),
      ),
    };
    return update((draft) => {
      const alreadySaved = draft.find((entry) => entry.id === task.id);
      if (alreadySaved) return alreadySaved;
      draft.unshift(task);
      return task;
    });
  }

  async function attachRepository(body) {
    const { id, root } = readInput(z.object({ id: z.uuid(), root: z.string().min(1) }), body);
    const base = await repositoryBase(root);
    return update((draft) => {
      const task = getTask(draft, id);
      checkOpen(task);
      if (task.repositories.some((repository) => repository.root === root))
        throw new RequestError("This repository is already attached.", 409);
      pinRepository(task, root, base);
      return task;
    });
  }

  async function save(body) {
    const { id, ...input } = readInput(taskFields.partial().extend({ id: z.uuid() }), body);
    if (input.labels !== undefined)
      input.labels = await validateLabels(input.labels, getTask(state, id).labels);
    return update((draft) => {
      const task = getTask(draft, id);
      if (input.mode !== undefined && running.has(id))
        throw new RequestError("Wait for the current task operation to finish.", 409);
      if (input.done && running.has(id)) throw new RequestError("Wait for launch to finish.", 409);
      if (input.done !== undefined && input.done !== task.done) {
        if (input.done) task.stage = "done";
        else if (task.stage === "done") task.stage = null;
      }
      return Object.assign(task, input);
    });
  }

  function applyStage(task, stage) {
    if (stage === "done" && running.has(task.id))
      throw new RequestError("Wait for launch to finish.", 409);
    task.stage = stage;
    task.done = stage === "done";
  }

  function setStage(body) {
    const { id, stage } = readInput(
      z.strictObject({ id: z.uuid(), stage: PimiTaskStage.nullable() }),
      body,
    );
    return update((draft) => {
      const task = getTask(draft, id);
      applyStage(task, stage);
      return task;
    });
  }

  function listForAgent(body) {
    if (readError) throw new RequestError(readError, 503);
    const { query, offset = 0 } = readInput(PimiTaskAgentListInput, body);
    const term = query?.toLowerCase();
    const matches = term
      ? state.filter((task) => `${task.title} ${task.brief}`.toLowerCase().includes(term))
      : state;
    const end = offset + agentTaskPageSize;
    return {
      tasks: matches.slice(offset, end).map(taskSummary),
      nextOffset: end < matches.length ? end : null,
    };
  }

  function getForAgent(body) {
    if (readError) throw new RequestError(readError, 503);
    const { id } = readInput(PimiTaskAgentGetInput, body);
    return { task: taskDetails(getTask(state, id)) };
  }

  async function updateFromAgent(body) {
    if (readError) throw new RequestError(readError, 503);
    const { id, repository, stage, ...fields } = readInput(PimiTaskAgentUpdateInput, body);
    if (!repository && stage === undefined && Object.keys(fields).length === 0)
      throw new RequestError(
        "Specify a title, brief, mode, labels, stage, or repository to change.",
      );
    const current = getTask(state, id);
    if (fields.labels !== undefined)
      fields.labels = await validateLabels(fields.labels, current.labels);
    const base =
      repository && !current.repositories.some(({ root }) => root === repository)
        ? await repositoryBase(repository)
        : null;
    return update((draft) => {
      const task = getTask(draft, id);
      if (fields.mode !== undefined && running.has(id))
        throw new RequestError("Wait for the current task operation to finish.", 409);
      if (base && !task.repositories.some(({ root }) => root === repository)) {
        if (stage === undefined || stage === "done") checkOpen(task);
        pinRepository(task, repository, base);
      }
      if (stage !== undefined) applyStage(task, stage);
      return { task: taskDetails(Object.assign(task, fields)) };
    });
  }

  function assignRepository(body) {
    const { id, experimentId, root } = readInput(
      z.strictObject({ id: z.uuid(), experimentId: z.uuid(), root: z.string().min(1) }),
      body,
    );
    return update((draft) => {
      const task = getTask(draft, id);
      checkOpen(task);
      const item = getExperiment(task, experimentId);
      if (running.has(id) || item.launch || item.path || item.report) {
        throw new RequestError("Only an unstarted draft can change repositories.", 409);
      }
      if (!task.repositories.some((repo) => repo.root === root)) {
        throw new RequestError("Choose a repository attached to this task.");
      }
      item.root = root;
      return item;
    });
  }

  async function addIdea(body) {
    const { id, path, root, ...idea } = readInput(
      ideaFields.extend({
        id: z.uuid(),
        path: z.string().optional(),
        root: z.string().min(1).optional(),
      }),
      body,
    );
    const card = path && (await getInventory()).cards.find((entry) => entry.path === path);
    return update((draft) => {
      const task = getTask(draft, id);
      checkOpen(task);
      const targetRoot = root ?? card?.root ?? task.root;
      if (targetRoot && !task.repositories.some((repository) => repository.root === targetRoot))
        throw new RequestError("Attach this repository to the task first.");
      if (task.experiments.length >= maxExperiments) {
        throw new RequestError(`A task can hold up to ${maxExperiments} work items.`);
      }
      if (path && (!card || card.root !== targetRoot || card.unavailable)) {
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
      const experiment = makeExperiment(idea, card, targetRoot);
      task.experiments.push(experiment);
      return experiment;
    });
  }

  async function selectModel(task, model) {
    const { models } = await paseo.taskModels(modelDirectory(task));
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
        throw new RequestError("The model did not return two usable work items.", 502);
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
          return makeExperiment(idea, null, current.root);
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
    if (running.has(id)) throw new RequestError("Agents are already starting.", 409);
    const task = getTask(state, id);
    checkOpen(task);
    // Limit simultaneous provider and workspace setup calls per task.
    const drafts = task.experiments.filter((entry) => !entry.path && !entry.report);
    if (!drafts.length) throw new RequestError("Add a work item to start.");
    const pending = drafts
      .filter((entry) => !entry.launch || entry.launch.config.provider === model)
      .slice(0, 4);
    if (!pending.length) {
      throw new RequestError("Retry unfinished launches with their original model.", 409);
    }

    running.add(id);
    try {
      const parent =
        task.source && pending.some((entry) => !entry.launch)
          ? await paseo.taskParent(task.source)
          : undefined;
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
          const repository = current.repositories.find((entry) => entry.root === experiment.root);
          const mode = experiment.launch ? experiment.launch.mode : current.mode;
          if (mode !== "chat" && mode !== "research" && !repository)
            throw new RequestError(
              "Attach a repository for every work item before launching.",
              409,
            );
          if (experiment.report)
            throw new RequestError("A work item changed. Review the drafts and try again.", 409);
          experiment.workspaceId ??= `wks_${experiment.id.replaceAll("-", "").slice(0, 16)}`;
          experiment.launch ??= {
            config,
            mode,
            prompt: experimentPrompt(current, experiment, mode, repository),
            ...(parent ? { parent } : {}),
          };
          experiment.error = null;
          return experiment;
        });
      });
      return await Promise.all(
        launches.map(async (experiment) => {
          let path;
          let error;
          try {
            const repository = task.repositories.find((entry) => entry.root === experiment.root);
            path = await paseo.launchExperiment({ ...task, ...repository }, experiment);
            if (!path) throw new Error("The workspace did not return a working directory.");
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
    const { id, experimentId } = readInput(
      z.strictObject({
        id: z.uuid(),
        experimentId: z.uuid(),
      }),
      body,
    );
    const task = getTask(state, id);
    checkOpen(task);
    const experiment = getExperiment(task, experimentId);
    if (experiment.reportSource) return experiment;
    if (!experiment.launch) {
      throw new RequestError("This work item has no Pimi agent.");
    }
    const result = await paseo.experimentReport(experimentId);
    return update((draft) => {
      const currentTask = getTask(draft, id);
      checkOpen(currentTask);
      const current = getExperiment(currentTask, experimentId);
      if (current.reportSource) return current;
      current.report = result.slice(0, 24000);
      current.reportSource = current.report ? "agent" : null;
      current.reportTruncated = result.length > 24000;
      return current;
    });
  }

  function linkedWorktrees() {
    const paths = new Map();
    for (const task of state) {
      for (const item of task.experiments) {
        if (!item.path || item.launch?.mode === "chat" || item.launch?.mode === "research")
          continue;
        if (!paths.has(item.path)) paths.set(item.path, undefined);
        if (item.launch) {
          const repository = task.repositories.find(({ root }) => root === item.root);
          if (repository) paths.set(item.path, repository.base);
        }
      }
    }
    return paths;
  }

  return {
    roots: () => [...new Set(state.flatMap((task) => task.repositories.map(({ root }) => root)))],
    linkedWorktrees,
    list: () => ({ tasks: state, error: readError }),
    reportText(id, experimentId) {
      const item = getExperiment(getTask(state, id), experimentId);
      if (!item.report) throw new RequestError("This report is not ready.", 404);
      return item.report;
    },
    listForAgent,
    getForAgent,
    updateFromAgent,
    create,
    attachRepository,
    assignRepository,
    save,
    setStage,
    addIdea,
    suggest,
    discard,
    models: ({ id }) => paseo.taskModels(modelDirectory(getTask(state, id))),
    run,
    report,
  };
}
