import { randomBytes } from "node:crypto";
import pLimit from "p-limit";
import type { Logger } from "pino";
import type { SavedPrompt, SavedPromptDefinition } from "@pimi/protocol/prompt/types";
import { validatePromptDefinition, type PromptIssue } from "@pimi/protocol/prompt/validate";
import type { PimiDatabase } from "../db/pimi-db.js";
import type { SqlRecordStore } from "../db/sql-record-store.js";
import { createSavedPromptStore } from "./store.js";

export class PromptNotFoundError extends Error {
  constructor(readonly promptId: string) {
    super(`Prompt not found: ${promptId}`);
    this.name = "PromptNotFoundError";
  }
}

export class PromptValidationError extends Error {
  constructor(readonly issues: readonly PromptIssue[]) {
    super(issues.map((issue) => issue.message).join("; "));
    this.name = "PromptValidationError";
  }
}

// `reason` says which name it clashes with, so a client can word the message without parsing text.
export class PromptNameConflictError extends Error {
  constructor(
    readonly promptName: string,
    readonly reason: "prompt" | "flow",
  ) {
    super(
      reason === "flow"
        ? `A flow named "${promptName}" already exists`
        : `A prompt named "${promptName}" already exists`,
    );
    this.name = "PromptNameConflictError";
  }
}

export interface PromptServiceOptions {
  database: PimiDatabase;
  logger: Logger;
  // Flows are run with the same `/name` syntax, and a flow wins the menu on a clash.
  listFlowNames: () => Promise<string[]>;
}

function now(): string {
  return new Date().toISOString();
}

// Two prompts clash when a chat could see both: the same name in the same project, or a
// host-wide prompt and any project's prompt of that name.
function sharesScope(left: string | null, right: string | null): boolean {
  return left === null || right === null || left === right;
}

// Saved prompts: text a person reuses, typed as `/name` in the composer. The client expands the
// name into the text; the daemon only stores them and keeps names unambiguous.
export class PromptService {
  private readonly store: SqlRecordStore<SavedPrompt>;
  private readonly listFlowNames: () => Promise<string[]>;
  // Name uniqueness spans records, so writes run one at a time.
  private readonly mutate = pLimit(1);

  constructor(options: PromptServiceOptions) {
    this.store = createSavedPromptStore({
      database: options.database,
      logger: options.logger.child({ module: "prompt-service" }),
    });
    this.listFlowNames = options.listFlowNames;
  }

  async list(): Promise<SavedPrompt[]> {
    const prompts = await this.store.list();
    return prompts.sort((left, right) => left.name.localeCompare(right.name));
  }

  create(definition: SavedPromptDefinition): Promise<SavedPrompt> {
    return this.mutate(async () => {
      const normalized = await this.normalize({ definition, promptId: null });
      const at = now();
      return this.store.put({
        id: randomBytes(4).toString("hex"),
        ...normalized,
        createdAt: at,
        updatedAt: at,
      });
    });
  }

  update(input: { promptId: string; definition: SavedPromptDefinition }): Promise<SavedPrompt> {
    return this.mutate(async () => {
      const existing = await this.store.get(input.promptId);
      if (!existing) throw new PromptNotFoundError(input.promptId);
      const normalized = await this.normalize({
        definition: input.definition,
        promptId: existing.id,
      });
      return this.store.put({ ...existing, ...normalized, updatedAt: now() });
    });
  }

  delete(promptId: string): Promise<void> {
    return this.mutate(async () => {
      if (!(await this.store.get(promptId))) throw new PromptNotFoundError(promptId);
      await this.store.delete(promptId);
    });
  }

  private async normalize(input: {
    definition: SavedPromptDefinition;
    promptId: string | null;
  }): Promise<SavedPromptDefinition> {
    const definition: SavedPromptDefinition = {
      name: input.definition.name.trim(),
      text: input.definition.text,
      projectId: input.definition.projectId,
    };
    const issues = validatePromptDefinition(definition);
    if (issues.length > 0) throw new PromptValidationError(issues);
    if ((await this.listFlowNames()).includes(definition.name)) {
      throw new PromptNameConflictError(definition.name, "flow");
    }
    const clash = (await this.store.list()).find(
      (prompt) =>
        prompt.id !== input.promptId &&
        prompt.name === definition.name &&
        sharesScope(prompt.projectId, definition.projectId),
    );
    if (clash) throw new PromptNameConflictError(definition.name, "prompt");
    return definition;
  }
}
