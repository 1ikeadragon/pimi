import { useCallback, useMemo, useReducer } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { DaemonClient } from "@pimi/client/internal/daemon-client";
import type { VaultRequest, VaultRequestDecision } from "@pimi/protocol/vault/types";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useContainerWidthBelow } from "@/hooks/use-container-width";
import { useTranslation } from "@/i18n/use-translation";
import { formatArgv } from "@/screens/settings/vault/format-argv";
import {
  useVaultAction,
  vaultErrorCode,
  vaultErrorMessage,
} from "@/screens/settings/vault/use-vault";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";
import { proveWithoutTyping, useProofPath, type ProofPath } from "./use-vault-proof";

// Below this width the three buttons stack, so every one is visible without scrolling on a phone.
const STACK_BELOW_WIDTH = 400;
const UNTITLED_CHAT_ID_LENGTH = 8;

interface GrantChoice {
  id: string;
  label: string;
  argvPrefixLength: number;
  scopeToProject: boolean;
}

type CardAction =
  | { kind: "resolve"; decision: VaultRequestDecision; choice: GrantChoice | null }
  | { kind: "unlock" }
  | { kind: "load" };

interface CardState {
  /** The action waiting for a typed passphrase; null while nothing needs one. */
  awaiting: CardAction | null;
  touchCancelled: boolean;
  passphrase: string;
  masterPassword: string;
  passphraseKey: number;
  masterKey: number;
}

type CardEvent =
  | { type: "await-passphrase"; action: CardAction }
  | { type: "touch-cancelled"; action: CardAction }
  | { type: "passphrase"; value: string }
  | { type: "master"; value: string }
  | { type: "clear-passphrase" }
  | { type: "done" };

function reduce(state: CardState, event: CardEvent): CardState {
  switch (event.type) {
    case "await-passphrase":
      return { ...state, awaiting: event.action, touchCancelled: false };
    case "touch-cancelled":
      return { ...state, awaiting: event.action, touchCancelled: true };
    case "passphrase":
      return { ...state, passphrase: event.value };
    case "master":
      return { ...state, masterPassword: event.value };
    case "clear-passphrase":
      return { ...state, passphrase: "", passphraseKey: state.passphraseKey + 1 };
    case "done":
      return {
        awaiting: null,
        touchCancelled: false,
        passphrase: "",
        masterPassword: "",
        passphraseKey: state.passphraseKey + 1,
        masterKey: state.masterKey + 1,
      };
  }
}

function useChatLabel(serverId: string, agentId: string | null, fallback: string): string {
  const title = useSessionStore((state) => {
    if (!agentId) return null;
    const session = state.sessions[serverId];
    return (session?.agents?.get(agentId) ?? session?.agentDetails?.get(agentId))?.title ?? null;
  });
  if (title) return title;
  return agentId ? agentId.slice(0, UNTITLED_CHAT_ID_LENGTH) : fallback;
}

/** Project name plus the path below the project root, so a long absolute path is not the headline. */
function useFolderLabel(serverId: string, request: VaultRequest): string {
  return useMemo(() => {
    const workspaces = useSessionStore.getState().sessions[serverId]?.workspaces;
    if (!workspaces || request.projectId === null) return request.cwd;
    for (const workspace of workspaces.values()) {
      if (workspace.projectId !== request.projectId) continue;
      const root = workspace.projectRootPath.replace(/[\\/]+$/, "");
      if (request.cwd === root) return workspace.projectDisplayName;
      if (request.cwd.startsWith(`${root}/`) || request.cwd.startsWith(`${root}\\`)) {
        return `${workspace.projectDisplayName}/${request.cwd.slice(root.length + 1)}`;
      }
      return request.cwd;
    }
    return request.cwd;
  }, [serverId, request.cwd, request.projectId]);
}

function programName(executable: string): string {
  return executable.split(/[\\/]/).pop() ?? executable;
}

function useGrantChoices(request: VaultRequest): GrantChoice[] {
  const { t } = useTranslation();
  return useMemo(() => {
    const args = request.argv.slice(1);
    const program = programName(request.argv[0]);
    const inProject = request.projectId !== null;
    const choices: GrantChoice[] = [
      {
        id: "exact-project",
        label: inProject ? t("vaultRequest.alwaysExactProject") : t("vaultRequest.alwaysExactAny"),
        argvPrefixLength: args.length,
        scopeToProject: inProject,
      },
    ];
    if (inProject) {
      choices.push({
        id: "exact-any",
        label: t("vaultRequest.alwaysExactAny"),
        argvPrefixLength: args.length,
        scopeToProject: false,
      });
      if (args.length > 0) {
        choices.push({
          id: "program-project",
          label: t("vaultRequest.alwaysProgramProject", { program }),
          argvPrefixLength: 0,
          scopeToProject: true,
        });
      }
    }
    if (args.length >= 3) {
      for (let length = args.length - 1; length >= 1; length -= 1) {
        choices.push({
          id: `prefix-${length}`,
          label: t("vaultRequest.alwaysPrefixProject", {
            command: formatArgv([program, ...args.slice(0, length)]),
          }),
          argvPrefixLength: length,
          scopeToProject: inProject,
        });
      }
    }
    return choices;
  }, [request.argv, request.projectId, t]);
}

interface ActInput {
  action: CardAction;
  /** Typed passphrase, when the user had to type one for this attempt. */
  passphrase: string | null;
  masterPassword: string;
}

type ActResult = "done" | "touch-cancelled" | "needs-passphrase";

interface VaultRequestCardProps {
  serverId: string;
  request: VaultRequest;
}

export function VaultRequestCard({ serverId, request }: VaultRequestCardProps) {
  const { t } = useTranslation();
  const { onLayout, isBelow: stacked } = useContainerWidthBelow(STACK_BELOW_WIDTH, {
    initialIsBelow: false,
  });
  const path = useProofPath(serverId);
  const [state, dispatch] = useReducer(reduce, {
    awaiting: null,
    touchCancelled: false,
    passphrase: "",
    masterPassword: "",
    passphraseKey: 0,
    masterKey: 0,
  });
  const chat = useChatLabel(serverId, request.agentId, t("vaultRequest.untitledChat"));
  const folder = useFolderLabel(serverId, request);
  const choices = useGrantChoices(request);
  const biometricPrompt = t("vaultRequest.biometricPrompt");

  const act = useVaultAction(serverId, async (client, input: ActInput): Promise<ActResult> => {
    const { action, passphrase, masterPassword } = input;
    if (passphrase !== null) {
      if (action.kind === "unlock") await client.vaultUnlock({ passphrase });
      else await client.vaultAuthorize({ passphrase });
    } else if (action.kind === "unlock") {
      const outcome = await proveWithoutTyping({
        client,
        serverId,
        path,
        purpose: "unlock",
        prompt: biometricPrompt,
      });
      if (outcome !== "proven")
        return outcome === "cancelled" ? "touch-cancelled" : "needs-passphrase";
    }
    if (action.kind === "unlock") return "done";
    try {
      await runOperatorAction(client, request, action, masterPassword);
      return "done";
    } catch (error) {
      if (vaultErrorCode(error) !== "vault_not_operator" || passphrase !== null) throw error;
    }
    const outcome = await proveWithoutTyping({
      client,
      serverId,
      path,
      purpose: "authorize",
      prompt: biometricPrompt,
    });
    if (outcome === "cancelled") return "touch-cancelled";
    if (outcome === "needs-passphrase") return "needs-passphrase";
    await runOperatorAction(client, request, action, masterPassword);
    return "done";
  });

  const run = useCallback(
    (action: CardAction, passphrase: string | null) => {
      act.mutate(
        { action, passphrase, masterPassword: state.masterPassword },
        {
          onSuccess: (result) => {
            if (result === "done") dispatch({ type: "done" });
            else if (result === "touch-cancelled") dispatch({ type: "touch-cancelled", action });
            else dispatch({ type: "await-passphrase", action });
          },
          onError: () => dispatch({ type: "clear-passphrase" }),
        },
      );
    },
    [act, state.masterPassword],
  );
  const press = useCallback(
    (action: CardAction) => {
      const typed = state.passphrase.length > 0 ? state.passphrase : null;
      run(action, typed);
      if (typed !== null) dispatch({ type: "clear-passphrase" });
    },
    [run, state.passphrase],
  );
  const submitPassphrase = useCallback(() => {
    if (state.awaiting) press(state.awaiting);
  }, [press, state.awaiting]);
  const retry = useCallback(() => {
    if (state.awaiting) run(state.awaiting, null);
  }, [run, state.awaiting]);
  const changePassphrase = useCallback(
    (value: string) => dispatch({ type: "passphrase", value }),
    [],
  );
  const changeMaster = useCallback((value: string) => dispatch({ type: "master", value }), []);

  const gone = act.error !== null && vaultErrorCode(act.error) === "vault_not_found";
  const errorText = act.error && !gone ? vaultErrorMessage(act.error) : null;
  const pending = act.isPending;
  const showPassphrase =
    state.awaiting !== null || (request.waitingFor === "unlock" && path === "passphrase");

  const title = titleFor(t, request, chat);
  return (
    <View style={styles.card} onLayout={onLayout} testID={`vault-request-${request.id}`}>
      <Text style={styles.title}>{title}</Text>
      {request.waitingFor === "approval" ? (
        <>
          <Text style={styles.command} selectable>
            {formatArgv(request.argv)}
          </Text>
          <Text style={settingsStyles.rowHint} accessibilityLabel={request.cwd}>
            {t("vaultRequest.context", {
              folder,
              secrets: request.secrets.map((secret) => secret.secret).join(", "),
            })}
          </Text>
          {request.runsProjectCode ? (
            <Alert size="sm" variant="warning" title={t("vaultRequest.runsProjectCode")} />
          ) : null}
        </>
      ) : null}
      {request.waitingFor === "source" ? (
        <Field label={t("vaultRequest.masterPassword")}>
          <FormTextInput
            initialValue=""
            resetKey={state.masterKey}
            onChangeText={changeMaster}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            editable={!pending}
            accessibilityLabel={t("vaultRequest.masterPassword")}
            testID={`vault-request-${request.id}-master`}
          />
        </Field>
      ) : null}
      {state.touchCancelled ? (
        <Text style={settingsStyles.rowHint}>{t("vaultRequest.touchIdCancelled")}</Text>
      ) : null}
      {showPassphrase ? (
        <Field label={t("vaultRequest.passphrase")}>
          <FormTextInput
            initialValue=""
            resetKey={state.passphraseKey}
            onChangeText={changePassphrase}
            onSubmitEditing={submitPassphrase}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            editable={!pending}
            accessibilityLabel={t("vaultRequest.passphrase")}
            testID={`vault-request-${request.id}-passphrase`}
          />
        </Field>
      ) : null}
      {errorText ? (
        <Text accessibilityRole="alert" style={settingsStyles.rowError}>
          {errorText}
        </Text>
      ) : null}
      {gone ? <Text style={settingsStyles.rowHint}>{t("vaultRequest.gone")}</Text> : null}
      <View style={stacked ? styles.actionsStacked : styles.actions}>
        {request.waitingFor === "approval" ? (
          <ApprovalActions choices={choices} pending={pending} stacked={stacked} onAct={press} />
        ) : (
          <SimpleActions
            request={request}
            path={path}
            pending={pending}
            stacked={stacked}
            hasPassphrase={state.passphrase.length > 0}
            hasMaster={state.masterPassword.length > 0}
            onAct={press}
          />
        )}
        {state.touchCancelled ? (
          <Button variant="outline" onPress={retry} disabled={pending} testID="vault-request-retry">
            {t("vaultRequest.retry")}
          </Button>
        ) : null}
      </View>
    </View>
  );
}

async function runOperatorAction(
  client: DaemonClient,
  request: VaultRequest,
  action: CardAction,
  masterPassword: string,
): Promise<void> {
  if (action.kind === "load") {
    await client.vaultBitwardenUnlock({ masterPassword });
    return;
  }
  if (action.kind !== "resolve") return;
  await client.vaultResolveRequest({
    vaultRequestId: request.id,
    decision: action.decision,
    argvPrefixLength: action.choice?.argvPrefixLength ?? 0,
    scopeToProject: action.choice?.scopeToProject ?? false,
  });
}

function titleFor(
  t: ReturnType<typeof useTranslation>["t"],
  request: VaultRequest,
  chat: string,
): string {
  if (request.waitingFor === "unlock") return t("vaultRequest.unlockTitle", { chat });
  if (request.waitingFor === "source") {
    return t("vaultRequest.sourceTitle", { chat, names: request.sourceSecrets.join(", ") });
  }
  return t("vaultRequest.runTitle", { chat });
}

interface ApprovalActionsProps {
  choices: GrantChoice[];
  pending: boolean;
  stacked: boolean;
  onAct: (action: CardAction) => void;
}

function ApprovalActions({ choices, pending, stacked, onAct }: ApprovalActionsProps) {
  const { t } = useTranslation();
  const deny = useCallback(
    () => onAct({ kind: "resolve", decision: "deny", choice: null }),
    [onAct],
  );
  const once = useCallback(
    () => onAct({ kind: "resolve", decision: "once", choice: null }),
    [onAct],
  );
  const always = useCallback(
    (choice: GrantChoice) => onAct({ kind: "resolve", decision: "always", choice }),
    [onAct],
  );
  return (
    <>
      <Button
        variant="outline"
        onPress={deny}
        disabled={pending}
        style={stacked ? styles.fullWidth : undefined}
        testID="vault-request-deny"
      >
        {t("vaultRequest.deny")}
      </Button>
      <Button
        variant="default"
        onPress={once}
        disabled={pending}
        style={stacked ? styles.fullWidth : undefined}
        testID="vault-request-once"
      >
        {pending ? t("vaultRequest.working") : t("vaultRequest.once")}
      </Button>
      <AlwaysMenu choices={choices} disabled={pending} onChoose={always} />
    </>
  );
}

function AlwaysMenu({
  choices,
  disabled,
  onChoose,
}: {
  choices: GrantChoice[];
  disabled: boolean;
  onChoose: (choice: GrantChoice) => void;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownTrigger
        accessibilityRole="button"
        accessibilityLabel={t("vaultRequest.always")}
        disabled={disabled}
        testID="vault-request-always"
      >
        {t("vaultRequest.always")}
      </DropdownTrigger>
      <DropdownMenuContent side="top" align="end" width={320}>
        {choices.map((choice) => (
          <AlwaysChoice key={choice.id} choice={choice} onChoose={onChoose} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AlwaysChoice({
  choice,
  onChoose,
}: {
  choice: GrantChoice;
  onChoose: (choice: GrantChoice) => void;
}) {
  const select = useCallback(() => onChoose(choice), [choice, onChoose]);
  return (
    <DropdownMenuItem onSelect={select} testID={`vault-request-always-${choice.id}`}>
      {choice.label}
    </DropdownMenuItem>
  );
}

interface SimpleActionsProps {
  request: VaultRequest;
  path: ProofPath;
  pending: boolean;
  stacked: boolean;
  hasPassphrase: boolean;
  hasMaster: boolean;
  onAct: (action: CardAction) => void;
}

function SimpleActions({
  request,
  path,
  pending,
  stacked,
  hasPassphrase,
  hasMaster,
  onAct,
}: SimpleActionsProps) {
  const { t } = useTranslation();
  const isUnlock = request.waitingFor === "unlock";
  const press = useCallback(
    () => onAct(isUnlock ? { kind: "unlock" } : { kind: "load" }),
    [isUnlock, onAct],
  );
  let label = isUnlock ? t("vaultRequest.unlock") : t("vaultRequest.load");
  if (isUnlock && path === "touch-id") label = t("vaultRequest.unlockWithTouchId");
  const needsText = isUnlock ? path === "passphrase" && !hasPassphrase : !hasMaster;
  return (
    <Button
      variant="default"
      onPress={press}
      disabled={pending || needsText}
      style={stacked ? styles.fullWidth : undefined}
      testID="vault-request-primary"
    >
      {pending ? t("vaultRequest.working") : label}
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    gap: theme.spacing[3],
    padding: theme.spacing[4],
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius["2xl"],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  command: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    alignItems: "center",
  },
  actionsStacked: {
    flexDirection: "column",
    gap: theme.spacing[2],
    alignItems: "stretch",
  },
  fullWidth: {
    width: "100%",
  },
}));
