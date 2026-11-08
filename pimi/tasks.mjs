// Pimi addition to the Paseo fork. Apache-2.0.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { z } from "zod";
import {
  PIMI_TASK_PAGE_SIZE,
  PimiExperimentFields,
  PimiMobileTaskOperation,
  PimiMobileTaskResult,
  PimiTaskAgentCreateInput,
  PimiTaskAgentGetInput,
  PimiTaskAgentListInput,
  PimiTaskAgentUpdateInput,
  PimiTaskFields,
  PimiStoredTaskMode,
  PimiTaskProposal,
  PimiTaskSource,
  PimiTaskStage,
} from "@getpaseo/protocol/pimi-task";

import { workspaceLabelKey } from "@getpaseo/protocol/workspace-labels";

import { commit, git, RequestError } from "./git.mjs";

const dateTime = z.iso.datetime({ offset: true });
const pullRequestSchema = z.object({
  url: z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/),
  state: z.enum(["open", "closed", "merged"]),
  title: z.string().optional(),
  mergedAt: dateTime.optional(),
});
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
  pullRequest: pullRequestSchema.optional(),
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
  completedByPullRequest: z.literal(true).optional(),
  completedAt: dateTime.optional(),
  root: z.string().nullable(),
  base: z.string().nullable(),
  repositories: z.array(z.object({ root: z.string().min(1), base: z.string().min(1) })).optional(),
  source: taskSource.optional(),
  experiments: z.array(experimentSchema),
});
const maxExperiments = 8;
const recapPageSize = 100;
const modelInput = z.object({ id: z.uuid(), model: z.string().min(1).max(512) });

function storedPullRequest(pr, previous) {
  const same = previous?.url === pr.url && previous.state === pr.state;
  const mergedAt = dateTime.safeParse(pr.mergedAt);
  return {
    url: pr.url,
    state: pr.state,
    title: pr.title?.trim() || (same ? previous.title : undefined),
    mergedAt:
      pr.state === "merged" ? (mergedAt.data ?? (same ? previous.mergedAt : undefined)) : undefined,
  };
}

function makeExperiment(idea, card, root = null) {
  const pr = card?.pullRequest;
  return {
    ...idea,
    id: randomUUID(),
    root: card?.root ?? root,
    path: card?.path ?? null,
    workspaceId: card?.workspaceId ?? null,
    pullRequest: pr && storedPullRequest(pr),
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
    work: task.experiments.map(
      ({ id, title, hypothesis, path, root, workspaceId, report, pullRequest }) => ({
        id,
        title,
        brief: hypothesis,
        path,
        repository: root,
        workspaceId,
        hasReport: Boolean(report),
        ...(pullRequest ? { pullRequest: pullRequest.url } : {}),
      }),
    ),
  };
}

function isLinkedWorktree(item) {
  return Boolean(item.path && item.root && !["chat", "research"].includes(item.launch?.mode));
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
  let workspaceObservation;
  function resetWorkspaceObservation() {
    workspaceObservation = { verifiedMerges: new Set(), liveMerges: new Set() };
  }
  resetWorkspaceObservation();
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

  function update(change, { skipUnchanged = false, applies = () => true } = {}) {
    const next = tail.then(async () => {
      if (readError) throw new RequestError(readError, 503);
      if (!applies()) return;
      const draft = structuredClone(state);
      const result = await change(draft);
      if (skipUnchanged && !result) return result;
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

  function updateCatalogLabel(event) {
    const previousName = event.kind === "remove" ? event.name : event.previousName;
    if (!previousName) return;
    const key = workspaceLabelKey(previousName);
    return update(
      (draft) => {
        let changed = false;
        for (const task of draft) {
          if (!task.labels?.some((name) => workspaceLabelKey(name) === key)) continue;
          const replacement = event.kind === "remove" ? [] : [event.label.name];
          task.labels = [
            ...new Set(
              task.labels.flatMap((name) =>
                workspaceLabelKey(name) === key ? replacement : [name],
              ),
            ),
          ];
          changed = true;
        }
        return changed;
      },
      { skipUnchanged: true },
    );
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
    const task = await buildTask(fields, {
      id: proposal?.id,
      source: proposal?.source,
      ideas: proposal?.experiments,
    });
    return (await insertTask(task, (draft) => draft.find(({ id }) => id === task.id))).task;
  }

  async function buildTask(fields, { id = randomUUID(), source, ideas = [], stage } = {}) {
    const base = await repositoryBase(fields.root);
    return {
      ...fields,
      mode: fields.mode ?? "chat",
      id,
      base,
      repositories: fields.root ? [{ root: fields.root, base }] : [],
      done: stage === "done",
      stage,
      source,
      experiments: ideas.map((idea) => makeExperiment(idea, null, fields.root)),
    };
  }

  async function insertTask(task, findExisting) {
    let existing;
    const saved = await update(
      async (draft) => {
        existing = findExisting(draft);
        if (existing) return null;
        task.labels = await validateLabels(task.labels);
        if (task.done) task.completedAt = new Date().toISOString();
        draft.unshift(task);
        return task;
      },
      { skipUnchanged: true },
    );
    return { task: saved ?? existing, created: Boolean(saved) };
  }

  async function createFromAgent(body) {
    if (readError) throw new RequestError(readError, 503);
    const { repository, stage, source, ...fields } = readInput(
      PimiTaskAgentCreateInput.extend({ source: PimiTaskSource }),
      body,
    );
    // Coalesce retries from the same chat. A closed task can be tracked again.
    const findExisting = (entries) =>
      entries.find(
        (task) =>
          !task.done &&
          task.source?.serverId === source.serverId &&
          task.source.agentId === source.agentId &&
          task.title === fields.title &&
          task.brief === fields.brief &&
          (!repository || task.repositories.some(({ root }) => root === repository)),
      );
    const existing = findExisting(state);
    if (existing) return { task: taskDetails(existing), created: false, source };
    const record = await buildTask({ ...fields, root: repository ?? null }, { source, stage });
    const saved = await insertTask(record, findExisting);
    return { task: taskDetails(saved.task), created: saved.created, source };
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
    return update(async (draft) => {
      const task = getTask(draft, id);
      if (input.labels !== undefined)
        input.labels = await validateLabels(input.labels, task.labels);
      if (input.mode !== undefined && running.has(id))
        throw new RequestError("Wait for the current task operation to finish.", 409);
      if (input.done && running.has(id)) throw new RequestError("Wait for launch to finish.", 409);
      if (input.done !== undefined && input.done !== task.done) {
        recordCompletion(task, input.done);
        forgetTaskMergeTriggers(task);
        if (input.done) task.stage = "done";
        else if (task.stage === "done") task.stage = null;
      }
      return Object.assign(task, input);
    });
  }

  function applyStage(task, stage) {
    if (stage === "done" && running.has(task.id))
      throw new RequestError("Wait for launch to finish.", 409);
    recordCompletion(task, stage === "done");
    task.stage = stage;
    task.done = stage === "done";
    forgetTaskMergeTriggers(task);
  }

  function recordCompletion(task, done) {
    if (!done) delete task.completedAt;
    else if (!task.done) task.completedAt = new Date().toISOString();
  }

  function forgetTaskMergeTriggers(task) {
    delete task.completedByPullRequest;
    for (const item of task.experiments) workspaceObservation.liveMerges.delete(item.id);
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
    const end = offset + PIMI_TASK_PAGE_SIZE;
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

  async function mobileTask(body) {
    if (readError) throw new RequestError(readError, 503);
    const operation = readInput(PimiMobileTaskOperation, body);
    if (operation.action === "list") {
      const { tasks, nextOffset } = listForAgent({
        query: operation.query,
        offset: operation.offset,
      });
      return PimiMobileTaskResult.parse({ kind: "page", tasks, nextOffset });
    }

    let task;
    if (operation.action === "get") {
      task = getTask(state, operation.id);
    } else if (operation.action === "set-stage") {
      task = await setStage({ id: operation.id, stage: operation.stage });
    } else {
      const { id, title, brief } = operation;
      const candidate = await buildTask({ title, brief, root: null }, { id });
      const saved = await insertTask(candidate, (draft) => draft.find((item) => item.id === id));
      task = saved.task;
      if (task.title !== title || task.brief !== brief) {
        throw new RequestError("This task ID has already been used.", 409);
      }
    }

    return PimiMobileTaskResult.parse({
      kind: "task",
      task: { id: task.id, title: task.title, brief: task.brief, stage: taskSummary(task).stage },
    });
  }

  async function updateFromAgent(body) {
    if (readError) throw new RequestError(readError, 503);
    const { id, repository, stage, ...fields } = readInput(PimiTaskAgentUpdateInput, body);
    if (!repository && stage === undefined && Object.keys(fields).length === 0)
      throw new RequestError(
        "Specify a title, brief, mode, labels, stage, or repository to change.",
      );
    const current = getTask(state, id);
    const base =
      repository && !current.repositories.some(({ root }) => root === repository)
        ? await repositoryBase(repository)
        : null;
    return update(async (draft) => {
      const task = getTask(draft, id);
      if (fields.labels !== undefined)
        fields.labels = await validateLabels(fields.labels, task.labels);
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
    if (!task.completedByPullRequest) checkOpen(task);
    const experiment = getExperiment(task, experimentId);
    if (experiment.reportSource) return experiment;
    if (!experiment.launch) {
      throw new RequestError("This work item has no Pimi agent.");
    }
    const result = await paseo.experimentReport(experimentId);
    return update((draft) => {
      const currentTask = getTask(draft, id);
      if (!currentTask.completedByPullRequest) checkOpen(currentTask);
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

  async function observeWorkspace(workspace, observedMerge) {
    if (readError || !workspace.root || !workspace.path) return;
    const observation = workspaceObservation;
    const { verifiedMerges, liveMerges } = observation;
    const candidate = (item) =>
      isLinkedWorktree(item) &&
      (item.workspaceId ? item.workspaceId === workspace.id : item.path === workspace.path);
    let canonicalWorkspacePath;
    let checkoutGitDir;
    const repositories = new Map();
    const canonicalPath = (path) => realpath(path).catch(() => null);
    const commonGitDir = (path) =>
      git(path, "rev-parse", "--path-format=absolute", "--git-common-dir")
        .then((dir) => canonicalPath(dir.replace(/\r?\n$/, "")))
        .catch(() => null);
    async function matchesCheckout(item) {
      if (item.path !== workspace.path) {
        canonicalWorkspacePath ??= canonicalPath(workspace.path);
        const [workspacePath, itemPath] = await Promise.all([
          canonicalWorkspacePath,
          canonicalPath(item.path),
        ]);
        if (!workspacePath || workspacePath !== itemPath) return false;
      }
      if (item.workspaceId || item.root === workspace.root) return true;
      // An external Git worktree can have its own daemon project root.
      // Confirm the repository for older path-only links before binding them.
      if (!workspace.pullRequest) return false;
      checkoutGitDir ??= commonGitDir(workspace.path);
      if (!repositories.has(item.root)) repositories.set(item.root, commonGitDir(item.root));
      const [checkout, repo] = await Promise.all([checkoutGitDir, repositories.get(item.root)]);
      return Boolean(checkout && checkout === repo);
    }
    return update(
      async (draft) => {
        const completed = [];
        let changed = false;
        for (const task of draft) {
          let relevant = false;
          for (const item of task.experiments) {
            if (!candidate(item) || !(await matchesCheckout(item))) continue;
            if (observation !== workspaceObservation) return;
            relevant = true;
            const previous = item.pullRequest;
            const current = workspace.pullRequest;
            if (!item.workspaceId && current) {
              item.workspaceId = workspace.id;
              changed = true;
            }
            // Persist the link for Review, but never trust persisted checkout freshness.
            if (current) {
              const next = storedPullRequest(current, previous);
              const changedLink = previous?.url !== next.url || previous?.state !== next.state;
              if (
                changedLink ||
                previous?.title !== next.title ||
                previous?.mergedAt !== next.mergedAt
              ) {
                item.pullRequest = next;
                if (changedLink) liveMerges.delete(item.id);
                changed = true;
              }
            }
            if (current?.state === "merged" && current.matchesCheckout) {
              verifiedMerges.add(item.id);
              if (observedMerge && !task.done && task.stage == null) liveMerges.add(item.id);
            } else {
              verifiedMerges.delete(item.id);
            }
          }
          if (
            relevant &&
            !task.done &&
            task.stage == null &&
            !running.has(task.id) &&
            task.experiments.every((item) => verifiedMerges.has(item.id)) &&
            task.experiments.some((item) => liveMerges.has(item.id))
          ) {
            applyStage(task, "done");
            task.completedByPullRequest = true;
            completed.push({ id: task.id, title: task.title });
            changed = true;
          }
        }
        if (changed) return completed;
      },
      {
        skipUnchanged: true,
        applies: () =>
          observation === workspaceObservation &&
          state.some((task) => task.experiments.some(candidate)),
      },
    );
  }

  function worktreeTaskLinks() {
    const links = new Map();
    for (const task of state) {
      for (const item of task.experiments) {
        if (!isLinkedWorktree(item)) continue;
        const entries = links.get(item.path) ?? [];
        entries.push({
          id: task.id,
          title: task.title,
          root: item.root,
          workspaceId: item.workspaceId,
        });
        links.set(item.path, entries);
      }
    }
    return links;
  }

  function recap(period) {
    if (readError) throw new RequestError(readError, 503);
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const daysSinceMonday = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - daysSinceMonday - (period === "last-week" ? 7 : 0));
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    const inWeek = (date) => {
      const time = Date.parse(date);
      return time >= start.getTime() && time < end.getTime();
    };
    const tasks = [];
    const merged = new Map();
    let hasUndatedCompletions = false;
    for (const { id, title, done, completedAt, experiments } of state) {
      if (done && !completedAt) hasUndatedCompletions = true;
      if (done && inWeek(completedAt)) tasks.push({ id, title, completedAt });
      for (const { pullRequest: pr } of experiments) {
        if (pr?.state !== "merged") continue;
        if (!pr.mergedAt) hasUndatedCompletions = true;
        if (!inWeek(pr.mergedAt)) continue;
        const key = pr.url.toLowerCase();
        const existing = merged.get(key);
        if (!existing || (!existing.title && pr.title)) {
          merged.set(key, { url: pr.url, title: pr.title, mergedAt: pr.mergedAt });
        }
      }
    }
    const pullRequests = [...merged.values()];
    tasks.sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt));
    pullRequests.sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));
    return {
      startsAt: start.toISOString(),
      endsBefore: end.toISOString(),
      tasks: tasks.slice(0, recapPageSize),
      pullRequests: pullRequests.slice(0, recapPageSize),
      taskCount: tasks.length,
      pullRequestCount: pullRequests.length,
      hasUndatedCompletions,
    };
  }

  return {
    roots: () => [...new Set(state.flatMap((task) => task.repositories.map(({ root }) => root)))],
    linkedWorktrees,
    observeWorkspace,
    resetWorkspaceObservation,
    worktreeTaskLinks,
    recap,
    pullRequestTaskLinks: (url) =>
      state
        .filter((task) =>
          task.experiments.some(
            (item) => item.pullRequest?.url.toLowerCase() === url.toLowerCase(),
          ),
        )
        .map(({ id, title }) => ({ id, title })),
    list: () => ({ tasks: state, error: readError }),
    reportText(id, experimentId) {
      const item = getExperiment(getTask(state, id), experimentId);
      if (!item.report) throw new RequestError("This report is not ready.", 404);
      return item.report;
    },
    createFromAgent,
    listForAgent,
    getForAgent,
    mobileTask,
    updateFromAgent,
    updateCatalogLabel,
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
