import { attackUrlHost, isLocalAttackHost } from "@pimi/protocol/attack/allowlist";
import {
  ATTACK_ROLE_IDS,
  ATTACK_ROLE_REQUIREMENTS,
  DEFAULT_ATTACK_LIMITS,
  type AttackDesktopTarget,
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

/** A window the owner may pick as the run's desktop target. */
export type AttackDesktopWindow = AttackDesktopTarget;

export type AttackFormProblem =
  | "targetInvalid"
  | "rosterEmpty"
  | "minutesInvalid"
  | "tokensInvalid"
  | "modelMissing"
  | "credentialsMissing"
  | "disposableUnconfirmed"
  | "disposableRequired";

export interface AttackRunFormState {
  target: string;
  scopeNotes: string;
  repoScope: boolean;
  minutes: string;
  kiloTokens: string;
  roster: Record<AttackRoleId, boolean>;
  disposableTarget: boolean;
  /** What the owner typed to confirm the disposable target. */
  disposableConfirm: string;
  /** What must be typed: the target host, or the desktop app's name for a window-only run. */
  disposableConfirmWord: string | null;
  /** Test-account credentials for the auth role. */
  testCredentials: string;
  model: AttackModelOption | null;
  modelOptions: AttackModelOption[];
  /** The one app window the run may drive besides (or instead of) the URL. */
  desktopTarget: AttackDesktopTarget | null;
  /** The owner's consent to click and type in that window. */
  allowDesktopInput: boolean;
  desktopWindows: AttackDesktopWindow[];
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
export function preferredModel(options: readonly AttackModelOption[]): AttackModelOption | null {
  return options.find((option) => /haiku|mini|flash/i.test(option.value)) ?? options[0] ?? null;
}

function budgetProblems(
  minutes: string,
  kiloTokens: string,
): Partial<Record<AttackFormProblem, true>> {
  const found: Partial<Record<AttackFormProblem, true>> = {};
  const parsedMinutes = parseWhole(minutes);
  const parsedTokens = parseWhole(kiloTokens);
  if (parsedMinutes === null || parsedMinutes < MIN_MINUTES || parsedMinutes > MAX_MINUTES) {
    found.minutesInvalid = true;
  }
  if (parsedTokens === null || parsedTokens < MIN_KILO_TOKENS || parsedTokens > MAX_KILO_TOKENS) {
    found.tokensInvalid = true;
  }
  return found;
}

function rosterProblems(
  base: Pick<
    AttackRunFormState,
    "roster" | "testCredentials" | "disposableTarget" | "disposableConfirm"
  >,
  confirmWord: string | null,
): Partial<Record<AttackFormProblem, true>> {
  const found: Partial<Record<AttackFormProblem, true>> = {};
  const picked = ATTACK_ROLE_IDS.filter((role) => base.roster[role]);
  if (picked.some((role) => ATTACK_ROLE_REQUIREMENTS[role].testCredentials)) {
    if (base.testCredentials.trim() === "") found.credentialsMissing = true;
  }
  if (picked.some((role) => ATTACK_ROLE_REQUIREMENTS[role].disposableTarget)) {
    if (!base.disposableTarget) found.disposableRequired = true;
  }
  if (
    base.disposableTarget &&
    (confirmWord === null ||
      base.disposableConfirm.trim().toLowerCase() !== confirmWord.toLowerCase())
  ) {
    found.disposableUnconfirmed = true;
  }
  return found;
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
      roster: {
        recon: true,
        "ui-qa": true,
        api: true,
        auth: false,
        input: true,
        "secrets-audit": true,
        "perf-lite": false,
      },
      disposableTarget: false,
      disposableConfirm: "",
      testCredentials: "",
      model: null,
      modelOptions: [],
      desktopTarget: null,
      allowDesktopInput: false,
      desktopWindows: [],
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
    if (ATTACK_ROLE_REQUIREMENTS[role].repository && !this.state.repoScope) return;
    this.patch({ roster: { ...this.state.roster, [role]: !this.state.roster[role] } });
  }

  setDesktopTarget = (value: AttackDesktopTarget | null): void => {
    // Without a window there is nothing to consent to.
    this.patch({
      desktopTarget: value,
      allowDesktopInput: value ? this.state.allowDesktopInput : false,
    });
  };

  setAllowDesktopInput = (value: boolean): void => {
    this.patch({ allowDesktopInput: value });
  };

  /** Late data: the app lists windows after the form opens. A window that vanished is dropped. */
  applyDesktopWindows(windows: AttackDesktopWindow[]): void {
    const current = this.state.desktopTarget;
    const stillThere =
      current !== null &&
      windows.some(
        (window) =>
          window.bundleId === current.bundleId && window.windowTitle === current.windowTitle,
      );
    this.patch({
      desktopWindows: windows,
      desktopTarget: stillThere ? current : null,
      allowDesktopInput: stillThere ? this.state.allowDesktopInput : false,
    });
  }

  setDisposableTarget = (value: boolean): void => {
    this.patch({ disposableTarget: value, disposableConfirm: "" });
  };

  setDisposableConfirm = (value: string): void => {
    this.patch({ disposableConfirm: value });
  };

  setTestCredentials = (value: string): void => {
    this.patch({ testCredentials: value });
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

  /** Whether the target is a valid URL to open for pre-flight; shows the error when it is not. */
  checkTarget(): boolean {
    this.touchedTarget = true;
    this.patch({});
    return !this.state.problems.targetInvalid && attackUrlHost(this.state.target.trim()) !== null;
  }

  /** Returns the definition to send, or null while a problem remains (which then show). */
  submit(
    preflight: Pick<AttackRunDefinition, "annotations" | "onlyAnnotated"> = {
      annotations: [],
      onlyAnnotated: false,
    },
  ): AttackRunDefinition | null {
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
      testCredentials: this.state.roster.auth ? this.state.testCredentials.trim() : "",
      limits: {
        maxRuntimeMs: (parseWhole(this.state.minutes) ?? 0) * 60_000,
        maxTokens: (parseWhole(this.state.kiloTokens) ?? 0) * 1000,
      },
      annotations: preflight.annotations,
      onlyAnnotated: preflight.onlyAnnotated,
      desktopTarget: this.state.desktopTarget,
      allowDesktopInput: this.state.desktopTarget !== null && this.state.allowDesktopInput,
    };
  }

  private patch(
    change: Partial<
      Omit<AttackRunFormState, "problems" | "canSubmit" | "remoteHost" | "disposableConfirmWord">
    >,
  ) {
    if (this.closed) return;
    this.state = this.derive({ ...this.state, ...change });
    for (const listener of this.listeners) listener();
  }

  private derive(
    base: Omit<
      AttackRunFormState,
      "problems" | "canSubmit" | "remoteHost" | "disposableConfirmWord"
    >,
  ): AttackRunFormState {
    const host = attackUrlHost(base.target.trim());
    const found: Partial<Record<AttackFormProblem, true>> = {};
    // The URL may stay empty when the run drives a desktop window instead; a typed URL must be valid.
    const targetBlank = base.target.trim() === "";
    if (!host && !(targetBlank && base.desktopTarget)) found.targetInvalid = true;
    if (!ATTACK_ROLE_IDS.some((role) => base.roster[role])) found.rosterEmpty = true;
    Object.assign(found, budgetProblems(base.minutes, base.kiloTokens));
    if (!base.model) found.modelMissing = true;
    const confirmWord = host ?? base.desktopTarget?.appName ?? null;
    Object.assign(found, rosterProblems(base, confirmWord));
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
      disposableConfirmWord: confirmWord,
      problems: shown,
      canSubmit,
    };
  }
}

export function openAttackRunForm(input: AttackRunFormInput): AttackRunFormModel {
  return new AttackRunFormModel(input);
}
