import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useTranslation } from "@/i18n/use-translation";
import { StyleSheet } from "react-native-unistyles";
import type { CodeNavigationServerStatus } from "@pimi/protocol/messages";
import { SettingsCard, SettingsRow } from "@/components/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import {
  LanguageServerModal,
  parseServerArgs,
  type LanguageServerDraft,
} from "./language-server-modal";

type Status = CodeNavigationServerStatus["status"];

const STATUS_VARIANT: Record<Status, StatusBadgeVariant> = {
  found: "success",
  not_found: "muted",
  failed: "error",
};

interface TestState {
  pending: boolean;
  ok?: boolean;
  message?: string;
}

/** Per-host language servers behind Go to Definition, Find References and Rename in the editor. */
export function HostEditorPage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const params = useLocalSearchParams<{ language?: string }>();
  const focused = typeof params.language === "string" ? params.language : null;
  const [servers, setServers] = useState<CodeNavigationServerStatus[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [editing, setEditing] = useState<CodeNavigationServerStatus | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!client || !isConnected) return;
    let cancelled = false;
    setLoadError(null);
    client
      .listCodeNavigationServers()
      .then((list) => {
        if (!cancelled) setServers(list);
        return list;
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [client, isConnected, revision]);

  const ordered = useMemo(() => {
    if (!servers) return null;
    return [...servers].sort(
      (a, b) => Number(b.language === focused) - Number(a.language === focused),
    );
  }, [focused, servers]);

  const describeTest = useCallback(
    (result: {
      ok: boolean;
      name: string | null;
      version: string | null;
      error: string | null;
    }) => {
      if (!result.ok) {
        return t("settings.languageServers.testFailed", { error: result.error ?? "" });
      }
      return t("settings.languageServers.testOk", {
        server: [result.name, result.version].filter(Boolean).join(" ") || "server",
      });
    },
    [t],
  );

  const runTest = useCallback(
    async (language: string) => {
      if (!client) return;
      setTests((current) => ({ ...current, [language]: { pending: true } }));
      try {
        const result = await client.testCodeNavigationServer({ language });
        setTests((current) => ({
          ...current,
          [language]: { pending: false, ok: result.ok, message: describeTest(result) },
        }));
      } catch (error) {
        setTests((current) => ({
          ...current,
          [language]: {
            pending: false,
            ok: false,
            message: t("settings.languageServers.testFailed", {
              error: error instanceof Error ? error.message : String(error),
            }),
          },
        }));
      }
    },
    [client, describeTest, t],
  );

  const saveOverrides = useCallback(
    async (language: string, draft: LanguageServerDraft | null) => {
      const others = (config?.editorLanguageServers ?? []).filter(
        (entry) => entry.language !== language,
      );
      const next = draft
        ? [...others, { language, command: draft.command, args: parseServerArgs(draft.args) }]
        : others;
      await patchConfig({ editorLanguageServers: next });
      setTests((current) => ({ ...current, [language]: { pending: false } }));
      setRevision((value) => value + 1);
    },
    [config?.editorLanguageServers, patchConfig],
  );

  const handleModalSave = useCallback(
    async (draft: LanguageServerDraft) => {
      if (editing) await saveOverrides(editing.language, draft);
    },
    [editing, saveOverrides],
  );

  const handleModalTest = useCallback(
    async (draft: LanguageServerDraft) => {
      if (!client || !editing) return { ok: false, message: "" };
      const result = await client.testCodeNavigationServer({
        language: editing.language,
        command: draft.command,
        args: parseServerArgs(draft.args),
      });
      return { ok: result.ok, message: describeTest(result) };
    },
    [client, describeTest, editing],
  );

  const handleModalClose = useCallback(() => setEditing(null), []);
  const editingDraft = useMemo<LanguageServerDraft>(
    () => ({
      command: editing?.custom?.command ?? editing?.path ?? "",
      args: (editing?.custom?.args ?? []).join(" "),
    }),
    [editing],
  );

  if (!isConnected) {
    return (
      <SettingsSection title={t("settings.languageServers.title")}>
        <SettingsCard>
          <Text style={styles.muted}>{t("settings.languageServers.offline")}</Text>
        </SettingsCard>
      </SettingsSection>
    );
  }

  return (
    <View testID="editor-settings-page">
      <SettingsSection
        title={t("settings.languageServers.title")}
        info={t("settings.languageServers.description")}
      >
        {loadError ? (
          <SettingsCard>
            <Text style={styles.failure}>
              {t("settings.languageServers.loadError", { error: loadError })}
            </Text>
          </SettingsCard>
        ) : null}
        {ordered ? (
          <SettingsCard testID="language-server-list">
            {ordered.map((server) => (
              <LanguageServerRow
                key={server.language}
                server={server}
                highlighted={server.language === focused}
                test={tests[server.language]}
                onTest={runTest}
                onEdit={setEditing}
                onReset={saveOverrides}
              />
            ))}
          </SettingsCard>
        ) : (
          <LoadingSpinner size="large" color={styles.spinnerColor.color} />
        )}
      </SettingsSection>
      <LanguageServerModal
        visible={editing !== null}
        language={editing?.label ?? ""}
        initialDraft={editingDraft}
        onClose={handleModalClose}
        onSave={handleModalSave}
        onTest={handleModalTest}
      />
    </View>
  );
}

function LanguageServerRow({
  server,
  highlighted,
  test,
  onTest,
  onEdit,
  onReset,
}: {
  server: CodeNavigationServerStatus;
  highlighted: boolean;
  test: TestState | undefined;
  onTest(language: string): void;
  onEdit(server: CodeNavigationServerStatus): void;
  onReset(language: string, draft: null): Promise<void>;
}) {
  const { t } = useTranslation();
  const configurable = server.source !== "bundled";
  const handleTest = useCallback(() => onTest(server.language), [onTest, server.language]);
  const handleEdit = useCallback(() => onEdit(server), [onEdit, server]);
  const handleReset = useCallback(
    () => void onReset(server.language, null),
    [onReset, server.language],
  );
  const badge = useMemo(
    () => (
      <StatusBadge
        label={t(`settings.languageServers.status.${server.status}`)}
        variant={STATUS_VARIANT[server.status]}
        size="xs"
      />
    ),
    [server.status, t],
  );
  const detail = [
    server.name && server.version ? `${server.name} ${server.version}` : server.name,
    t(`settings.languageServers.source.${server.source}`),
  ]
    .filter(Boolean)
    .join(" · ");
  const hint = useMemo(
    () => (
      <View style={styles.hint}>
        <Text style={styles.detail}>{detail}</Text>
        {server.path ? (
          <Text style={styles.path} selectable testID={`language-server-path-${server.language}`}>
            {server.path}
          </Text>
        ) : null}
        {server.status === "not_found" && server.installHint ? (
          <Text style={styles.detail}>
            {t("settings.languageServers.install", { command: server.installHint })}
          </Text>
        ) : null}
        {server.error ? (
          <Text style={styles.failure} testID={`language-server-error-${server.language}`}>
            {server.error}
          </Text>
        ) : null}
        {test?.message ? (
          <Text
            style={test.ok ? styles.success : styles.failure}
            testID={`language-server-test-${server.language}`}
          >
            {test.message}
          </Text>
        ) : null}
      </View>
    ),
    [
      detail,
      server.error,
      server.installHint,
      server.language,
      server.path,
      server.status,
      t,
      test,
    ],
  );
  return (
    <View
      style={highlighted ? styles.highlight : undefined}
      testID={`language-server-${server.language}`}
    >
      <SettingsRow label={server.label} labelAccessory={badge} hint={hint}>
        {configurable ? (
          <View style={styles.actions}>
            <Button
              variant="secondary"
              size="sm"
              onPress={handleTest}
              disabled={test?.pending || server.status === "not_found"}
              testID={`language-server-test-button-${server.language}`}
            >
              {test?.pending
                ? t("settings.languageServers.testing")
                : t("settings.languageServers.test")}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onPress={handleEdit}
              testID={`language-server-edit-${server.language}`}
            >
              {server.custom
                ? t("settings.languageServers.change")
                : t("settings.languageServers.choose")}
            </Button>
            {server.custom ? (
              <Button
                variant="ghost"
                size="sm"
                onPress={handleReset}
                testID={`language-server-reset-${server.language}`}
              >
                {t("settings.languageServers.reset")}
              </Button>
            ) : null}
          </View>
        ) : null}
      </SettingsRow>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  spinnerColor: { color: theme.colors.foregroundMuted },
  hint: { gap: theme.spacing[1] },
  detail: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  path: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
  success: { color: theme.colors.palette.green[400], fontSize: theme.fontSize.sm },
  failure: { color: theme.colors.palette.red[300], fontSize: theme.fontSize.sm },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    padding: theme.spacing[3],
  },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2], alignItems: "center" },
  highlight: { backgroundColor: theme.colors.surface1 },
}));
