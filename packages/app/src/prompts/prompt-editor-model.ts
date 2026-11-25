import type { SavedPrompt, SavedPromptDefinition } from "@pimi/protocol/prompt/types";
import { validatePromptDefinition, type PromptIssueCode } from "@pimi/protocol/prompt/validate";

export type PromptFieldError = PromptIssueCode | "reserved";

export interface PromptFormValues {
  name: string;
  text: string;
  /** Null: every project on the host. */
  projectId: string | null;
}

export interface PromptFormSnapshot {
  /** Edit replaces this prompt; create makes a new one, possibly prefilled. */
  editing: SavedPrompt | null;
  initial: PromptFormValues;
  /** The label of the initial project, captured at open so list churn cannot blank it. */
  initialProjectLabel: string;
  /** Names a prompt cannot take because a built-in command already owns them. */
  reservedNames: ReadonlySet<string>;
}

export interface PromptFormState {
  mode: "create" | "edit";
  name: string;
  text: string;
  projectId: string | null;
  projectLabel: string;
  /** Errors stay hidden until the first save attempt. */
  nameError: PromptFieldError | null;
  textError: PromptFieldError | null;
  isSubmitting: boolean;
  submitError: string | null;
}

export interface PromptFormModel {
  getState: () => PromptFormState;
  subscribe: (listener: () => void) => () => void;
  close: () => void;
  setName: (value: string) => void;
  setText: (value: string) => void;
  setProject: (projectId: string | null, label: string) => void;
  /** Validates; on success marks the form submitting and returns the definition to send. */
  beginSubmit: () => SavedPromptDefinition | null;
  /** The send finished; an error keeps the form open and visible. */
  endSubmit: (error: string | null) => void;
}

interface PromptFormInternals extends PromptFormValues {
  projectLabel: string;
  attempted: boolean;
  isSubmitting: boolean;
  submitError: string | null;
}

function findFieldError(input: {
  values: PromptFormValues;
  field: "name" | "text";
  reservedNames: ReadonlySet<string>;
}): PromptFieldError | null {
  const { values, field } = input;
  const issue = validatePromptDefinition({ ...values, name: values.name.trim() }).find(
    (candidate) => candidate.field === field,
  );
  if (issue) return issue.code;
  if (field === "name" && input.reservedNames.has(values.name.trim())) return "reserved";
  return null;
}

export function openPromptForm(snapshot: PromptFormSnapshot): PromptFormModel {
  const listeners = new Set<() => void>();
  let closed = false;
  let internals: PromptFormInternals = {
    ...snapshot.initial,
    projectLabel: snapshot.initialProjectLabel,
    attempted: false,
    isSubmitting: false,
    submitError: null,
  };

  function project(): PromptFormState {
    const values: PromptFormValues = {
      name: internals.name,
      text: internals.text,
      projectId: internals.projectId,
    };
    const { reservedNames } = snapshot;
    return {
      mode: snapshot.editing ? "edit" : "create",
      ...values,
      projectLabel: internals.projectLabel,
      nameError: internals.attempted
        ? findFieldError({ values, field: "name", reservedNames })
        : null,
      textError: internals.attempted
        ? findFieldError({ values, field: "text", reservedNames })
        : null,
      isSubmitting: internals.isSubmitting,
      submitError: internals.submitError,
    };
  }

  let state = project();

  function publish(next: Partial<PromptFormInternals>): void {
    if (closed) return;
    internals = { ...internals, ...next };
    state = project();
    for (const listener of listeners) listener();
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      closed = true;
      listeners.clear();
    },
    setName: (value) => publish({ name: value, submitError: null }),
    setText: (value) => publish({ text: value, submitError: null }),
    setProject: (projectId, label) => publish({ projectId, projectLabel: label }),
    beginSubmit() {
      if (internals.isSubmitting) return null;
      publish({ attempted: true });
      if (state.nameError || state.textError) return null;
      publish({ isSubmitting: true, submitError: null });
      return {
        name: internals.name.trim(),
        text: internals.text,
        projectId: internals.projectId,
      };
    },
    endSubmit: (error) => publish({ isSubmitting: false, submitError: error }),
  };
}
