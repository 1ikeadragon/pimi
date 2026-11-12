import { useCallback, useEffect, useMemo } from "react";
import { FlatList, View, type ListRenderItemInfo } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { WorkspaceSearchMatch } from "@pimi/protocol/workspace-search";
import { useSessionStore } from "@/stores/session-store";
import { openWorkspaceFileLocation } from "@/workspace/file-open/open-location";
import { confirmDialog } from "@/utils/confirm-dialog";
import { searchKeyOf } from "./query";
import { getWorkspaceSearchStore, dismissalKey, type SearchResultFile } from "./store";
import {
  cancelWorkspaceSearch,
  planWorkspaceReplace,
  runWorkspaceReplace,
  runWorkspaceSearch,
} from "./run";
import { FileResultRow, MatchResultRow, SEARCH_ROW_HEIGHT, type SearchRow } from "./result-rows";
import { SearchForm } from "./search-form";
import { SearchStatus } from "./search-status";

const SEARCH_DEBOUNCE_MS = 250;

function rowKey(row: SearchRow): string {
  return row.key;
}

function getItemLayout(_: ArrayLike<SearchRow> | null | undefined, index: number) {
  return { length: SEARCH_ROW_HEIGHT, offset: SEARCH_ROW_HEIGHT * index, index };
}

export function WorkspaceSearchView({
  serverId,
  workspaceId,
  workspaceKey,
}: {
  serverId: string;
  workspaceId: string;
  workspaceKey: string;
}) {
  const { t } = useTranslation();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const useSearchStore = getWorkspaceSearchStore(workspaceKey);
  const state = useSearchStore();
  const { form, files, dismissed, replaceOpen, ranKey, status, replacing, stats } = state;
  const { toggleFile, dismiss } = useSearchStore.getState();

  // One search per change of what is being searched for. The replacement text is not part of it.
  const searchKey = searchKeyOf(form);
  const search = useCallback(() => {
    if (client) runWorkspaceSearch({ store: useSearchStore, client, workspaceId });
  }, [client, useSearchStore, workspaceId]);
  const stop = useCallback(() => {
    if (client) cancelWorkspaceSearch({ store: useSearchStore, client });
  }, [client, useSearchStore]);
  useEffect(() => {
    if (ranKey === searchKey || (ranKey === null && form.query.length === 0)) return;
    const timer = setTimeout(search, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [form.query.length, ranKey, search, searchKey]);

  const canReplace =
    replaceOpen &&
    status === "done" &&
    stats !== null &&
    stats.limitHit === null &&
    !stats.cancelled &&
    files.length > 0 &&
    !replacing &&
    client !== null;
  const replaceAll = useCallback(async () => {
    if (!client) return;
    const plan = planWorkspaceReplace(useSearchStore, workspaceKey);
    if (plan.files.length === 0) return;
    const current = useSearchStore.getState().form;
    const confirmed = await confirmDialog({
      title: t("workspaceSearch.replaceConfirmTitle"),
      message: t("workspaceSearch.replaceConfirmMessage", {
        count: plan.occurrences,
        files: t("workspaceSearch.fileCount", { count: plan.files.length }),
        query: current.query,
        replacement: current.replacement,
      }),
      confirmLabel: t("workspaceSearch.replaceAll"),
      cancelLabel: t("common.actions.cancel"),
      destructive: true,
    });
    if (confirmed) await runWorkspaceReplace({ store: useSearchStore, client, workspaceId, plan });
  }, [client, useSearchStore, t, workspaceId, workspaceKey]);

  const rows = useMemo<SearchRow[]>(() => {
    const flat: SearchRow[] = [];
    for (const file of files) {
      flat.push({ type: "file", key: `f:${file.path}`, file });
      if (file.collapsed) continue;
      for (const match of file.matches) {
        flat.push({ type: "match", key: `m:${file.path}:${match.line}`, file, match });
      }
    }
    return flat;
  }, [files]);

  const openMatch = useCallback(
    (file: SearchResultFile, match: WorkspaceSearchMatch) => {
      const first = match.ranges[0];
      openWorkspaceFileLocation({
        serverId,
        workspaceId,
        location: {
          path: file.path,
          lineStart: match.line,
          // The editor counts columns from 1; a match range is a 0-based offset into the preview.
          ...(first
            ? {
                columnStart: match.previewOffset + first[0] + 1,
                columnEnd: match.previewOffset + first[1] + 1,
              }
            : {}),
        },
      });
    },
    [serverId, workspaceId],
  );
  const dismissMatch = useCallback((path: string, line: number) => dismiss(path, line), [dismiss]);
  const dismissFile = useCallback((path: string) => dismiss(path, null), [dismiss]);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<SearchRow>) =>
      item.type === "file" ? (
        <FileResultRow file={item.file} onToggle={toggleFile} onDismiss={dismissFile} />
      ) : (
        <MatchResultRow
          file={item.file}
          match={item.match}
          form={form}
          replacing={replaceOpen}
          dismissed={dismissed.has(dismissalKey(item.file.path, item.match.line))}
          onOpen={openMatch}
          onDismiss={dismissMatch}
        />
      ),
    [dismissFile, dismissMatch, dismissed, form, openMatch, replaceOpen, toggleFile],
  );

  return (
    <View style={styles.container} testID="workspace-search">
      <View style={styles.header}>
        <SearchForm
          useStore={useSearchStore}
          canReplace={canReplace}
          onSearch={search}
          onStop={stop}
          onReplaceAll={replaceAll}
        />
        <SearchStatus
          state={state}
          canSearch={form.query.length > 0}
          onStop={stop}
          onRefresh={search}
        />
      </View>
      <FlatList
        style={styles.list}
        data={rows}
        keyExtractor={rowKey}
        renderItem={renderItem}
        getItemLayout={getItemLayout}
        initialNumToRender={40}
        windowSize={11}
        keyboardShouldPersistTaps="handled"
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  header: {
    gap: theme.spacing[1],
    padding: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  list: { flex: 1, minHeight: 0 },
}));
