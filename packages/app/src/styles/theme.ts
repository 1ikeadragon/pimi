import { Platform } from "react-native";
import { darkHighlightColors, lightHighlightColors } from "@pimi/highlight/colors";

export const baseColors = {
  // Base colors
  white: "#ffffff",
  black: "#000000",

  // Zinc scale (primary gray palette)
  zinc: {
    50: "#fafafa",
    100: "#f4f4f5",
    200: "#e4e4e7",
    300: "#d4d4d8",
    400: "#a1a1aa",
    500: "#71717a",
    600: "#52525b",
    700: "#3f3f46",
    800: "#27272a",
    850: "#1a1a1d",
    900: "#18181b",
    950: "#121214",
  },

  // Gray scale
  gray: {
    50: "#f9fafb",
    100: "#f3f4f6",
    200: "#e5e7eb",
    300: "#d1d5db",
    400: "#9ca3af",
    500: "#6b7280",
    600: "#4b5563",
    700: "#374151",
    800: "#1f2937",
    900: "#111827",
  },

  // Slate scale
  slate: {
    200: "#e2e8f0",
  },

  // Blue scale
  blue: {
    50: "#eff6ff",
    100: "#dbeafe",
    200: "#bfdbfe",
    300: "#93c5fd",
    400: "#60a5fa",
    500: "#3b82f6",
    600: "#2563eb",
    700: "#1d4ed8",
    800: "#1e40af",
    900: "#1e3a8a",
    950: "#172554",
  },

  // Green scale
  green: {
    100: "#dcfce7",
    200: "#bbf7d0",
    400: "#4ade80",
    500: "#22c55e",
    600: "#16a34a",
    800: "#166534",
    900: "#14532d",
  },

  // Red scale
  red: {
    100: "#fee2e2",
    200: "#fecaca",
    300: "#fca5a5",
    500: "#ef4444",
    600: "#dc2626",
    800: "#991b1b",
    900: "#7f1d1d",
  },

  // Teal scale
  teal: {
    200: "#99f6e4",
  },

  // Amber scale
  amber: {
    500: "#f59e0b",
    700: "#b45309",
  },

  // Yellow scale
  yellow: {
    400: "#fbbf24",
  },

  // Purple scale
  purple: {
    500: "#a855f7",
    600: "#9333ea",
  },

  // Orange scale
  orange: {
    500: "#f97316",
    600: "#ea580c",
  },
} as const;

// Diff colors — the +/- inside a diff view, where the color *is* the signal and has to
// survive being scanned line by line, so it stays saturated. Light uses muted tones, dark
// uses the brighter palette values.
//
// A diff *stat* — the "+12 −3" footnote next to a title — is not this. It is a status
// signal, so it uses statusSuccess/statusDanger below rather than a tier of its own.
const lightDiffColors = {
  diffAddition: "#15803d", // green-700 — readable on white without screaming
  diffDeletion: "#b91c1c", // red-700
};

const darkDiffColors = {
  diffAddition: "#4ade80", // green-400
  diffDeletion: "#ef4444", // red-500
};

// Status colors — semantic signals for success/danger/warning/merged. There is exactly one
// token per signal, and every status surface uses it: PR state icons, CI check icons and
// pies, diff stats, file-change icons, status badges, usage bars. Status *dots* are the
// exception and have their own band below. A surface does not otherwise get a quieter or
// louder variant of a status color because of where it sits — if a dense list feels loud,
// that is a density or weight problem, not a color problem.
//
// The level is set by the densest consumer, the sidebar workspace list: quiet enough that a
// column of green checks reads as one line of subtitle and the single red row still stands
// out, saturated enough to name the state on its own. Every other surface follows it.
//
// Normalized, not hand-picked. Every color below shares one lightness and one chroma; only
// the hue changes, and each hue is the one that family already had. Chroma is a fixed
// fraction of what sRGB allows at that lightness and hue, because the gamut is lopsided —
// amber runs out of room long before red does, so a literal equal-chroma set leaves amber
// flat and red screaming. Equal fractions is what makes four hues read as one family.
// Regenerate with the same rule rather than nudging one value.
//
// Hues are fixed per family across both themes: success 150, danger 27, warning 70.5,
// merged 300.
const lightStatusColors = {
  // L=0.50, chroma 60% of gamut max
  statusSuccess: "#3e704a",
  statusDanger: "#9d433b",
  statusWarning: "#7b5d39",
  statusMerged: "#7347af",
};

const darkStatusColors = {
  // L=0.70, chroma 55% of gamut max
  statusSuccess: "#6cb17b",
  statusDanger: "#d8847b",
  statusWarning: "#c09664",
  statusMerged: "#a890d5",
};

// Status tints — the fill of a status badge. The status color itself at low opacity, so a
// badge takes its state's hue from the same source as its text and never drifts from it.
// Dark surfaces swallow more of the tint, so the dark band runs a little stronger.
function statusTints(colors: typeof lightStatusColors, alphaHex: string) {
  return {
    statusSuccessTint: `${colors.statusSuccess}${alphaHex}`,
    statusDangerTint: `${colors.statusDanger}${alphaHex}`,
    statusWarningTint: `${colors.statusWarning}${alphaHex}`,
  };
}

const lightStatusTints = statusTints(lightStatusColors, "1f"); // 12%
const darkStatusTints = statusTints(darkStatusColors, "29"); // 16%

// Status *dot* colors — the small filled discs on a sidebar row, and the glyphs that stand in
// for them. Same four hues and the same generation rule as the status colors above, but its
// own band, because a dot is doing a different job than a check icon or a host badge.
//
// A dot is 6pt of solid color with no shape to read and no label attached. At the status
// band's lightness the dots read dimmer than the static text and icons beside them on the same
// row, which is backwards — the dot is the row's state. The loudness comes from chroma: 90% of
// gamut max against the status family's 55-60%.
//
// Lightness is set by hue separation, not by distance from the surface. A dark dot on a light
// surface has plenty of contrast but the four hues collapse into each other at 6pt — dark green,
// dark red, dark amber and dark blue all read as "dark blob", and the point of the dot is telling
// them apart at a glance. So the light band runs as bright as the contrast floor allows: L=0.62
// is the last step where all four clear 3:1 against the sidebar's surface2 (success is the
// binding one at 3.10, and drops under 3 by L=0.64), which is WCAG's non-text minimum for a
// control that carries state.
//
// All four move together. A dot matching its siblings in lightness and chroma says only which
// state the row is in; one that does not says "this row matters more", which is a claim the
// color has no business making. Regenerate the set, never one hue.
//
// 90% and not 100%: at the gamut edge the lopsidedness is worst — green reaches C=0.215 while
// blue manages 0.116 — so the set stops reading as one family and green wins. Red running out
// of chroma as lightness climbs is what caps the dark band at L=0.72; higher turns the failed
// dot pink, and the light band pastels out the same way just above its own cap. Running is blue
// at hue 250, clear of
// identity-colors' blue at 256.6 so a blue host badge and a working dot on the same row do not
// read as related.
const lightStatusDotColors = {
  // L=0.62, chroma 90% of gamut max
  statusDotSuccess: "#299f51",
  statusDotDanger: "#f12e2f",
  statusDotWarning: "#b37824",
  statusDotRunning: "#268ae0",
};

const darkStatusDotColors = {
  // L=0.72, chroma 90% of gamut max
  statusDotSuccess: "#35c264",
  statusDotDanger: "#f7796d",
  statusDotWarning: "#db932e",
  statusDotRunning: "#5caaf6",
};

// Chart series colors — the eight categorical slots a chart assigns to its series, in order.
// Brighter than the status family on purpose: a series is told apart by hue alone across thin
// lines and small swatches, and the status band's 55-60% chroma collapses there. The slot order
// alternates warm and cool so neighbours stay distinct under protanopia and deuteranopia; the
// dark steps are the same eight hues stepped for dark surfaces. Reordering recolors every
// stored chart, and replacing one value needs the whole set checked again for adjacent-pair
// separation.
const lightChartColors = {
  chartSeries: [
    "#2a78d6", // blue
    "#eb6834", // orange
    "#1baf7a", // aqua
    "#eda100", // yellow
    "#e87ba4", // magenta
    "#008300", // green
    "#6250d6", // violet
    "#e34948", // red
  ],
} as const;

const darkChartColors = {
  chartSeries: [
    "#3987e5",
    "#d95926",
    "#199e70",
    "#c98500",
    "#d55181",
    "#008300",
    "#9085e9",
    "#e66767",
  ],
} as const;

export interface LightThemeConfig {
  surface0: string;
  surface1: string;
  surface2: string;
  surface3: string;
  surface4: string;
  surfaceDiffEmpty: string;
  surfaceSidebar: string;
  foreground: string;
  foregroundMuted: string;
  foregroundExtraMuted: string;
  border: string;
  borderAccent: string;
  accent: string;
  accentBright: string;
  accentForeground?: string;
  primary: string;
  primaryForeground: string;
  destructive: string;
  terminalBlack: string;
  terminalBrightBlack: string;
  ring: string;
}

const lightTerminalAnsi = {
  red: "#dc2626",
  green: "#16a34a",
  yellow: "#ca8a04",
  blue: "#2563eb",
  magenta: "#9333ea",
  cyan: "#0891b2",
  white: "#ffffff",
  brightRed: "#ef4444",
  brightGreen: "#22c55e",
  brightYellow: "#f59e0b",
  brightBlue: "#3b82f6",
  brightMagenta: "#a855f7",
  brightCyan: "#06b6d4",
  brightWhite: "#fafafa",
} as const;

export function buildLightSemanticColors(tint: LightThemeConfig) {
  return {
    surface0: tint.surface0,
    surface1: tint.surface1,
    surface2: tint.surface2,
    surface3: tint.surface3,
    surface4: tint.surface4,
    surfaceDiffEmpty: tint.surfaceDiffEmpty,
    surfaceSidebar: tint.surfaceSidebar,
    surfaceSidebarHover: tint.surface3,
    surfaceSidebarSelected: tint.surface4,
    surfaceWorkspace: tint.surface0,
    surfaceWindow: tint.surface0,
    surfaceChrome: tint.surfaceSidebar,
    interactionHighlight: "rgba(0, 0, 0, 0.06)",

    foreground: tint.foreground,
    foregroundMuted: tint.foregroundMuted,
    foregroundExtraMuted: tint.foregroundExtraMuted,

    border: tint.border,
    borderAccent: tint.borderAccent,
    borderWindow: tint.border,

    accent: tint.accent,
    accentBright: tint.accentBright,
    accentForeground: tint.accentForeground ?? tint.surface0,

    destructive: tint.destructive,
    destructiveForeground: tint.surface0,
    success: tint.accent,
    successForeground: tint.surface0,

    background: tint.surface0,
    popover: tint.surface0,
    popoverForeground: tint.foreground,
    primary: tint.primary,
    primaryForeground: tint.primaryForeground,
    secondary: tint.surface2,
    secondaryForeground: tint.foreground,
    muted: tint.surface2,
    mutedForeground: tint.foregroundMuted,
    accentBorder: tint.borderAccent,
    input: tint.surface2,
    ring: tint.ring,

    ...lightDiffColors,
    ...lightStatusColors,
    ...lightStatusTints,
    ...lightStatusDotColors,
    ...lightChartColors,

    terminal: {
      background: tint.surface0,
      foreground: tint.foreground,
      cursor: tint.foreground,
      cursorAccent: tint.surface0,
      selectionBackground: "rgba(0, 0, 0, 0.15)",
      selectionForeground: tint.foreground,
      black: tint.terminalBlack,
      ...lightTerminalAnsi,
      brightBlack: tint.terminalBrightBlack,
    },
  };
}

const lightSemanticColors = buildLightSemanticColors({
  surface0: "#ffffff",
  surface1: "#fafafa",
  surface2: "#f4f4f5",
  surface3: "#e4e4e7",
  surface4: "#d4d4d8",
  surfaceDiffEmpty: "#f6f6f6",
  surfaceSidebar: "#f4f4f5",
  foreground: "#1a1a1e",
  foregroundMuted: "#71717a",
  foregroundExtraMuted: "#a1a1aa",
  border: "#e4e4e7",
  borderAccent: "#ececf1",
  accent: "#20744A",
  accentBright: "#239956",
  accentForeground: "#ffffff",
  primary: "#18181b",
  primaryForeground: "#fafafa",
  destructive: "#b04138",
  terminalBlack: "#1a1a1e",
  terminalBrightBlack: "#3f3f46",
  ring: "#18181b",
});

// ---------------------------------------------------------------------------
// Dark theme variant builder
// ---------------------------------------------------------------------------

export interface DarkThemeConfig {
  surface0: string;
  surface1: string;
  surface2: string;
  surface3: string;
  surface4: string;
  surfaceDiffEmpty: string;
  surfaceSidebar: string;
  foregroundMuted: string;
  foregroundExtraMuted: string;
  border: string;
  borderAccent: string;
  accent: string;
  accentBright: string;
  accentForeground?: string;
  destructive: string;
  destructiveForeground?: string;
  terminalBlack: string;
  terminalBrightBlack: string;
  foreground?: string;
  ring?: string;
}

const darkTerminalAnsi = {
  red: "#e07070",
  green: "#5dba80",
  yellow: "#d4a44a",
  blue: "#6a9de0",
  magenta: "#b07ad0",
  cyan: "#4aabb8",
  white: "#d4d4d8",
  brightRed: "#e89090",
  brightGreen: "#7ecf9a",
  brightYellow: "#e0be6e",
  brightBlue: "#8ab4e8",
  brightMagenta: "#c49ae0",
  brightCyan: "#6ec2cc",
  brightWhite: "#f0f0f2",
} as const;

export function buildDarkSemanticColors(tint: DarkThemeConfig) {
  const foreground = tint.foreground ?? "#fafafa";
  const ring = tint.ring ?? "#d4d4d8";
  return {
    surface0: tint.surface0,
    surface1: tint.surface1,
    surface2: tint.surface2,
    surface3: tint.surface3,
    surface4: tint.surface4,
    surfaceDiffEmpty: tint.surfaceDiffEmpty,
    surfaceSidebar: tint.surfaceSidebar,
    surfaceSidebarHover: tint.surface1,
    surfaceSidebarSelected: tint.surface2,
    surfaceWorkspace: tint.surface1,
    surfaceWindow: tint.surface0,
    surfaceChrome: tint.surfaceSidebar,
    interactionHighlight: "rgba(255, 255, 255, 0.08)",

    foreground,
    foregroundMuted: tint.foregroundMuted,
    foregroundExtraMuted: tint.foregroundExtraMuted,

    border: tint.border,
    borderAccent: tint.borderAccent,
    borderWindow: tint.border,

    accent: tint.accent,
    accentBright: tint.accentBright,
    accentForeground: tint.accentForeground ?? "#ffffff",

    destructive: tint.destructive,
    destructiveForeground: tint.destructiveForeground ?? "#ffffff",
    success: tint.accent,
    successForeground: "#ffffff",

    // Legacy aliases (for gradual migration)
    background: tint.surface0,
    popover: tint.surface2,
    popoverForeground: foreground,
    primary: foreground,
    primaryForeground: tint.surface0,
    secondary: tint.surface2,
    secondaryForeground: foreground,
    muted: tint.surface2,
    mutedForeground: tint.foregroundMuted,
    accentBorder: tint.borderAccent,
    input: tint.surface2,
    ring,

    ...darkDiffColors,
    ...darkStatusColors,
    ...darkStatusTints,
    ...darkStatusDotColors,
    ...darkChartColors,

    terminal: {
      background: tint.surface0,
      foreground,
      cursor: foreground,
      cursorAccent: tint.surface0,
      selectionBackground: "rgba(255, 255, 255, 0.2)",
      selectionForeground: foreground,
      black: tint.terminalBlack,
      ...darkTerminalAnsi,
      brightBlack: tint.terminalBrightBlack,
    },
  };
}

// ---------------------------------------------------------------------------
// Dark tint definitions
// ---------------------------------------------------------------------------

// Pimi — subtle teal-green tint (default)
const pimiDarkColors = buildDarkSemanticColors({
  surface0: "#181B1A",
  surface1: "#1E2120",
  surface2: "#272A29",
  surface3: "#434645",
  surface4: "#595B5B",
  surfaceDiffEmpty: "#252827",
  surfaceSidebar: "#141716",
  foregroundMuted: "#A1A5A4",
  foregroundExtraMuted: "#717574",
  border: "#252B2A",
  borderAccent: "#2F3534",
  accent: "#20744A",
  accentBright: "#7ccba0",
  destructive: "#c64f43", // warm red, hue ~7 — reads as red (not pink) against the green tint
  terminalBlack: "#141716",
  terminalBrightBlack: "#434645",
});

// Zinc — neutral gray, no tint
const zincDarkColors = buildDarkSemanticColors({
  surface0: "#18181b",
  surface1: "#1f1f22",
  surface2: "#27272a",
  surface3: "#3f3f46",
  surface4: "#52525b",
  surfaceDiffEmpty: "#242427",
  surfaceSidebar: "#131316",
  foregroundMuted: "#a1a1aa",
  foregroundExtraMuted: "#71717a",
  border: "#27272a",
  borderAccent: "#303036",
  accent: "#e4e4e7",
  accentBright: "#fafafa",
  accentForeground: "#18181b", // monochrome zinc accent is near-white — needs dark text
  destructive: "#c44a4a", // neutral red, hue 0 — clearly red without screaming
  terminalBlack: "#131316",
  terminalBrightBlack: "#3f3f46",
});

// Midnight — subtle blue tint
const midnightDarkColors = buildDarkSemanticColors({
  surface0: "#161820",
  surface1: "#1c1e27",
  surface2: "#252731",
  surface3: "#3c3e4c",
  surface4: "#535564",
  surfaceDiffEmpty: "#222430",
  surfaceSidebar: "#121420",
  foregroundMuted: "#9a9db0",
  foregroundExtraMuted: "#6b6e82",
  border: "#242636",
  borderAccent: "#2e3040",
  accent: "#3b6fcf",
  accentBright: "#7eaaeb",
  destructive: "#c44a52", // red with a hint of cool lean against the blue tint
  terminalBlack: "#121420",
  terminalBrightBlack: "#3c3e4c",
});

// Claude — warm neutral with subtle orange undertone
const claudeDarkColors = buildDarkSemanticColors({
  surface0: "#1f1f1e",
  surface1: "#262523",
  surface2: "#2f2d2b",
  surface3: "#4a4745",
  surface4: "#605d5b",
  surfaceDiffEmpty: "#2a2826",
  surfaceSidebar: "#1a1918",
  foregroundMuted: "#ada9a5",
  foregroundExtraMuted: "#78746f",
  border: "#2c2a27",
  borderAccent: "#36332f",
  accent: "#d97757",
  accentBright: "#e89a7f",
  destructive: "#cf513e", // warm orange-red, hue ~10 — sits with the Claude orange accent
  terminalBlack: "#1a1918",
  terminalBrightBlack: "#4a4745",
});

// Ghostty — blue-tinted dark based on Ghostty default background
const ghosttyDarkColors = buildDarkSemanticColors({
  surface0: "#282c34",
  surface1: "#2f333d",
  surface2: "#383c48",
  surface3: "#4a4f5e",
  surface4: "#5b6175",
  surfaceDiffEmpty: "#323643",
  surfaceSidebar: "#21252d",
  foregroundMuted: "#c8ccd8",
  foregroundExtraMuted: "#a0a4b2",
  border: "#353a47",
  borderAccent: "#3f4454",
  accent: "#3570e0", // dark enough to carry white text on filled buttons
  accentBright: "#b4d0fc",
  destructive: "#c44a55", // red with slight cool lean against the slate-blue surfaces
  terminalBlack: "#21252d",
  terminalBrightBlack: "#4a4f5e",
});

export const SPACING = {
  0: 0,
  0.5: 2,
  1: 4,
  1.5: 6,
  2: 8,
  3: 12,
  3.5: 14,
  4: 16,
  6: 24,
  7: 28,
  8: 32,
  12: 48,
  16: 64,
  20: 80,
  24: 96,
  32: 128,
} as const;

export const FONT_SIZE = {
  code: 12,
  content: 15,
  sm: 12,
  base: 14,
  lg: 16,
  xl: 18,
  "2xl": 20,
  "3xl": 22,
  "4xl": 26,
} as const;

export const LINE_HEIGHT = {
  diff: 22,
} as const;

export const ICON_SIZE = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 20,
} as const;

export const ICON_STROKE_WIDTH = 1.5;

export const FONT_WEIGHT = {
  normal: "normal" as const,
  medium: "500" as const,
  semibold: "600" as const,
  bold: "bold" as const,
} as const;

export const BORDER_RADIUS = {
  none: 0,
  sm: 2,
  base: 4,
  md: 6,
  lg: 8,
  xl: 12,
  "2xl": 16,
  full: 9999,
} as const;

export const BORDER_WIDTH = {
  0: 0,
  1: 1,
  2: 2,
} as const;

export const OPACITY = {
  0: 0,
  50: 0.5,
  100: 1,
} as const;

// Platform default font stacks — copied verbatim from constants/theme.ts `Fonts`
// (sans -> ui, mono -> mono). These seed the dynamic `fontFamily` theme token and
// are the fallback an empty user-supplied family resolves to at apply time.
export const DEFAULT_UI_FONT_STACK: string = Platform.select({
  ios: "system-ui",
  default: "normal",
  web: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
});

export const DEFAULT_MONO_FONT_STACK: string = Platform.select({
  ios: "ui-monospace",
  default: "monospace",
  web: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
});

// Chat and markdown content column; the appearance updater patches the user's width in.
export const DEFAULT_CONTENT_MAX_WIDTH = 820;

// `fontSize`, `fontFamily`, `lineHeight`, and `contentMaxWidth` are deliberately widened to plain
// `number`/`string` (not narrowed by `as const`) so the appearance updater can patch
// them at runtime via `UnistylesRuntime.updateTheme`. The remaining tokens keep their
// literal types.
interface CommonTheme {
  spacing: typeof SPACING;
  fontSize: Record<keyof typeof FONT_SIZE, number>;
  fontFamily: { ui: string; mono: string };
  lineHeight: Record<keyof typeof LINE_HEIGHT, number>;
  contentMaxWidth: number;
  iconSize: typeof ICON_SIZE;
  fontWeight: typeof FONT_WEIGHT;
  borderRadius: typeof BORDER_RADIUS;
  borderWidth: typeof BORDER_WIDTH;
  opacity: typeof OPACITY;
}

const commonTheme: CommonTheme = {
  spacing: SPACING,
  fontSize: FONT_SIZE,
  fontFamily: { ui: DEFAULT_UI_FONT_STACK, mono: DEFAULT_MONO_FONT_STACK },
  lineHeight: LINE_HEIGHT,
  contentMaxWidth: DEFAULT_CONTENT_MAX_WIDTH,
  iconSize: ICON_SIZE,
  fontWeight: FONT_WEIGHT,
  borderRadius: BORDER_RADIUS,
  borderWidth: BORDER_WIDTH,
  opacity: OPACITY,
};

const darkShadow = {
  sm: {
    shadowColor: "rgba(0, 0, 0, 0.25)",
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 4,
    elevation: 2,
  },
  md: {
    shadowColor: "rgba(0, 0, 0, 0.20)",
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 8,
    elevation: 8,
  },
  lg: {
    shadowColor: "rgba(0, 0, 0, 0.40)",
    shadowOffset: { width: 0, height: 12 },
    shadowRadius: 24,
    elevation: 8,
  },
} as const;

export function buildDarkTheme(semanticColors: ReturnType<typeof buildDarkSemanticColors>) {
  return {
    colorScheme: "dark" as const,
    colors: {
      ...semanticColors,
      palette: baseColors,
      syntax: darkHighlightColors,
    },
    shadow: darkShadow,
    ...commonTheme,
  } as const;
}

export const darkTheme = buildDarkTheme(pimiDarkColors);
export const darkZincTheme = buildDarkTheme(zincDarkColors);
export const darkMidnightTheme = buildDarkTheme(midnightDarkColors);
export const darkClaudeTheme = buildDarkTheme(claudeDarkColors);
export const darkGhosttyTheme = buildDarkTheme(ghosttyDarkColors);

// Pure black — zero-luminance background with high-contrast surfaces.
const pureBlackDarkColors = buildDarkSemanticColors({
  surface0: "#000000",
  surface1: "#0a0a0a",
  surface2: "#111111",
  surface3: "#202020",
  surface4: "#2d2d2d",
  surfaceDiffEmpty: "#0c0c0c",
  surfaceSidebar: "#000000",
  foregroundMuted: "#a1a1aa",
  foregroundExtraMuted: "#71717a",
  border: "#1c1c1c",
  borderAccent: "#242424",
  accent: "#20744A",
  accentBright: "#7ccba0",
  destructive: "#c44a4a",
  terminalBlack: "#595959",
  terminalBrightBlack: "#8a8a8a",
});

export const darkPureBlackTheme = buildDarkTheme(pureBlackDarkColors);

const lightShadow = {
  sm: {
    shadowColor: "rgba(0, 0, 0, 0.08)",
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 8,
    elevation: 2,
  },
  md: {
    shadowColor: "rgba(0, 0, 0, 0.04)",
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 16,
    elevation: 4,
  },
  lg: {
    shadowColor: "rgba(0, 0, 0, 0.08)",
    shadowOffset: { width: 0, height: 8 },
    shadowRadius: 24,
    elevation: 8,
  },
} as const;

export function buildLightTheme(semanticColors: ReturnType<typeof buildLightSemanticColors>) {
  return {
    colorScheme: "light" as const,
    colors: {
      ...semanticColors,
      palette: baseColors,
      syntax: lightHighlightColors,
    },
    shadow: lightShadow,
    ...commonTheme,
  } as const;
}

export const lightTheme = buildLightTheme(lightSemanticColors);

const pimiBlush = buildLightTheme(
  buildLightSemanticColors({
    surface0: "#fffdfc",
    surface1: "#faf6f5",
    surface2: "#f0e8e8",
    surface3: "#eee4e5",
    surface4: "#eddddf",
    surfaceDiffEmpty: "#faf7f6",
    surfaceSidebar: "#f6efef",
    foreground: "#2c2529",
    foregroundMuted: "#695c62",
    foregroundExtraMuted: "#82727a",
    border: "#e8dfe0",
    borderAccent: "#d4c5c7",
    accent: "#382e33",
    accentBright: "#51434a",
    accentForeground: "#fffafc",
    primary: "#382e33",
    primaryForeground: "#fffafc",
    destructive: "#b04138",
    terminalBlack: "#2c2529",
    terminalBrightBlack: "#51434a",
    ring: "#825362",
  }),
);

const pimiDark = buildDarkTheme(
  buildDarkSemanticColors({
    surface0: "#262527",
    surface1: "#29282b",
    surface2: "#2e2c30",
    surface3: "#323034",
    surface4: "#373338",
    surfaceDiffEmpty: "#232224",
    surfaceSidebar: "#242325",
    foreground: "#e9e5e8",
    foregroundMuted: "#b8b0b7",
    foregroundExtraMuted: "#a69da5",
    border: "#302e32",
    borderAccent: "#4d484e",
    accent: "#ccbdc3",
    accentBright: "#ded0d6",
    accentForeground: "#322830",
    destructive: "#d8847b",
    terminalBlack: "#262527",
    terminalBrightBlack: "#4d484e",
    ring: "#e0adb9",
  }),
);

const pimiPaper = buildLightTheme(
  buildLightSemanticColors({
    surface0: "#fffcf4",
    surface1: "#f8f3e8",
    surface2: "#eee5d4",
    surface3: "#eae0ce",
    surface4: "#ebddc5",
    surfaceDiffEmpty: "#f7f2e8",
    surfaceSidebar: "#f0eadc",
    foreground: "#362e23",
    foregroundMuted: "#685b4b",
    foregroundExtraMuted: "#81705b",
    border: "#e0d5c1",
    borderAccent: "#cbbda5",
    accent: "#4e4032",
    accentBright: "#675543",
    accentForeground: "#fffafc",
    primary: "#4e4032",
    primaryForeground: "#fffafc",
    destructive: "#b04138",
    terminalBlack: "#362e23",
    terminalBrightBlack: "#675543",
    ring: "#765638",
  }),
);

const pimiSakura = buildLightTheme(
  buildLightSemanticColors({
    surface0: "#fff9fd",
    surface1: "#fcf1f8",
    surface2: "#f4e6f1",
    surface3: "#eee0ed",
    surface4: "#ecd6e8",
    surfaceDiffEmpty: "#f7edf5",
    surfaceSidebar: "#f4eaf5",
    foreground: "#342538",
    foregroundMuted: "#655268",
    foregroundExtraMuted: "#746277",
    border: "#e8d7e6",
    borderAccent: "#d7bdd2",
    accent: "#713c63",
    accentBright: "#875477",
    accentForeground: "#fff8fc",
    primary: "#713c63",
    primaryForeground: "#fff8fc",
    destructive: "#a33d54",
    terminalBlack: "#342538",
    terminalBrightBlack: "#59465e",
    ring: "#8b4b78",
  }),
);

const pimiCelNight = buildDarkTheme(
  buildDarkSemanticColors({
    surface0: "#1a1d31",
    surface1: "#1f2238",
    surface2: "#252942",
    surface3: "#2c304d",
    surface4: "#343958",
    surfaceDiffEmpty: "#171a2c",
    surfaceSidebar: "#1d2034",
    foreground: "#ecebf8",
    foregroundMuted: "#bbbcd6",
    foregroundExtraMuted: "#a3a8c7",
    border: "#343956",
    borderAccent: "#515675",
    accent: "#c9c0f2",
    accentBright: "#dbd2fb",
    accentForeground: "#262039",
    destructive: "#efa1ac",
    terminalBlack: "#191b2c",
    terminalBrightBlack: "#4b4f6d",
    ring: "#c7b4fb",
  }),
);

const pimiAyuLight = buildLightTheme(
  buildLightSemanticColors({
    surface0: "#fafafa",
    surface1: "#f5f5f5",
    surface2: "#edefef",
    surface3: "#e7e9ec",
    surface4: "#dfe4e9",
    surfaceDiffEmpty: "#f3f4f5",
    surfaceSidebar: "#f1f3f4",
    foreground: "#313842",
    foregroundMuted: "#535d68",
    foregroundExtraMuted: "#58616b",
    border: "#dce0e4",
    borderAccent: "#a6adb5",
    accent: "#925019",
    accentBright: "#7a4012",
    accentForeground: "#ffffff",
    primary: "#925019",
    primaryForeground: "#ffffff",
    destructive: "#b63b36",
    terminalBlack: "#313842",
    terminalBrightBlack: "#646d76",
    ring: "#a05210",
  }),
);

const pimiOneDark = buildDarkTheme(
  buildDarkSemanticColors({
    surface0: "#282c34",
    surface1: "#2c313a",
    surface2: "#303642",
    surface3: "#353c49",
    surface4: "#3b4555",
    surfaceDiffEmpty: "#21252b",
    surfaceSidebar: "#23272f",
    foreground: "#e0e4ed",
    foregroundMuted: "#bac2ce",
    foregroundExtraMuted: "#aeb8c7",
    border: "#363d49",
    borderAccent: "#626e80",
    accent: "#61afef",
    accentBright: "#83c0f1",
    accentForeground: "#202630",
    destructive: "#ed929a",
    destructiveForeground: "#202630",
    terminalBlack: "#6f798b",
    terminalBrightBlack: "#a2abb9",
    ring: "#61afef",
  }),
);

const pimiNord = buildDarkTheme(
  buildDarkSemanticColors({
    surface0: "#2e3440",
    surface1: "#323947",
    surface2: "#373f4f",
    surface3: "#3b4556",
    surface4: "#414c5e",
    surfaceDiffEmpty: "#292f3a",
    surfaceSidebar: "#2b313c",
    foreground: "#eceff4",
    foregroundMuted: "#d3dae6",
    foregroundExtraMuted: "#b9c5d6",
    border: "#414b5c",
    borderAccent: "#6c7c95",
    accent: "#88c0d0",
    accentBright: "#a4d2dd",
    accentForeground: "#273342",
    destructive: "#eb9ca5",
    destructiveForeground: "#273342",
    terminalBlack: "#748299",
    terminalBrightBlack: "#a4b2c8",
    ring: "#88c0d0",
  }),
);

const pimiGruvbox = buildDarkTheme(
  buildDarkSemanticColors({
    surface0: "#282828",
    surface1: "#2e2d2b",
    surface2: "#353230",
    surface3: "#3c3836",
    surface4: "#48413d",
    surfaceDiffEmpty: "#212323",
    surfaceSidebar: "#232524",
    foreground: "#ebdbb2",
    foregroundMuted: "#d5c4a1",
    foregroundExtraMuted: "#c7b694",
    border: "#423c37",
    borderAccent: "#766759",
    accent: "#fabd2f",
    accentBright: "#ffd46c",
    accentForeground: "#32261c",
    destructive: "#fb9288",
    destructiveForeground: "#32261c",
    terminalBlack: "#81766b",
    terminalBrightBlack: "#a89984",
    ring: "#fabd2f",
  }),
);

const pimiCatppuccinMocha = buildDarkTheme(
  buildDarkSemanticColors({
    surface0: "#1e1e2e",
    surface1: "#242437",
    surface2: "#29293e",
    surface3: "#313244",
    surface4: "#3b3d55",
    surfaceDiffEmpty: "#181825",
    surfaceSidebar: "#1b1b2a",
    foreground: "#cdd6f4",
    foregroundMuted: "#bac2de",
    foregroundExtraMuted: "#a6adc8",
    border: "#33354b",
    borderAccent: "#666b89",
    accent: "#cba6f7",
    accentBright: "#dbc1fb",
    accentForeground: "#2c223d",
    destructive: "#f38ba8",
    destructiveForeground: "#2c223d",
    terminalBlack: "#727891",
    terminalBrightBlack: "#a6adc8",
    ring: "#cba6f7",
  }),
);

// Backdrop themes: appearance.css paints one sky (or the live Tide canvas) across the whole window
// shell, on web only. Structural surfaces go clear so it runs unbroken behind the titlebar, sidebar
// and content, and region dividers become a hairline. Native has no backdrop and keeps solid colours.
export function overWindowBackdrop<
  Colors extends { surfaceWindow: string; surfaceChrome: string; borderWindow: string },
>(colors: Colors, hairline: string): Colors {
  if (Platform.OS !== "web") return colors;
  return {
    ...colors,
    surfaceWindow: "transparent",
    surfaceChrome: "transparent",
    borderWindow: hairline,
  };
}

// Status colours are darker than the shared light set because light-theme status text sits on
// the veiled sky, which is darker than surface0 toward the colourful corner.
const skyLightStatusColors = {
  statusSuccess: "#2f5739",
  statusDanger: "#7c332d",
  statusWarning: "#60482b",
  statusMerged: "#5a368a",
};

function buildSkyLightTheme(config: LightThemeConfig, hairline: string) {
  return buildLightTheme(
    overWindowBackdrop(
      {
        ...buildLightSemanticColors(config),
        ...skyLightStatusColors,
        ...statusTints(skyLightStatusColors, "1f"),
      },
      hairline,
    ),
  );
}

function buildBackdropDarkTheme(config: DarkThemeConfig, hairline: string) {
  return buildDarkTheme(overWindowBackdrop(buildDarkSemanticColors(config), hairline));
}

const pimiSkyDay = buildSkyLightTheme(
  {
    surface0: "#f8fcfe",
    surface1: "#f0f7fb",
    surface2: "#e3eef5",
    surface3: "#d9e8f1",
    surface4: "#cddfeb",
    surfaceDiffEmpty: "#eff6fa",
    surfaceSidebar: "#ebf4f9",
    foreground: "#13202f",
    foregroundMuted: "#3a4759",
    foregroundExtraMuted: "#465466",
    border: "#d3e3ed",
    borderAccent: "#aec7d8",
    accent: "#23508f",
    accentBright: "#2a5899",
    accentForeground: "#ffffff",
    primary: "#23508f",
    primaryForeground: "#ffffff",
    destructive: "#9b2f28",
    terminalBlack: "#13202f",
    terminalBrightBlack: "#465466",
    ring: "#2e61aa",
  },
  "#13202f14",
);

const pimiSkyDawn = buildSkyLightTheme(
  {
    surface0: "#fffbf7",
    surface1: "#fbf3ec",
    surface2: "#f4e7de",
    surface3: "#eedfd5",
    surface4: "#e9d3ca",
    surfaceDiffEmpty: "#faf2ec",
    surfaceSidebar: "#f9f0ea",
    foreground: "#2a1c2e",
    foregroundMuted: "#4b3a50",
    foregroundExtraMuted: "#57465b",
    border: "#ead8ce",
    borderAccent: "#d2b6ad",
    accent: "#643f7c",
    accentBright: "#6f4686",
    accentForeground: "#fffaf6",
    primary: "#643f7c",
    primaryForeground: "#fffaf6",
    destructive: "#9c2a3a",
    terminalBlack: "#2a1c2e",
    terminalBrightBlack: "#57465b",
    ring: "#88558d",
  },
  "#2a1c2e14",
);

const pimiSkyDusk = buildBackdropDarkTheme(
  {
    surface0: "#150a07",
    surface1: "#1c0f0b",
    surface2: "#25150f",
    surface3: "#2e1b13",
    surface4: "#392218",
    surfaceDiffEmpty: "#0f0705",
    surfaceSidebar: "#110806",
    foreground: "#f7ece1",
    foregroundMuted: "#d3c0af",
    foregroundExtraMuted: "#c2ad9c",
    border: "#372218",
    borderAccent: "#644636",
    accent: "#efbf72",
    accentBright: "#f6d49b",
    accentForeground: "#2b1907",
    destructive: "#f39a8d",
    destructiveForeground: "#2b1907",
    terminalBlack: "#8a7566",
    terminalBrightBlack: "#c2ad9c",
    ring: "#e9a04a",
  },
  "#f7ece112",
);

const pimiSkyNight = buildBackdropDarkTheme(
  {
    surface0: "#09090d",
    surface1: "#0f0f16",
    surface2: "#161620",
    surface3: "#1d1d2b",
    surface4: "#262538",
    surfaceDiffEmpty: "#050508",
    surfaceSidebar: "#07070a",
    foreground: "#ededf5",
    foregroundMuted: "#c0bfd3",
    foregroundExtraMuted: "#adacc3",
    border: "#242334",
    borderAccent: "#48465f",
    accent: "#bda8e8",
    accentBright: "#d1c1f3",
    accentForeground: "#1d1631",
    destructive: "#f29dab",
    destructiveForeground: "#1d1631",
    terminalBlack: "#7b7991",
    terminalBrightBlack: "#adacc3",
    ring: "#a88fe0",
  },
  "#ededf512",
);

const pimiTide = buildBackdropDarkTheme(
  {
    surface0: "#071318",
    surface1: "#0b1a20",
    surface2: "#11232a",
    surface3: "#172c34",
    surface4: "#1f3740",
    surfaceDiffEmpty: "#050e12",
    surfaceSidebar: "#061014",
    foreground: "#e8f3f4",
    foregroundMuted: "#b7cdd1",
    foregroundExtraMuted: "#a3bbc0",
    border: "#1d343c",
    borderAccent: "#3f5d66",
    accent: "#7fd6d0",
    accentBright: "#a5e6e0",
    accentForeground: "#062226",
    destructive: "#f29a90",
    destructiveForeground: "#062226",
    terminalBlack: "#6b858b",
    terminalBrightBlack: "#a3bbc0",
    ring: "#5cc4c0",
  },
  "#e8f3f412",
);

export const SKY_THEME_OPTIONS = [
  {
    name: "sky-day",
    group: "variant",
    unistylesName: "pimiSkyDay",
    theme: pimiSkyDay,
    swatch: "#23508f",
  },
  {
    name: "sky-dusk",
    group: "variant",
    unistylesName: "pimiSkyDusk",
    theme: pimiSkyDusk,
    swatch: "#efbf72",
  },
  {
    name: "sky-night",
    group: "variant",
    unistylesName: "pimiSkyNight",
    theme: pimiSkyNight,
    swatch: "#bda8e8",
  },
  {
    name: "sky-dawn",
    group: "variant",
    unistylesName: "pimiSkyDawn",
    theme: pimiSkyDawn,
    swatch: "#643f7c",
  },
  { name: "tide", group: "variant", unistylesName: "pimiTide", theme: pimiTide, swatch: "#7fd6d0" },
] as const;

export const COMMUNITY_THEME_OPTIONS = [
  {
    name: "ayu-light",
    label: "Ayu Light",
    group: "variant",
    unistylesName: "pimiAyuLight",
    theme: pimiAyuLight,
    swatch: "#925019",
  },
  {
    name: "one-dark",
    label: "One Dark Pro",
    group: "variant",
    unistylesName: "pimiOneDark",
    theme: pimiOneDark,
    swatch: "#61afef",
  },
  {
    name: "nord",
    label: "Nord",
    group: "variant",
    unistylesName: "pimiNord",
    theme: pimiNord,
    swatch: "#88c0d0",
  },
  {
    name: "gruvbox",
    label: "Gruvbox Dark",
    group: "variant",
    unistylesName: "pimiGruvbox",
    theme: pimiGruvbox,
    swatch: "#fabd2f",
  },
  {
    name: "catppuccin-mocha",
    label: "Catppuccin Mocha",
    group: "variant",
    unistylesName: "pimiCatppuccinMocha",
    theme: pimiCatppuccinMocha,
    swatch: "#cba6f7",
  },
] as const;

export const PIMI_APPEARANCE_THEMES = {
  light: "pimiBlush",
  dark: "pimiDark",
  paper: "pimiPaper",
  sakura: "pimiSakura",
  "cel-night": "pimiCelNight",
  "ayu-light": "pimiAyuLight",
  "one-dark": "pimiOneDark",
  nord: "pimiNord",
  gruvbox: "pimiGruvbox",
  "catppuccin-mocha": "pimiCatppuccinMocha",
  "sky-day": "pimiSkyDay",
  "sky-dusk": "pimiSkyDusk",
  "sky-night": "pimiSkyNight",
  "sky-dawn": "pimiSkyDawn",
  tide: "pimiTide",
} as const;

// Keep compatibility with existing code
export const theme = darkTheme;

export const THEME_OPTIONS = [
  {
    name: "light",
    group: "primary",
    unistylesName: "light",
    theme: lightTheme,
    swatch: "#ffffff",
  },
  {
    name: "dark",
    group: "primary",
    unistylesName: "dark",
    theme: darkTheme,
    swatch: "#2D8B62",
  },
  { name: "auto", group: "primary" },
  {
    name: "zinc",
    group: "variant",
    unistylesName: "darkZinc",
    theme: darkZincTheme,
    swatch: "#808080",
  },
  {
    name: "midnight",
    group: "variant",
    unistylesName: "darkMidnight",
    theme: darkMidnightTheme,
    swatch: "#4A6BA8",
  },
  {
    name: "claude",
    group: "variant",
    unistylesName: "darkClaude",
    theme: darkClaudeTheme,
    swatch: "#D97757",
  },
  {
    name: "ghostty",
    group: "variant",
    unistylesName: "darkGhostty",
    theme: darkGhosttyTheme,
    swatch: "#8caaee",
  },
  {
    name: "pureBlack",
    group: "variant",
    unistylesName: "darkPureBlack",
    theme: darkPureBlackTheme,
    swatch: "#000000",
  },
  ...COMMUNITY_THEME_OPTIONS,
  ...SKY_THEME_OPTIONS,
] as const;

export const PLUGIN_THEME_PREFERENCE = "plugin";
export const PLUGIN_THEME_NAMES = {
  light: "pluginLight",
  dark: "pluginDark",
} as const;

export type ThemePreference =
  | (typeof THEME_OPTIONS)[number]["name"]
  | typeof PLUGIN_THEME_PREFERENCE;
export type ThemeName = Exclude<ThemePreference, "auto" | typeof PLUGIN_THEME_PREFERENCE>;
type ConcreteThemeOption = Exclude<(typeof THEME_OPTIONS)[number], { name: "auto" }>;
export type Theme = ConcreteThemeOption["theme"];

const CONCRETE_THEME_OPTIONS = THEME_OPTIONS.filter(
  (option): option is ConcreteThemeOption => option.name !== "auto",
);

type ThemeToUnistyles = {
  [Name in ThemeName]: Extract<ConcreteThemeOption, { name: Name }>["unistylesName"];
};

type ThemeSwatches = {
  [Name in ThemeName]: Extract<ConcreteThemeOption, { name: Name }>["swatch"];
};

type RegisteredThemes = {
  [Option in ConcreteThemeOption as Option["unistylesName"]]: Option["theme"];
} & {
  pluginLight: typeof lightTheme;
  pluginDark: typeof darkTheme;
  pimiBlush: typeof pimiBlush;
  pimiDark: typeof pimiDark;
  pimiPaper: typeof pimiPaper;
  pimiSakura: typeof pimiSakura;
  pimiCelNight: typeof pimiCelNight;
};

export const THEME_TO_UNISTYLES = Object.fromEntries(
  CONCRETE_THEME_OPTIONS.map((option) => [option.name, option.unistylesName]),
) as ThemeToUnistyles;

export const THEME_SWATCHES = Object.fromEntries(
  CONCRETE_THEME_OPTIONS.map((option) => [option.name, option.swatch]),
) as ThemeSwatches;

export const REGISTERED_THEMES = {
  ...Object.fromEntries(
    CONCRETE_THEME_OPTIONS.map((option) => [option.unistylesName, option.theme]),
  ),
  [PLUGIN_THEME_NAMES.light]: lightTheme,
  [PLUGIN_THEME_NAMES.dark]: darkTheme,
  pimiBlush,
  pimiDark,
  pimiPaper,
  pimiSakura,
  pimiCelNight,
} as RegisteredThemes;
