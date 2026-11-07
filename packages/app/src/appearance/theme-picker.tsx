import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { getDesktopHost, type DesktopHostBridge, type PimiAppearance } from "@/desktop/host";
import { DEFAULT_THEME_PREFERENCE, useAppSettings, type AppSettings } from "@/hooks/use-settings";
import type { PluginThemeOption } from "@/plugins/themes";
import {
  THEME_OPTIONS,
  PLUGIN_THEME_PREFERENCE,
  PIMI_APPEARANCE_THEMES,
  REGISTERED_THEMES,
  darkTheme,
  lightTheme,
  type Theme,
} from "@/styles/theme";
import { useContributedThemes } from "./provider";

type BuiltInThemePreference = Exclude<AppSettings["theme"], typeof PLUGIN_THEME_PREFERENCE>;

// System leads the grid because it is the default.
const PICKER_THEME_OPTIONS = [
  ...THEME_OPTIONS.filter((option) => option.name === "auto"),
  ...THEME_OPTIONS.filter((option) => option.name !== "auto"),
];

const PREVIEW_ASPECT_RATIO = 16 / 9;

/**
 * Every theme as a tile with a small preview drawn from its own tokens. Picking a tile applies
 * the theme to the whole app at once. Settings → Appearance and first-run setup share it.
 */
export function ThemePicker() {
  const bridge = getDesktopHost()?.pimiAppearance;
  return bridge ? <PimiThemePicker bridge={bridge} /> : <BuiltInThemePicker />;
}

const pimiOptions = [
  { mode: "system", label: "System", preview: "pimi-system" },
  { mode: "light", label: "Blush", preview: REGISTERED_THEMES[PIMI_APPEARANCE_THEMES.light] },
  { mode: "dark", label: "Dark", preview: REGISTERED_THEMES[PIMI_APPEARANCE_THEMES.dark] },
  { mode: "paper", label: "Paper", preview: REGISTERED_THEMES[PIMI_APPEARANCE_THEMES.paper] },
] as const;

function PimiThemePicker({ bridge }: { bridge: NonNullable<DesktopHostBridge["pimiAppearance"]> }) {
  const [mode, setMode] = useState(bridge.get);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => bridge.subscribe(setMode), [bridge]);
  const selectMode = useCallback(
    async (next: PimiAppearance) => {
      if (next === mode) return;
      setSaving(true);
      setError(false);
      try {
        await bridge.set(next);
      } catch {
        setError(true);
      } finally {
        setSaving(false);
      }
    },
    [bridge, mode],
  );
  return (
    <View style={styles.pimiSettings}>
      <View style={styles.grid} accessibilityRole="radiogroup" accessibilityLabel="Appearance">
        {pimiOptions.map((option) => (
          <PimiThemeTile
            key={option.mode}
            option={option}
            selected={mode === option.mode}
            disabled={saving}
            selectMode={selectMode}
          />
        ))}
      </View>
      <Text style={styles.hint}>Applies to all Pimi windows.</Text>
      {error && (
        <Text style={styles.error} accessibilityRole="alert">
          Couldn’t save appearance. Try again.
        </Text>
      )}
    </View>
  );
}

function PimiThemeTile({
  option,
  selected,
  disabled,
  selectMode,
}: {
  option: (typeof pimiOptions)[number];
  selected: boolean;
  disabled: boolean;
  selectMode: (mode: PimiAppearance) => Promise<void>;
}) {
  const press = useCallback(() => void selectMode(option.mode), [option.mode, selectMode]);
  return (
    <ThemeTile
      label={option.label}
      selected={selected}
      disabled={disabled}
      onPress={press}
      previewTheme={option.preview}
    />
  );
}

function BuiltInThemePicker() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const { options: pluginThemes, selected: selectedPluginTheme, select } = useContributedThemes();
  // A selected contribution that is no longer installed shows the fallback the app renders.
  const builtInValue =
    settings.theme === PLUGIN_THEME_PREFERENCE ? DEFAULT_THEME_PREFERENCE : settings.theme;

  const selectBuiltIn = useCallback(
    (theme: BuiltInThemePreference) => {
      void updateSettings({ theme });
    },
    [updateSettings],
  );

  return (
    <View
      style={styles.grid}
      accessibilityRole="radiogroup"
      accessibilityLabel={t("settings.appearance.theme.title")}
    >
      {PICKER_THEME_OPTIONS.map((option) => (
        <BuiltInThemeTile
          key={option.name}
          value={option.name}
          selected={selectedPluginTheme === null && builtInValue === option.name}
          onSelect={selectBuiltIn}
        />
      ))}
      {pluginThemes.map((option) => (
        <PluginThemeTile
          key={option.id}
          option={option}
          selected={selectedPluginTheme?.id === option.id}
          onSelect={select}
        />
      ))}
    </View>
  );
}

function BuiltInThemeTile({
  value,
  selected,
  onSelect,
}: {
  value: BuiltInThemePreference;
  selected: boolean;
  onSelect: (value: BuiltInThemePreference) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onSelect(value), [onSelect, value]);
  const option = THEME_OPTIONS.find((candidate) => candidate.name === value);
  return (
    <ThemeTile
      label={t(`settings.appearance.theme.options.${value}`)}
      selected={selected}
      onPress={handlePress}
      previewTheme={option && "theme" in option ? option.theme : "system"}
    />
  );
}

function PluginThemeTile({
  option,
  selected,
  onSelect,
}: {
  option: PluginThemeOption;
  selected: boolean;
  onSelect: (option: PluginThemeOption) => void;
}) {
  const handlePress = useCallback(() => onSelect(option), [onSelect, option]);
  return (
    <ThemeTile
      label={option.name}
      selected={selected}
      onPress={handlePress}
      previewTheme={option.theme}
    />
  );
}

function ThemeTile({
  label,
  selected,
  disabled,
  onPress,
  previewTheme,
}: {
  label: string;
  selected: boolean;
  disabled?: boolean;
  onPress: () => void;
  /** "system" follows the OS, so its preview shows both halves. */
  previewTheme: Theme | "system" | "pimi-system";
}) {
  const accessibilityState = useMemo(() => ({ checked: selected, disabled }), [disabled, selected]);
  const tileStyle = useCallback(
    ({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.tile,
      hovered && !selected && styles.tileHovered,
      selected && styles.tileSelected,
    ],
    [selected],
  );
  return (
    <View style={styles.cell}>
      <PressHighlight
        style={tileStyle}
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="radio"
        accessibilityLabel={label}
        accessibilityState={accessibilityState}
        aria-checked={selected}
      >
        <View style={styles.previewFrame}>
          <ThemeTilePreview theme={previewTheme} />
        </View>
        <Text style={styles.label} numberOfLines={1}>
          {label}
        </Text>
      </PressHighlight>
    </View>
  );
}

function ThemeTilePreview({ theme }: { theme: Theme | "system" | "pimi-system" }) {
  if (theme === "system") return <SystemThemePreview />;
  if (theme === "pimi-system") {
    return (
      <SystemThemePreview
        light={REGISTERED_THEMES[PIMI_APPEARANCE_THEMES.light]}
        dark={REGISTERED_THEMES[PIMI_APPEARANCE_THEMES.dark]}
      />
    );
  }
  return <ThemePreview theme={theme} />;
}

/** A sketch of the app — sidebar, a few lines of text and an accent bubble — in `theme`'s colors. */
function ThemePreview({ theme }: { theme: Theme }) {
  const colors = theme.colors;
  const previewStyles = useMemo(
    () => ({
      root: [styles.preview, { backgroundColor: colors.surface0 }],
      sidebar: [styles.previewSidebar, { backgroundColor: colors.surfaceSidebar }],
      mutedLine: { backgroundColor: colors.foregroundMuted },
      strongLine: { backgroundColor: colors.foreground },
      bubble: [styles.previewBubble, { backgroundColor: colors.accent }],
    }),
    [colors],
  );
  return (
    <View style={previewStyles.root}>
      <View style={previewStyles.sidebar}>
        <View style={[styles.previewLine, styles.sidebarLineWide, previewStyles.mutedLine]} />
        <View style={[styles.previewLine, styles.sidebarLineNarrow, previewStyles.mutedLine]} />
        <View style={[styles.previewLine, styles.sidebarLineMedium, previewStyles.mutedLine]} />
      </View>
      <View style={styles.previewMain}>
        <View style={[styles.previewTitle, previewStyles.strongLine]} />
        <View style={[styles.previewLine, styles.mainLineWide, previewStyles.mutedLine]} />
        <View style={[styles.previewLine, styles.mainLineNarrow, previewStyles.mutedLine]} />
        <View style={previewStyles.bubble} />
      </View>
    </View>
  );
}

/** "System" follows the OS: light on the left half, dark on the right. */
function SystemThemePreview({
  light = lightTheme,
  dark = darkTheme,
}: {
  light?: Theme;
  dark?: Theme;
}) {
  return (
    <View style={styles.preview}>
      <ThemePreview theme={light} />
      <View style={styles.systemDarkHalf}>
        <View style={styles.systemDarkOffset}>
          <ThemePreview theme={dark} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  pimiSettings: { gap: theme.spacing[3] },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  // Columns fill the row: each cell is a fixed fraction of it, and the half-gap padding on every
  // cell plus the negative margin here leaves exactly one gap between neighbors.
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    margin: -theme.spacing[3] / 2,
  },
  cell: {
    width: { xs: "50%", md: "25%" },
    padding: theme.spacing[3] / 2,
  },
  tile: {
    padding: theme.spacing[1],
    gap: theme.spacing[1],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[2],
    borderColor: "transparent",
  },
  tileHovered: {
    backgroundColor: theme.colors.surface2,
  },
  tileSelected: {
    borderColor: theme.colors.accent,
  },
  previewFrame: {
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[1],
  },
  preview: {
    width: "100%",
    aspectRatio: PREVIEW_ASPECT_RATIO,
    flexDirection: "row",
    overflow: "hidden",
  },
  previewSidebar: {
    width: 36,
    paddingHorizontal: 6,
    paddingVertical: 8,
    gap: 5,
  },
  previewMain: {
    flex: 1,
    padding: 8,
    gap: 5,
  },
  previewLine: {
    height: 4,
    borderRadius: 2,
    opacity: 0.6,
  },
  previewTitle: {
    width: "55%",
    height: 5,
    borderRadius: 2,
  },
  sidebarLineWide: { width: "100%" },
  sidebarLineNarrow: { width: "60%" },
  sidebarLineMedium: { width: "80%" },
  mainLineWide: { width: "90%" },
  mainLineNarrow: { width: "65%" },
  previewBubble: {
    marginTop: "auto",
    alignSelf: "flex-end",
    width: "45%",
    height: 10,
    borderRadius: 5,
  },
  systemDarkHalf: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: "50%",
    width: "50%",
    overflow: "hidden",
  },
  // A full-width dark preview shifted left by half, so only its right half shows.
  systemDarkOffset: {
    width: "200%",
    marginLeft: "-100%",
  },
}));
