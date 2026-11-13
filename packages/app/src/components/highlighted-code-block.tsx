import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  View,
  Text,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import * as Clipboard from "expo-clipboard";
import { Check, Copy } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { isNative, isWeb } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { syntaxTokenStyleFor } from "@/styles/syntax-token-styles";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { highlightToKeyedLines, type KeyedLine } from "@/utils/highlight-cache";
import {
  markdownCopyCodeBlockDataSet,
  markdownCopyDataSet,
  TRAILING_CODE_LINE_BREAKS,
} from "@/assistant-selection-copy/markup";

interface HighlightedCodeBlockProps {
  code: string;
  language: string | null | undefined;
  inheritedStyles: TextStyle;
  textStyle: TextStyle;
  /** The fence may still be growing: large code stays plain until the reply stops streaming. */
  streaming?: boolean;
}

// Highlighting re-tokenizes the whole fence, so a growing block above this size would pay for it
// on every frame. It is highlighted once, when it stops growing.
const MAX_STREAMING_HIGHLIGHT_CHARS = 600;

// Fence info strings ("```ts", "```typescript", "```ts {1,3}") map to the
// extension-based parser table in @pimi/highlight. Aliases here only
// cover names that don't already match an extension key in parsers.ts.
const LANGUAGE_ALIASES: Record<string, string> = {
  typescript: "ts",
  javascript: "js",
  python: "py",
  rust: "rs",
  golang: "go",
  "c++": "cpp",
  csharp: "cs",
  "c#": "cs",
  objc: "m",
  "objective-c": "m",
  markdown: "md",
  elixir: "ex",
};

function fenceLanguageToExtension(info: string | null | undefined): string | null {
  if (!info) return null;
  const first = info.trim().split(/\s+/)[0]?.toLowerCase();
  if (!first) return null;
  const normalized = first.replace(/^\./, "");
  return LANGUAGE_ALIASES[normalized] ?? normalized;
}

function stripTerminalFenceNewline(code: string): string {
  return code.endsWith("\n") ? code.slice(0, -1) : code;
}

export const HighlightedCodeBlock = React.memo(function HighlightedCodeBlock({
  code,
  language,
  inheritedStyles,
  textStyle,
  streaming = false,
}: HighlightedCodeBlockProps) {
  // Box styles (bg / padding / border / radius / margin) go on the wrapper View
  // so the absolute copy button positions relative to the visible code area,
  // not to a parent that includes the Text's own marginVertical.
  const { containerStyle, innerTextStyle } = useMemo(
    () => splitFenceStyle(inheritedStyles, textStyle),
    [inheritedStyles, textStyle],
  );
  const renderedCode = useMemo(() => stripTerminalFenceNewline(code), [code]);
  const copyDataSet = useMemo(
    () => ({ ...CODE_SURFACE_DATASET, ...markdownCopyCodeBlockDataSet(language) }),
    [language],
  );

  const deferHighlight = streaming && renderedCode.length > MAX_STREAMING_HIGHLIGHT_CHARS;
  const keyedLines = useMemo<KeyedLine[] | null>(
    () =>
      deferHighlight
        ? null
        : highlightToKeyedLines(renderedCode, fenceLanguageToExtension(language)),
    [renderedCode, language, deferHighlight],
  );

  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const controlsVisible = isHovered || isNative || isCompact;
  // Copy the code without its trailing blank lines. A fence body ends in a newline,
  // and ends in more than one when the author left a blank line before the closing
  // fence; pasting any of them into a terminal runs the last line.
  const getCode = useCallback(() => code.replace(TRAILING_CODE_LINE_BREAKS, ""), [code]);

  return (
    <View
      style={containerStyle}
      dataSet={copyDataSet}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      {keyedLines ? (
        <Text style={innerTextStyle} dataSet={markdownCopyDataSet.code}>
          {renderCodeLines(keyedLines)}
        </Text>
      ) : (
        <Text style={innerTextStyle} dataSet={markdownCopyDataSet.code}>
          {renderedCode}
        </Text>
      )}
      <CopyButton getCode={getCode} visible={controlsVisible} />
    </View>
  );
});

function renderCodeLines(keyedLines: KeyedLine[]): React.ReactNode[] {
  return keyedLines.map((line, index) => (
    <CodeLine key={line.key} line={line} leadingNewline={index > 0} />
  ));
}

interface CodeLineProps {
  line: KeyedLine;
  leadingNewline: boolean;
}

// Tokens are fresh objects on every tokenization, so a line is compared by what it draws. While
// a fence grows, only the lines that changed render again.
function codeLinesEqual(a: CodeLineProps, b: CodeLineProps): boolean {
  if (a.leadingNewline !== b.leadingNewline) return false;
  const left = a.line.tokens;
  const right = b.line.tokens;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index].token.text !== right[index].token.text) return false;
    if (left[index].token.style !== right[index].token.style) return false;
  }
  return true;
}

const CodeLine = React.memo(function CodeLine({ line, leadingNewline }: CodeLineProps) {
  return (
    <>
      {leadingNewline ? <Text>{"\n"}</Text> : null}
      {line.tokens.map(({ key, token }) => (
        <Text key={key} style={token.style ? syntaxTokenStyleFor(token.style) : undefined}>
          {token.text}
        </Text>
      ))}
    </>
  );
}, codeLinesEqual);

interface SplitStyles {
  containerStyle: StyleProp<ViewStyle>;
  innerTextStyle: StyleProp<TextStyle>;
}

const CONTAINER_BASE: ViewStyle = { position: "relative" };
const WEB_SELECTABLE: TextStyle = isWeb ? ({ userSelect: "text" } as TextStyle) : {};

function splitFenceStyle(inheritedStyles: TextStyle, textStyle: TextStyle): SplitStyles {
  const { fontFamily, fontSize, color, ...box } = textStyle;
  const textOnly: TextStyle = { ...WEB_SELECTABLE };
  if (fontFamily !== undefined) textOnly.fontFamily = fontFamily;
  if (fontSize !== undefined) textOnly.fontSize = fontSize;
  if (fontSize !== undefined) textOnly.lineHeight = Math.round(fontSize * 1.45);
  if (color !== undefined) textOnly.color = color;
  return {
    containerStyle: [box as ViewStyle, CONTAINER_BASE],
    innerTextStyle: [inheritedStyles, textOnly],
  };
}

interface CopyButtonProps {
  getCode: () => string;
  visible: boolean;
}

const COPIED_RESET_MS = 1500;

const CopyButton = React.memo(function CopyButton({ getCode, visible }: CopyButtonProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const resetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetRef.current) clearTimeout(resetRef.current);
    },
    [],
  );

  const handlePress = useCallback(async () => {
    const content = getCode();
    if (!content) return;
    await Clipboard.setStringAsync(content);
    setCopied(true);
    if (resetRef.current) clearTimeout(resetRef.current);
    resetRef.current = setTimeout(() => {
      setCopied(false);
      resetRef.current = null;
    }, COPIED_RESET_MS);
  }, [getCode]);

  const visibilityStyle = visible
    ? copyButtonStyles.containerVisible
    : copyButtonStyles.containerHidden;
  const wrapperStyle = useMemo(
    () => [copyButtonStyles.container, visibilityStyle],
    [visibilityStyle],
  );

  return (
    <Pressable
      onPress={handlePress}
      style={wrapperStyle}
      pointerEvents={visible ? "auto" : "none"}
      accessibilityRole="button"
      accessibilityLabel={copied ? t("message.actions.copied") : t("message.actions.copyCode")}
      hitSlop={8}
      dataSet={markdownCopyDataSet.ignore}
    >
      {({ hovered }) => {
        const iconColor = hovered
          ? copyButtonStyles.iconHoveredColor.color
          : copyButtonStyles.iconColor.color;
        return copied ? (
          <Check size={14} color={iconColor} />
        ) : (
          <Copy size={14} color={iconColor} />
        );
      }}
    </Pressable>
  );
});

const copyButtonStyles = StyleSheet.create((theme) => ({
  container: {
    position: "absolute",
    top: theme.spacing[2],
    right: theme.spacing[2],
    padding: theme.spacing[1],
  },
  containerVisible: {
    opacity: 1,
  },
  containerHidden: {
    opacity: 0,
  },
  iconColor: {
    color: theme.colors.foregroundMuted,
  },
  iconHoveredColor: {
    color: theme.colors.foreground,
  },
}));
