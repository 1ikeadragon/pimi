import { useCallback, useEffect, useRef } from "react";
import { View, type NativeSyntheticEvent, type TextInputKeyPressEventData } from "react-native";
import {
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  FolderX,
  Regex,
  WholeWord,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { mutedIconColorMapping } from "@/components/ui/icon-button-chrome";
import { paneContentToolbarIconSize, ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { type EditingTextInputHandle } from "@/components/ui/text-input";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";
import { SearchField } from "./search-field";
import type { WorkspaceSearchStore } from "./store";
import type { UseBoundStore, StoreApi } from "zustand";

const CaseIcon = withUnistyles(CaseSensitive, mutedIconColorMapping);
const WordIcon = withUnistyles(WholeWord, mutedIconColorMapping);
const RegexIcon = withUnistyles(Regex, mutedIconColorMapping);
const IgnoreIcon = withUnistyles(FolderX, mutedIconColorMapping);
const ChevronDownIcon = withUnistyles(ChevronDown, mutedIconColorMapping);
const ChevronRightIcon = withUnistyles(ChevronRight, mutedIconColorMapping);

function selectAll(field: EditingTextInputHandle | null) {
  if (!field) return;
  field.focus();
  const text = field.getText();
  field.replaceText(text, { start: 0, end: text.length });
}

/** The query, replace, include and exclude fields with their toggles. */
export function SearchForm({
  useStore,
  canReplace,
  onSearch,
  onStop,
  onReplaceAll,
}: {
  /** The workspace's search store hook; named like one so the React Compiler keeps its call order. */
  useStore: UseBoundStore<StoreApi<WorkspaceSearchStore>>;
  canReplace: boolean;
  onSearch(): void;
  onStop(): void;
  onReplaceAll(): void;
}) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const glyphSize = paneContentToolbarIconSize(isCompact);
  const form = useStore((state) => state.form);
  const replaceOpen = useStore((state) => state.replaceOpen);
  const focusRequest = useStore((state) => state.focusRequest);
  const { setForm, setReplaceOpen } = useStore.getState();
  const queryInput = useRef<EditingTextInputHandle>(null);

  // The keyboard shortcuts bump focusRequest and may seed the query from the editor selection.
  const handledFocusRequest = useRef(-1);
  useEffect(() => {
    if (focusRequest === handledFocusRequest.current) return;
    handledFocusRequest.current = focusRequest;
    const seeded = useStore.getState().form.query;
    if (queryInput.current && queryInput.current.getText() !== seeded) {
      queryInput.current.replaceText(seeded);
    }
    selectAll(queryInput.current);
  }, [focusRequest, useStore]);
  const onQueryKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      const key = event.nativeEvent as TextInputKeyPressEventData & { isComposing?: boolean };
      if (isImeComposingKeyboardEvent(key)) return;
      if (key.key === "Enter") {
        event.preventDefault();
        onSearch();
      } else if (key.key === "Escape") {
        onStop();
      }
    },
    [onSearch, onStop],
  );
  const onQueryChange = useCallback((query: string) => setForm({ query }), [setForm]);
  const onReplacementChange = useCallback(
    (replacement: string) => setForm({ replacement }),
    [setForm],
  );
  const onIncludeChange = useCallback((include: string) => setForm({ include }), [setForm]);
  const onExcludeChange = useCallback((exclude: string) => setForm({ exclude }), [setForm]);
  const toggleCase = useCallback(
    () => setForm({ matchCase: !useStore.getState().form.matchCase }),
    [setForm, useStore],
  );
  const toggleWord = useCallback(
    () => setForm({ wholeWord: !useStore.getState().form.wholeWord }),
    [setForm, useStore],
  );
  const toggleRegex = useCallback(
    () => setForm({ isRegex: !useStore.getState().form.isRegex }),
    [setForm, useStore],
  );
  const toggleIgnore = useCallback(
    () => setForm({ useIgnoreFiles: !useStore.getState().form.useIgnoreFiles }),
    [setForm, useStore],
  );
  const toggleReplaceOpen = useCallback(
    () => setReplaceOpen(!useStore.getState().replaceOpen),
    [setReplaceOpen, useStore],
  );

  return (
    <View style={styles.form}>
      <View style={styles.row}>
        <ToolbarButton
          label={t("workspaceSearch.toggleReplace")}
          compact={isCompact}
          aria-expanded={replaceOpen}
          onPress={toggleReplaceOpen}
        >
          {replaceOpen ? (
            <ChevronDownIcon size={glyphSize} />
          ) : (
            <ChevronRightIcon size={glyphSize} />
          )}
        </ToolbarButton>
        <SearchField
          ref={queryInput}
          label={t("workspaceSearch.query")}
          initialValue={form.query}
          onChangeText={onQueryChange}
          onKeyPress={onQueryKeyPress}
        >
          <ToolbarButton
            label={t("workspaceSearch.matchCase")}
            compact={isCompact}
            selected={form.matchCase}
            onPress={toggleCase}
          >
            <CaseIcon size={glyphSize} />
          </ToolbarButton>
          <ToolbarButton
            label={t("workspaceSearch.wholeWord")}
            compact={isCompact}
            selected={form.wholeWord}
            onPress={toggleWord}
          >
            <WordIcon size={glyphSize} />
          </ToolbarButton>
          <ToolbarButton
            label={t("workspaceSearch.regex")}
            compact={isCompact}
            selected={form.isRegex}
            onPress={toggleRegex}
          >
            <RegexIcon size={glyphSize} />
          </ToolbarButton>
        </SearchField>
      </View>
      {replaceOpen ? (
        <View style={styles.row}>
          <View style={styles.gutter} />
          <SearchField
            label={t("workspaceSearch.replacement")}
            initialValue={form.replacement}
            onChangeText={onReplacementChange}
          />
          <Button variant="ghost" size="sm" disabled={!canReplace} onPress={onReplaceAll}>
            {t("workspaceSearch.replaceAll")}
          </Button>
        </View>
      ) : null}
      <View style={styles.row}>
        <View style={styles.gutter} />
        <SearchField
          label={t("workspaceSearch.include")}
          initialValue={form.include}
          onChangeText={onIncludeChange}
        />
      </View>
      <View style={styles.row}>
        <View style={styles.gutter} />
        <SearchField
          label={t("workspaceSearch.exclude")}
          initialValue={form.exclude}
          onChangeText={onExcludeChange}
        >
          <ToolbarButton
            label={t("workspaceSearch.useIgnoreFiles")}
            compact={isCompact}
            selected={form.useIgnoreFiles}
            onPress={toggleIgnore}
          >
            <IgnoreIcon size={glyphSize} />
          </ToolbarButton>
        </SearchField>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  form: { gap: theme.spacing[1] },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  gutter: { width: 28 },
}));
