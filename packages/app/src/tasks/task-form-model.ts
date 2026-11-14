import {
  TASK_DESCRIPTION_MAX_LENGTH,
  TASK_TITLE_MAX_LENGTH,
  type Task,
  type TaskStatus,
} from "@pimi/protocol/task/types";

export type TaskFormMode = "create" | "edit";

export interface TaskFormState {
  mode: TaskFormMode;
  serverId: string;
  title: string;
  description: string;
  status: TaskStatus;
  /** Chats picked while creating. Editing links and unlinks through their own RPCs. */
  chatIds: readonly string[];
  /** Bumped when the description is replaced from outside the input, so the input resets to it. */
  descriptionVersion: number;
  titleError: boolean;
  dirty: boolean;
  canSubmit: boolean;
}

type Listener = () => void;

/**
 * The New task / Task detail form. Plain TypeScript (docs/forms.md): constructed once per mount,
 * commands mutate, derived state is recomputed on every publish.
 *
 * Description generation is the one late input: the daemon fills an empty description while the
 * sheet is open. `applyRemote` adopts it only while the person has not typed in that field, so a
 * background write never overwrites an edit.
 */
export class TaskFormModel {
  private state: TaskFormState;
  private baseline: Pick<TaskFormState, "title" | "description" | "status">;
  private descriptionTouched = false;
  private readonly listeners = new Set<Listener>();

  private constructor(state: TaskFormState) {
    this.state = state;
    this.baseline = { title: state.title, description: state.description, status: state.status };
  }

  static create(input: { serverId: string }): TaskFormModel {
    return new TaskFormModel(
      derive({
        mode: "create",
        serverId: input.serverId,
        title: "",
        description: "",
        status: "todo",
        chatIds: [],
        descriptionVersion: 0,
        titleError: false,
        dirty: false,
        canSubmit: false,
      }),
    );
  }

  static edit(
    task: Pick<Task, "title" | "description" | "status"> & { serverId: string },
  ): TaskFormModel {
    return new TaskFormModel(
      derive({
        mode: "edit",
        serverId: task.serverId,
        title: task.title,
        description: task.description,
        status: task.status,
        chatIds: [],
        descriptionVersion: 0,
        titleError: false,
        dirty: false,
        canSubmit: false,
      }),
    );
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): TaskFormState => this.state;

  setTitle(title: string): void {
    this.publish({ title: title.slice(0, TASK_TITLE_MAX_LENGTH), titleError: false });
  }

  setDescription(description: string): void {
    this.descriptionTouched = true;
    this.publish({ description: description.slice(0, TASK_DESCRIPTION_MAX_LENGTH) });
  }

  setStatus(status: TaskStatus): void {
    this.publish({ status });
  }

  setHost(serverId: string): void {
    // A chat belongs to one host; changing host drops the picks.
    this.publish({ serverId, chatIds: [] });
  }

  addChat(agentId: string): void {
    if (this.state.chatIds.includes(agentId)) return;
    this.publish({ chatIds: [...this.state.chatIds, agentId] });
  }

  removeChat(agentId: string): void {
    this.publish({ chatIds: this.state.chatIds.filter((id) => id !== agentId) });
  }

  /** The saved record changed underneath the form. */
  applyRemote(task: Pick<Task, "description">): void {
    const patch: Partial<TaskFormState> = {};
    if (!this.descriptionTouched && task.description !== this.state.description) {
      patch.description = task.description;
      patch.descriptionVersion = this.state.descriptionVersion + 1;
      this.baseline = { ...this.baseline, description: task.description };
    }
    if (Object.keys(patch).length > 0) this.publish(patch);
  }

  /** Marks the current values as saved, so `dirty` clears. */
  markSaved(): void {
    this.baseline = {
      title: this.state.title,
      description: this.state.description,
      status: this.state.status,
    };
    this.publish({});
  }

  /** Flags an empty title. Returns whether the form can submit. */
  validate(): boolean {
    const ok = this.state.title.trim().length > 0;
    if (!ok) this.publish({ titleError: true });
    return ok;
  }

  close(): void {
    this.listeners.clear();
  }

  private publish(patch: Partial<TaskFormState>): void {
    this.state = derive({ ...this.state, ...patch }, this.baseline, this.state.mode);
    for (const listener of this.listeners) listener();
  }
}

function derive(
  state: TaskFormState,
  baseline?: Pick<TaskFormState, "title" | "description" | "status">,
  mode: TaskFormMode = state.mode,
): TaskFormState {
  const dirty = baseline
    ? state.title !== baseline.title ||
      state.description !== baseline.description ||
      state.status !== baseline.status
    : false;
  return {
    ...state,
    dirty,
    canSubmit: state.title.trim().length > 0 && (mode === "create" || dirty),
  };
}
