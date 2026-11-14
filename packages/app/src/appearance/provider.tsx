import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { UnistylesRuntime } from "react-native-unistyles";
import { getDesktopHost } from "@/desktop/host";
import { isPimiAndroid } from "@/utils/pimi-mobile";
import { useColorScheme } from "@/hooks/use-color-scheme";
import {
  DEFAULT_THEME_PREFERENCE,
  resolveContentMaxWidth,
  useAppSettings,
  type AppSettings,
} from "@/hooks/use-settings";
import {
  rememberPluginThemeHost,
  usePluginThemeCatalog,
  type PluginThemeOption,
} from "@/plugins/themes";
import {
  PLUGIN_THEME_NAMES,
  PLUGIN_THEME_PREFERENCE,
  PIMI_APPEARANCE_THEMES,
  REGISTERED_THEMES,
  THEME_TO_UNISTYLES,
} from "@/styles/theme";
import { applyAppearance } from "./apply";
import { PLUGIN_BACKDROP_APPEARANCE } from "./active-backdrop";
import { applyBackdrop } from "./apply-backdrop";
import { BUILTIN_BACKDROPS } from "./builtin-backdrops";
import { AppearanceSystemBars } from "./system-bars";

interface ContributedThemes {
  options: PluginThemeOption[];
  selected: PluginThemeOption | null;
  select: (option: PluginThemeOption) => void;
}

interface ApplyThemeInput {
  preference: AppSettings["theme"];
  contributedTheme: PluginThemeOption | null;
}

const ContributedThemesContext = createContext<ContributedThemes | null>(null);

/** `data-appearance` tells appearance.css which textures the root drops; null removes it. */
function setRootAppearance(value: string | null): void {
  if (typeof document === "undefined") return;
  if (value === null) delete document.documentElement.dataset.appearance;
  else document.documentElement.dataset.appearance = value;
}

function applyTheme({ preference, contributedTheme }: ApplyThemeInput): void {
  if (contributedTheme) {
    const themeName = PLUGIN_THEME_NAMES[contributedTheme.theme.colorScheme];
    UnistylesRuntime.updateTheme(themeName, () => contributedTheme.theme);
    UnistylesRuntime.setAdaptiveThemes(false);
    UnistylesRuntime.setTheme(themeName);
    applyBackdrop(contributedTheme.backdrop);
    setRootAppearance(contributedTheme.backdrop ? PLUGIN_BACKDROP_APPEARANCE : null);
    if (typeof document !== "undefined") {
      document.documentElement.style.removeProperty("--pimi-focus-ring");
    }
    return;
  }
  applyBackdrop(null);
  setRootAppearance(null);

  const builtInPreference =
    preference === PLUGIN_THEME_PREFERENCE ? DEFAULT_THEME_PREFERENCE : preference;
  if (builtInPreference === "auto") {
    UnistylesRuntime.setAdaptiveThemes(true);
    return;
  }

  UnistylesRuntime.setAdaptiveThemes(false);
  UnistylesRuntime.setTheme(THEME_TO_UNISTYLES[builtInPreference]);
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const { settings, updateSettings, isLoading } = useAppSettings();
  const [hasAppliedAppearance, setHasAppliedAppearance] = useState(false);
  const pimiBridge = getDesktopHost()?.pimiAppearance;
  const [pimiAppearance, setPimiAppearance] = useState(() => pimiBridge?.get());
  const systemDark = useColorScheme() === "dark";
  const options = usePluginThemeCatalog();
  const selected = useMemo(() => {
    if (settings.theme !== PLUGIN_THEME_PREFERENCE) return null;
    return options.find((option) => option.id === settings.pluginThemeId) ?? null;
  }, [options, settings.pluginThemeId, settings.theme]);

  useEffect(() => pimiBridge?.subscribe(setPimiAppearance), [pimiBridge]);

  useEffect(() => {
    if (isLoading) return;
    const themePreference = settings.theme === "auto" ? "system" : settings.theme;
    const mobileMode =
      isPimiAndroid() &&
      (themePreference === "system" || themePreference === "light" || themePreference === "dark")
        ? themePreference
        : undefined;
    const appearance = pimiAppearance ?? mobileMode;
    // A selected plugin theme wins over the desktop shell's appearance until a built-in is picked.
    if (appearance && !selected) {
      const systemMode = systemDark ? "dark" : "light";
      const mode = appearance === "system" ? systemMode : appearance;
      const theme = PIMI_APPEARANCE_THEMES[mode];
      UnistylesRuntime.setAdaptiveThemes(false);
      UnistylesRuntime.setTheme(theme);
      applyBackdrop(BUILTIN_BACKDROPS[mode] ?? null);
      setRootAppearance(mode);
      if (typeof document !== "undefined") {
        document.documentElement.style.setProperty(
          "--pimi-focus-ring",
          REGISTERED_THEMES[theme].colors.ring,
        );
      }
    } else {
      applyTheme({ preference: settings.theme, contributedTheme: selected });
    }
    applyAppearance({
      uiFontFamily: settings.uiFontFamily,
      monoFontFamily: settings.monoFontFamily,
      uiBaseFontSize: settings.uiBaseFontSize,
      contentFontSize: settings.contentFontSize,
      codeFontSize: settings.codeFontSize,
      contentMaxWidth: resolveContentMaxWidth({ contentMaxWidth: settings.contentMaxWidth }),
      syntaxTheme: settings.syntaxTheme,
    });
    setHasAppliedAppearance(true);
  }, [
    isLoading,
    pimiAppearance,
    systemDark,
    selected,
    settings.theme,
    settings.uiFontFamily,
    settings.monoFontFamily,
    settings.uiBaseFontSize,
    settings.contentFontSize,
    settings.codeFontSize,
    settings.contentMaxWidth,
    settings.syntaxTheme,
  ]);

  const select = useCallback(
    (option: PluginThemeOption) => {
      rememberPluginThemeHost(option);
      void updateSettings({
        theme: PLUGIN_THEME_PREFERENCE,
        pluginThemeId: option.id,
      });
    },
    [updateSettings],
  );
  const value = useMemo(() => ({ options, selected, select }), [options, selected, select]);

  // The first settings load changes appearance keys. Mount screens only after applying it
  // so startup does not destroy and recreate an already-visible workspace.
  if (!hasAppliedAppearance) return null;

  return (
    <ContributedThemesContext.Provider value={value}>
      <AppearanceSystemBars />
      {children}
    </ContributedThemesContext.Provider>
  );
}

export function useContributedThemes(): ContributedThemes {
  const themes = useContext(ContributedThemesContext);
  if (themes === null) throw new Error("useContributedThemes requires AppearanceProvider");
  return themes;
}
