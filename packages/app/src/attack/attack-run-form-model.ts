import { attackUrlHost, isLocalAttackHost } from "@pimi/protocol/attack/allowlist";
import {
  ATTACK_ROLE_IDS,
  DEFAULT_ATTACK_LIMITS,
  type AttackRoleId,
  type AttackRunDefinition,
} from "@pimi/protocol/attack/types";

// A plain model of the Attack launch form (docs/forms.md): no React. `openAttackRunForm` builds a
// fresh instance per mount; commands mutate; the component renders `getState()`.

export interface AttackModelOption {
  /** "provider/model" */
  value: string;
  label: string;
}

export interface AttackRunFormInput {
  workspaceId: string;
  cwd: string;
}

export type AttackFormProblem =
  | "targetInvalid"
  | "rosterEmpty"
  | "minutesInvalid"
  | "tokensInvalid"
  | "modelMissing";

export interface AttackRunFormState {
  target: string;
  scopeNotes: string;
  repoScope: boolean;
  minutes: string;
  kiloTokens: string;
  roster: Record<AttackRoleId, boolean>;
  disposableTarget: boolean;
  model: AttackModelOption | null;
  modelOptions: AttackModelOption[];
  /** The one remote host the target names, when it is not local. */
  remoteHost: string | null;
  /** Problems to show; hidden until the owner has touched the field or pressed Start. */
  problems: Partial<Record<AttackFormProblem, true>>;
  canSubmit: boolean;
}

const MIN_MINUTES = 1;
const MAX_MINUTES = 480;
const MIN_KILO_TOKENS = 10;
const MAX_KILO_TOKENS = 100_000;

function parseWhole(value: string): number | null {
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
}

// Cheap models first: an attack run fans out into several agents.
function preferredModel(options: readonly AttackModelOption[]): AttackModelOption | null {
  return options.find((option) => /haiku|mini|flash/i.test(option.value)) ?? options[0] ?? null;
}

export class AttackRunFormModel {
  private state: AttackRunFormState;
  private readonly listeners = new Set<() => void>();
  private submitted = false;
  private touchedTarget = false;
  private modelChosen = false;
  private closed = false;

  constructor(private readonly input: AttackRunFormInput) {
    this.state = this.derive({
      target: "",
      scopeNotes: "",
      repoScope: true,
      minutes: String(DEFAULT_ATTACK_LIMITS.maxRuntimeMs / 60_000),
      kiloTokens: String(DEFAULT_ATTACK_LIMITS.maxTokens / 1000),
      roster: { "ui-qa": true, "secrets-audit": true },
      disposableTarget: false,
      model: null,
      modelOptions: [],
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): AttackRunFormState => this.state;

  close(): void {
    this.closed = true;
    this.listeners.clear();
  }

  setTarget = (value: string): void => {
    this.touchedTarget = true;
    this.patch({ target: value });
  };

  setScopeNotes = (value: string): void => {
    this.patch({ scopeNotes: value });
  };

  setRepoScope = (value: boolean): void => {
    this.patch({
      repoScope: value,
      roster: value ? this.state.roster : { ...this.state.roster, "secrets-audit": false },
    });
  };

  setMinutes = (value: string): void => {
    this.patch({ minutes: value });
  };

  setKiloTokens = (value: string): void => {
    this.patch({ kiloTokens: value });
  };

  toggleRole(role: AttackRoleId): void {
    if (role === "secrets-audit" && !this.state.repoScope) return;
    this.patch({ roster: { ...this.state.roster, [role]: !this.state.roster[role] } });
  }

  setDisposableTarget = (value: boolean): void => {
    this.patch({ disposableTarget: value });
  };

  setModel = (option: AttackModelOption): void => {
    this.modelChosen = true;
    this.patch({ model: option });
  };

  /** Late data: the host's models arrive after the form opens. A choice the owner made stays. */
  applyModelOptions(options: AttackModelOption[]): void {
    this.patch({
      modelOptions: options,
      model: this.modelChosen ? this.state.model : preferredModel(options),
    });
  }

  /** Returns the definition to send, or null while a problem remains (which then show). */
  submit(): AttackRunDefinition | null {
    this.submitted = true;
    this.patch({});
    if (!this.state.canSubmit || !this.state.model) return null;
    return {
      workspaceId: this.input.workspaceId,
      cwd: this.input.cwd,
      target: this.state.target.trim(),
      repoScope: this.state.repoScope,
      scopeNotes: this.state.scopeNotes.trim(),
      provider: this.state.model.value,
      roster: ATTACK_ROLE_IDS.filter((role) => this.state.roster[role]),
      disposableTarget: this.state.disposableTarget,
      limits: {
        maxRuntimeMs: (parseWhole(this.state.minutes) ?? 0) * 60_000,
        maxTokens: (parseWhole(this.state.kiloTokens) ?? 0) * 1000,
      },
    };
  }

  private patch(
    change: Partial<Omit<AttackRunFormState, "problems" | "canSubmit" | "remoteHost">>,
  ) {
    if (this.closed) return;
    this.state = this.derive({ ...this.state, ...change });
    for (const listener of this.listeners) listener();
  }

  private derive(
    base: Omit<AttackRunFormState, "problems" | "canSubmit" | "remoteHost">,
  ): AttackRunFormState {
    const host = attackUrlHost(base.target.trim());
    const minutes = parseWhole(base.minutes);
    const kiloTokens = parseWhole(base.kiloTokens);
    const found: Partial<Record<AttackFormProblem, true>> = {};
    if (!host) found.targetInvalid = true;
    if (!ATTACK_ROLE_IDS.some((role) => base.roster[role])) found.rosterEmpty = true;
    if (minutes === null || minutes < MIN_MINUTES || minutes > MAX_MINUTES) {
      found.minutesInvalid = true;
    }
    if (kiloTokens === null || kiloTokens < MIN_KILO_TOKENS || kiloTokens > MAX_KILO_TOKENS) {
      found.tokensInvalid = true;
    }
    if (!base.model) found.modelMissing = true;
    const canSubmit = Object.keys(found).length === 0;
    // An untouched form shows no errors; the target's error waits until it has been edited.
    const shown: Partial<Record<AttackFormProblem, true>> = {};
    for (const problem of Object.keys(found) as AttackFormProblem[]) {
      if (problem === "targetInvalid" ? this.touchedTarget || this.submitted : this.submitted) {
        shown[problem] = true;
      }
    }
    return {
      ...base,
      remoteHost: host && !isLocalAttackHost(host) ? host : null,
      problems: shown,
      canSubmit,
    };
  }
}

export function openAttackRunForm(input: AttackRunFormInput): AttackRunFormModel {
  return new AttackRunFormModel(input);
}
