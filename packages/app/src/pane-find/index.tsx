import {
  forwardRef,
  useCallback,
  useLayoutEffect,
  useMemo,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent,
} from "react";
import {
  Text,
  View,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
  type TextInputProps,
} from "react-native";
import {
  ArrowDown,
  ArrowUp,
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  Regex,
  WholeWord,
  X,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import {
  createControlGeometry,
  resolveControlInteractionStyles,
} from "@/components/ui/control-geometry";
import {
  mutedIconColorMapping,
  smallIconButtonChromeFrameSize,
} from "@/components/ui/icon-button-chrome";
import { paneContentToolbarIconSize, ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";
import { usesDesktopBindings } from "@/keyboard";
import { resolveShortcutKeysForAction } from "@/keyboard/keyboard-shortcuts";
import { useKeyboardShortcutOverrides } from "@/hooks/use-keyboard-shortcut-overrides";
import { getShortcutOs } from "@/utils/shortcut-platform";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { isFindShortcut, type FindShortcutPlatform } from "./find-shortcut";

export { isFindShortcut, type FindShortcutPlatform } from "./find-shortcut";
export { usePaneFindTarget, type PaneFindTarget } from "./use-pane-find-target";

/** The platform every Find surface judges the shortcut against. */
export function findShortcutPlatform(): FindShortcutPlatform {
  return { isMac: getShortcutOs() === "mac" };
}

const TextInput = withUnistyles(EditingTextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));
const ArrowUpIcon = withUnistyles(ArrowUp, mutedIconColorMapping);
const ArrowDownIcon = withUnistyles(ArrowDown, mutedIconColorMapping);
const CloseIcon = withUnistyles(X, mutedIconColorMapping);
const ChevronDownIcon = withUnistyles(ChevronDown, mutedIconColorMapping);
const ChevronRightIcon = withUnistyles(ChevronRight, mutedIconColorMapping);
const CaseIcon = withUnistyles(CaseSensitive, mutedIconColorMapping);
const WordIcon = withUnistyles(WholeWord, mutedIconColorMapping);
const RegexIcon = withUnistyles(Regex, mutedIconColorMapping);

export interface PaneFindHandle {
  focus(): void;
  /** Expands the replacement row and focuses its field. */
  openReplace(): void;
}

export type PaneFindOption = "case" | "word" | "regex";

/** Match options a surface supports. A surface that cannot honor one omits the whole group. */
export interface PaneFindOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  onToggle(option: PaneFindOption): void;
}

const OPTION_SHORTCUT_IDS: Record<PaneFindOption, string> = {
  case: "find-toggle-case",
  word: "find-toggle-word",
  regex: "find-toggle-regex",
};

export interface PaneFindProps {
  query: string;
  status: string;
  canNavigate: boolean;
  onQueryChange(query: string): void;
  onNext(): void;
  onPrevious(): void;
  onClose(): void;
  options?: PaneFindOptions;
  replace?: {
    value: string;
    onChange(value: string): void;
    onReplace(): void;
    onReplaceAll(): void;
  };
}

function OptionToggle({
  option,
  label,
  compact,
  selected,
  shortcut,
  onToggle,
  children,
}: {
  option: PaneFindOption;
  label: string;
  compact: boolean;
  selected: boolean;
  shortcut: ShortcutKey[][] | undefined;
  onToggle(option: PaneFindOption): void;
  children: ReactNode;
}) {
  const onPress = useCallback(() => onToggle(option), [onToggle, option]);
  return (
    <ToolbarButton
      label={label}
      compact={compact}
      selected={selected}
      shortcut={shortcut}
      onPress={onPress}
    >
      {children}
    </ToolbarButton>
  );
}

/**
 * The bordered box around one Find input. It owns the field chrome so the query
 * row and the replacement row land on the same rails, and so the match count can
 * sit inside the query box instead of widening the widget.
 */
const FindField = forwardRef<
  EditingTextInputHandle,
  {
    label: string;
    initialValue: string;
    height: number;
    trailing?: ReactNode;
    onChangeText(value: string): void;
    onKeyPress(event: NativeSyntheticEvent<TextInputKeyPressEventData>): void;
    autoFocus?: boolean;
    returnKeyType?: TextInputProps["returnKeyType"];
  }
>(function FindField(
  { label, initialValue, height, trailing, onChangeText, onKeyPress, autoFocus, returnKeyType },
  ref,
) {
  const [focused, setFocused] = useState(false);
  const onFocus = useCallback(() => setFocused(true), []);
  const onBlur = useCallback(() => setFocused(false), []);
  const fieldStyle = useMemo(
    () => [
      styles.field,
      { minHeight: height },
      resolveControlInteractionStyles(
        {
          controlRest: styles.controlRest,
          controlHover: styles.controlHover,
          controlActive: styles.controlActive,
        },
        { focused },
      ),
    ],
    [focused, height],
  );
  return (
    <View style={fieldStyle}>
      <TextInput
        ref={ref}
        autoFocus={autoFocus}
        selectTextOnFocus
        initialValue={initialValue}
        onChangeText={onChangeText}
        onKeyPress={onKeyPress}
        onFocus={onFocus}
        onBlur={onBlur}
        accessibilityLabel={label}
        placeholder={label}
        autoCapitalize="none"
        autoCorrect={false}
        blurOnSubmit={false}
        returnKeyType={returnKeyType}
        style={styles.input}
      />
      {trailing}
    </View>
  );
});

/** Pane-local chrome. The content owner supplies search state and commands. */
export const PaneFind = forwardRef<PaneFindHandle, PaneFindProps>(function PaneFind(
  { query, status, canNavigate, onQueryChange, onNext, onPrevious, onClose, options, replace },
  ref,
) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const controlSize = smallIconButtonChromeFrameSize(isCompact);
  const glyphSize = paneContentToolbarIconSize(isCompact);
  const rowHeight = Math.max(COLLAPSED_FIELD_HEIGHT, controlSize);
  const input = useRef<EditingTextInputHandle>(null);
  const replacementInput = useRef<EditingTextInputHandle>(null);
  useLayoutEffect(() => {
    if (input.current?.getText() !== query) input.current?.replaceText(query);
  }, [query]);
  useLayoutEffect(() => {
    if (replace && replacementInput.current?.getText() !== replace.value)
      replacementInput.current?.replaceText(replace.value);
  }, [replace]);
  const [replaceExpanded, setReplaceExpanded] = useState(false);
  const [replaceFocusRequest, setReplaceFocusRequest] = useState(0);
  const focus = useCallback(() => {
    input.current?.focus();
    const text = input.current?.getText() ?? "";
    input.current?.replaceText(text, { start: 0, end: text.length });
  }, []);
  const openReplace = useCallback(() => {
    setReplaceExpanded(true);
    setReplaceFocusRequest((request) => request + 1);
  }, []);
  // The replacement field mounts only once the row is expanded, so focus waits for it.
  useLayoutEffect(() => {
    if (replaceFocusRequest === 0 || !replaceExpanded) return;
    const field = replacementInput.current;
    if (!field) return;
    field.focus();
    const text = field.getText();
    field.replaceText(text, { start: 0, end: text.length });
  }, [replaceExpanded, replaceFocusRequest]);
  useImperativeHandle(ref, () => ({ focus, openReplace }), [focus, openReplace]);

  // Enter in the query field walks matches; in the replacement field it replaces the current one,
  // and Cmd/Ctrl+Alt+Enter replaces every match.
  const handleKey = useCallback(
    (
      event: NativeSyntheticEvent<TextInputKeyPressEventData>,
      onEnter: (key: { shiftKey: boolean; modAlt: boolean }) => void,
    ) => {
      const key = event.nativeEvent as TextInputKeyPressEventData & {
        shiftKey?: boolean;
        ctrlKey?: boolean;
        metaKey?: boolean;
        altKey?: boolean;
        isComposing?: boolean;
        keyCode?: number;
      };
      if (isImeComposingKeyboardEvent(key)) return;
      // Cmd/Ctrl+F, Cmd+G and the other Find keys arrive through the shortcut table, which sees
      // them before this input does. Only the keys that act on the field itself live here.
      if (key.key !== "Escape" && key.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      if (key.key === "Escape") onClose();
      else
        onEnter({
          shiftKey: key.shiftKey === true,
          modAlt: key.altKey === true && (key.metaKey === true || key.ctrlKey === true),
        });
    },
    [onClose],
  );
  const onKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) =>
      handleKey(event, ({ shiftKey }) => (shiftKey ? onPrevious() : onNext())),
    [handleKey, onNext, onPrevious],
  );
  const onReplaceKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) =>
      handleKey(event, ({ modAlt }) => {
        if (modAlt) replace?.onReplaceAll();
        else replace?.onReplace();
      }),
    [handleKey, replace],
  );
  const toggleReplace = useCallback(() => setReplaceExpanded((expanded) => !expanded), []);
  const gutterStyle = useMemo(
    () => [styles.gutter, { width: controlSize, height: rowHeight }],
    [controlSize, rowHeight],
  );
  const { overrides } = useKeyboardShortcutOverrides();
  const shortcutPlatform = useMemo(
    () => ({ isMac: getShortcutOs() === "mac", usesDesktopBindings }),
    [],
  );
  const fieldTrailing = useMemo(
    () => (
      <>
        <Text
          style={styles.status}
          role="status"
          accessibilityLabel={t("paneFind.matches")}
          accessibilityLiveRegion="polite"
        >
          {status}
        </Text>
        {options ? (
          <View style={styles.options}>
            {OPTION_CONTROLS.map(({ option, Icon, labelKey, selected }) => (
              <OptionToggle
                key={option}
                option={option}
                label={t(labelKey)}
                compact={isCompact}
                selected={options[selected]}
                shortcut={
                  resolveShortcutKeysForAction(
                    OPTION_SHORTCUT_IDS[option],
                    overrides,
                    shortcutPlatform,
                  ) ?? undefined
                }
                onToggle={options.onToggle}
              >
                <Icon size={glyphSize} />
              </OptionToggle>
            ))}
          </View>
        ) : null}
      </>
    ),
    [glyphSize, isCompact, options, overrides, shortcutPlatform, status, t],
  );

  return (
    <View
      style={[styles.widget, options ? styles.widgetWithOptions : null]}
      // Marks the widget as part of the editor for the shortcut table: Cmd+G, Cmd+Shift+G and the
      // option toggles act on it, where the global Cmd+Shift+G would otherwise open Changes.
      dataSet={FIND_SCOPE_DATASET}
      accessibilityLabel={t("paneFind.title")}
      {...(isWeb
        ? {
            onKeyDown: (event: KeyboardEvent) => {
              if (event.key === "Escape" && !isImeComposingKeyboardEvent(event.nativeEvent)) {
                event.preventDefault();
                event.stopPropagation();
                onClose();
              }
            },
          }
        : {})}
    >
      {replace ? (
        <View style={gutterStyle}>
          <ToolbarButton
            label={t("paneFind.toggleReplace")}
            aria-expanded={replaceExpanded}
            compact={isCompact}
            onPress={toggleReplace}
          >
            {replaceExpanded ? (
              <ChevronDownIcon size={glyphSize} />
            ) : (
              <ChevronRightIcon size={glyphSize} />
            )}
          </ToolbarButton>
        </View>
      ) : null}
      <View style={styles.rows}>
        <View style={styles.row}>
          <FindField
            ref={input}
            autoFocus
            label={t("paneFind.placeholder")}
            initialValue={query}
            height={rowHeight}
            returnKeyType="search"
            trailing={fieldTrailing}
            onChangeText={onQueryChange}
            onKeyPress={onKeyPress}
          />
          <ToolbarButton
            label={t("paneFind.previous")}
            compact={isCompact}
            disabled={!canNavigate}
            onPress={onPrevious}
          >
            <ArrowUpIcon size={glyphSize} />
          </ToolbarButton>
          <ToolbarButton
            label={t("paneFind.next")}
            compact={isCompact}
            disabled={!canNavigate}
            onPress={onNext}
          >
            <ArrowDownIcon size={glyphSize} />
          </ToolbarButton>
          <ToolbarButton label={t("paneFind.close")} compact={isCompact} onPress={onClose}>
            <CloseIcon size={glyphSize} />
          </ToolbarButton>
        </View>
        {replace && replaceExpanded ? (
          <View style={styles.row}>
            <FindField
              ref={replacementInput}
              label={t("paneFind.replaceWith")}
              initialValue={replace.value}
              height={rowHeight}
              onChangeText={replace.onChange}
              onKeyPress={onReplaceKeyPress}
            />
            <Button
              variant="ghost"
              size="sm"
              style={styles.replaceAction}
              disabled={!canNavigate}
              onPress={replace.onReplace}
            >
              {t("paneFind.replace")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              style={styles.replaceAction}
              disabled={!canNavigate}
              onPress={replace.onReplaceAll}
            >
              {t("paneFind.replaceAll")}
            </Button>
          </View>
        ) : null}
      </View>
    </View>
  );
});

/** Desktop find rows run one step tighter than a form field — this is pane chrome. */
const COLLAPSED_FIELD_HEIGHT = 28;
const FIND_WIDGET_WIDTH = 340;
const FIND_WIDGET_WIDTH_WITH_OPTIONS = 440;
const FIND_SCOPE_DATASET = { keyboardScope: "editor" };

const OPTION_CONTROLS = [
  { option: "case", Icon: CaseIcon, labelKey: "paneFind.matchCase", selected: "caseSensitive" },
  { option: "word", Icon: WordIcon, labelKey: "paneFind.wholeWord", selected: "wholeWord" },
  { option: "regex", Icon: RegexIcon, labelKey: "paneFind.regex", selected: "regex" },
] as const;

const styles = StyleSheet.create((theme) => {
  const geometry = createControlGeometry(theme);

  return {
    widget: {
      width: FIND_WIDGET_WIDTH,
      maxWidth: "100%",
      flexDirection: "row",
      padding: theme.spacing[1.5],
      gap: theme.spacing[1],
      backgroundColor: theme.colors.surface1,
      borderWidth: theme.borderWidth[1],
      borderColor: theme.colors.border,
      borderRadius: theme.borderRadius.lg,
      ...theme.shadow.md,
    },
    widgetWithOptions: { width: FIND_WIDGET_WIDTH_WITH_OPTIONS },
    options: { flexDirection: "row", alignItems: "center", flexShrink: 0 },
    // The disclosure column spans both rows so the two fields share a leading rail.
    gutter: { alignItems: "center", justifyContent: "center", flexShrink: 0 },
    rows: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
    row: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
    field: {
      flex: 1,
      minWidth: 0,
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
      paddingHorizontal: theme.spacing[2],
      backgroundColor: theme.colors.surface2,
      borderRadius: theme.borderRadius.md,
    },
    controlRest: { ...geometry.controlRest },
    controlHover: { ...geometry.controlHover },
    controlActive: { ...geometry.controlActive },
    input: {
      flex: 1,
      minWidth: 0,
      paddingHorizontal: 0,
      paddingVertical: 0,
      color: theme.colors.foreground,
      outlineWidth: 0,
      outlineColor: "transparent",
      ...geometry.fieldTextSm,
    },
    status: {
      flexShrink: 0,
      color: theme.colors.foregroundMuted,
      fontSize: theme.fontSize.sm,
    },
    // Ghost actions sit on the field's rail, so they carry the field's padding.
    replaceAction: { paddingHorizontal: theme.spacing[2] },
  };
});
