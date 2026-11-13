import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  View,
  Text,
  ScrollView as RNScrollView,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { ScrollView as GHScrollView } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import type { TFunction } from "i18next";
import { useTranslation } from "@/i18n/use-translation";
import type { ToolCallDetail } from "@pimi/protocol/agent-types";
import {
  buildPimiToolDetailSections,
  type PimiToolDetailSection,
} from "@pimi/protocol/pimi-tool-presentation/index";
import { buildLineDiff, parseUnifiedDiff, type DiffLine } from "@/utils/tool-call-parsers";
import { highlightDiffLines } from "@/utils/diff-highlight";
import { hasMeaningfulToolCallDetail } from "@/utils/tool-call-detail-state";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { extensionFromPath, highlightToKeyedLines } from "@/utils/highlight-cache";
import { HighlightedLines } from "./highlighted-content";
import { DiffViewer } from "./diff-viewer";
import { getCodeInsets } from "./code-insets";
import { isWeb } from "@/constants/platform";

const ScrollView = isWeb ? RNScrollView : GHScrollView;

// ---- Content Component ----

interface ToolCallDetailsContentProps {
  toolName?: string;
  detail?: ToolCallDetail;
  errorText?: string;
  maxHeight?: number;
  fillAvailableHeight?: boolean;
  showLoadingSkeleton?: boolean;
  /** The detail is a preview of a longer body; "loading" and "error" show a line below it. */
  bodyStatus?: "ready" | "loading" | "error";
  onRetryBody?: () => void;
}

interface DetailStyles {
  sectionFillStyle: StyleProp<ViewStyle>;
  surfaceFillStyle: StyleProp<ViewStyle>;
  codeVerticalScrollStyle: StyleProp<ViewStyle>;
  scrollAreaFillStyle: StyleProp<ViewStyle>;
  scrollAreaStyle: StyleProp<ViewStyle>;
  fullBleedContainerStyle: StyleProp<ViewStyle>;
  loadingContainerStyle: StyleProp<ViewStyle>;
  resolvedMaxHeight: number | undefined;
  shouldFill: boolean;
}

function resolveShouldFill(
  detail: ToolCallDetail | undefined,
  fillAvailableHeight: boolean,
): boolean {
  if (!fillAvailableHeight) return false;
  const t = detail?.type;
  return t === "shell" || t === "edit" || t === "write" || t === "read";
}

function useDetailStyles(
  detail: ToolCallDetail | undefined,
  resolvedMaxHeight: number | undefined,
  fillAvailableHeight: boolean,
): DetailStyles {
  const shouldFill = resolveShouldFill(detail, fillAvailableHeight);
  const sectionFillStyle = useMemo(
    () => [styles.section, shouldFill && styles.fillHeight],
    [shouldFill],
  );
  const surfaceFillStyle = useMemo(
    () => [styles.codeSurface, shouldFill && styles.fillHeight],
    [shouldFill],
  );
  const codeVerticalScrollStyle = useMemo(
    () => [
      styles.codeVerticalScroll,
      resolvedMaxHeight !== undefined && inlineUnistylesStyle({ maxHeight: resolvedMaxHeight }),
      shouldFill && styles.fillHeight,
    ],
    [resolvedMaxHeight, shouldFill],
  );
  const scrollAreaFillStyle = useMemo(
    () => [
      styles.scrollArea,
      resolvedMaxHeight !== undefined && inlineUnistylesStyle({ maxHeight: resolvedMaxHeight }),
      shouldFill && styles.fillHeight,
    ],
    [resolvedMaxHeight, shouldFill],
  );
  const scrollAreaStyle = useMemo(
    () => [
      styles.scrollArea,
      resolvedMaxHeight !== undefined && inlineUnistylesStyle({ maxHeight: resolvedMaxHeight }),
    ],
    [resolvedMaxHeight],
  );
  const fullBleedContainerStyle = useMemo(
    () => [styles.container, shouldFill && styles.fillHeight],
    [shouldFill],
  );
  const loadingContainerStyle = useMemo(
    () => [styles.loadingContainer, fillAvailableHeight && styles.fillHeight],
    [fillAvailableHeight],
  );

  return {
    sectionFillStyle,
    surfaceFillStyle,
    codeVerticalScrollStyle,
    scrollAreaFillStyle,
    scrollAreaStyle,
    fullBleedContainerStyle,
    loadingContainerStyle,
    resolvedMaxHeight,
    shouldFill,
  };
}

function useDiffLines(detail: ToolCallDetail | undefined): DiffLine[] | undefined {
  return useMemo(() => {
    if (!detail || detail.type !== "edit") return undefined;
    const diffLines = detail.unifiedDiff
      ? parseUnifiedDiff(detail.unifiedDiff)
      : buildLineDiff(detail.oldString ?? "", detail.newString ?? "");
    return highlightDiffLines(diffLines, detail.filePath);
  }, [detail]);
}

// The one surface every code-like detail sits on: no border, no nested boxes.
function CodeSurface({ ds, children }: { ds: DetailStyles; children: ReactNode }) {
  return <View style={ds.surfaceFillStyle}>{children}</View>;
}

interface ShellDetailProps {
  command: string;
  output: string | null | undefined;
  ds: DetailStyles;
}

function ShellDetailSection({ command, output, ds }: ShellDetailProps) {
  const normalizedCommand = command.replace(/\n+$/, "");
  const commandOutput = (output ?? "").replace(/^\n+/, "");
  const hasOutput = commandOutput.length > 0;
  return (
    <CodeSurface ds={ds}>
      <ScrollView
        style={ds.codeVerticalScrollStyle}
        contentContainerStyle={styles.codeVerticalContent}
        nestedScrollEnabled
        showsVerticalScrollIndicator
      >
        <ScrollView
          horizontal
          nestedScrollEnabled
          showsHorizontalScrollIndicator
          contentContainerStyle={styles.codeHorizontalContent}
        >
          <View style={styles.codeLine} dataSet={CODE_SURFACE_DATASET}>
            <Text selectable style={styles.scrollText}>
              <Text style={styles.shellPrompt}>$ </Text>
              {normalizedCommand}
              {hasOutput ? `\n\n${commandOutput}` : ""}
            </Text>
          </View>
        </ScrollView>
      </ScrollView>
    </CodeSurface>
  );
}

interface EditDetailProps {
  diffLines: DiffLine[] | undefined;
  ds: DetailStyles;
}

function EditDetailSection({ diffLines, ds }: EditDetailProps) {
  return (
    <CodeSurface ds={ds}>
      {diffLines ? (
        <DiffViewer
          diffLines={diffLines}
          maxHeight={ds.resolvedMaxHeight}
          fillAvailableHeight={ds.shouldFill}
        />
      ) : null}
    </CodeSurface>
  );
}

interface ScrollableContentProps {
  content: string;
  ds: DetailStyles;
  // Drives syntax highlighting (extension only) and, with startLine, a gutter.
  filePath?: string | null;
  startLine?: number;
}

function ScrollableTextSection({ content, ds, filePath, startLine }: ScrollableContentProps) {
  const keyedLines = useMemo(
    () => (filePath ? highlightToKeyedLines(content, extensionFromPath(filePath)) : null),
    [content, filePath],
  );
  const body = (
    <ScrollView
      style={ds.scrollAreaFillStyle}
      contentContainerStyle={styles.scrollContent}
      nestedScrollEnabled
      showsVerticalScrollIndicator={true}
    >
      <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={true}>
        {keyedLines ? (
          <HighlightedLines lines={keyedLines} startLine={startLine} />
        ) : (
          <Text selectable style={styles.scrollText} dataSet={CODE_SURFACE_DATASET}>
            {content}
          </Text>
        )}
      </ScrollView>
    </ScrollView>
  );
  return <CodeSurface ds={ds}>{body}</CodeSurface>;
}

interface FetchDetailProps {
  url: string;
  result: string | null | undefined;
  ds: DetailStyles;
}

function FetchDetailSection({ url, result, ds }: FetchDetailProps) {
  return (
    <CodeSurface ds={ds}>
      <ScrollView
        style={ds.scrollAreaFillStyle}
        contentContainerStyle={styles.scrollContent}
        nestedScrollEnabled
        showsVerticalScrollIndicator
      >
        <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator>
          <Text selectable style={styles.scrollText} dataSet={CODE_SURFACE_DATASET}>
            {result ? `${url}\n\n${result}` : url}
          </Text>
        </ScrollView>
      </ScrollView>
    </CodeSurface>
  );
}

// Prose (thinking text, plain tool output): no surface.
function ScrollablePlainTextSection({ text, ds }: { text: string; ds: DetailStyles }) {
  return (
    <View style={styles.section}>
      <ScrollView style={ds.scrollAreaStyle} nestedScrollEnabled showsVerticalScrollIndicator>
        <Text selectable style={styles.plainText}>
          {text}
        </Text>
      </ScrollView>
    </View>
  );
}

interface SearchDetail {
  query?: string;
  content?: string;
  filePaths?: string[];
  webResults?: { title: string; url: string }[];
  annotations?: string[];
}

function buildSearchSections(detail: SearchDetail, ds: DetailStyles): ReactNode[] {
  const blocks: ReactNode[] = [];
  if (detail.content) {
    blocks.push(
      <ScrollView
        key="search-content"
        style={ds.scrollAreaStyle}
        contentContainerStyle={styles.scrollContent}
        nestedScrollEnabled
        showsVerticalScrollIndicator
      >
        <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator>
          <Text selectable style={styles.scrollText} dataSet={CODE_SURFACE_DATASET}>
            {detail.content}
          </Text>
        </ScrollView>
      </ScrollView>,
    );
  }
  const textBlocks: { key: string; text: string }[] = [];
  if (detail.filePaths && detail.filePaths.length > 0) {
    textBlocks.push({ key: "search-files", text: detail.filePaths.join("\n") });
  }
  if (detail.webResults && detail.webResults.length > 0) {
    textBlocks.push({
      key: "search-web-results",
      text: detail.webResults.map((entry) => `${entry.title}\n${entry.url}`).join("\n\n"),
    });
  }
  if (detail.annotations && detail.annotations.length > 0) {
    textBlocks.push({ key: "search-annotations", text: detail.annotations.join("\n\n") });
  }
  for (const block of textBlocks) {
    blocks.push(
      <View key={block.key} style={styles.scrollContent}>
        <Text selectable style={styles.scrollText} dataSet={CODE_SURFACE_DATASET}>
          {block.text}
        </Text>
      </View>,
    );
  }
  if (blocks.length === 0) return [];
  return [
    <CodeSurface key="search" ds={ds}>
      {blocks}
    </CodeSurface>,
  ];
}

function serializeUnknownValue(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

interface UnknownDetail {
  input: unknown;
  output: unknown;
}

function buildUnknownSections(detail: UnknownDetail, ds: DetailStyles, t: TFunction): ReactNode[] {
  const plainInputText =
    typeof detail.input === "string" && detail.output === null ? detail.input : null;

  if (plainInputText !== null) {
    return [<ScrollablePlainTextSection key="unknown-plain-text" text={plainInputText} ds={ds} />];
  }

  const sectionsFromTopLevel = [
    { title: t("toolCallDetails.input"), value: detail.input },
    { title: t("toolCallDetails.output"), value: detail.output },
  ].filter((entry) =>
    hasMeaningfulToolCallDetail({
      type: "unknown",
      input: entry.value ?? null,
      output: null,
    }),
  );

  const out: ReactNode[] = [];
  for (const section of sectionsFromTopLevel) {
    const value = serializeUnknownValue(section.value);
    if (!value.length) {
      continue;
    }
    out.push(
      <View key={section.title} style={styles.labeledSection}>
        <Text style={styles.sectionLabel}>{section.title}</Text>
        <CodeSurface ds={ds}>
          <ScrollView
            horizontal
            nestedScrollEnabled
            contentContainerStyle={styles.scrollContent}
            showsHorizontalScrollIndicator={true}
          >
            <Text selectable style={styles.scrollText} dataSet={CODE_SURFACE_DATASET}>
              {value}
            </Text>
          </ScrollView>
        </CodeSurface>
      </View>,
    );
  }
  return out;
}

function PimiDetailSection({ section }: { section: PimiToolDetailSection }) {
  return (
    <View style={styles.pimiSection}>
      <Text style={styles.pimiSectionTitle}>{section.title}</Text>
      {section.kind === "prose" ? (
        <Text selectable style={styles.pimiProse}>
          {section.text}
        </Text>
      ) : (
        <View style={styles.pimiFields}>
          {section.fields.map((field) => (
            <View key={field.label} style={styles.pimiFieldRow}>
              <Text style={styles.pimiFieldLabel}>{field.label}</Text>
              <Text selectable style={styles.pimiFieldValue}>
                {field.value}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function buildPimiUnknownSections(
  toolName: string | undefined,
  detail: UnknownDetail,
): ReactNode[] | null {
  if (!toolName) return null;
  const sections = buildPimiToolDetailSections(toolName, detail.input, detail.output);
  if (!sections) return null;
  return sections.map((section) => <PimiDetailSection key={section.title} section={section} />);
}

function buildDetailSections(
  toolName: string | undefined,
  detail: ToolCallDetail | undefined,
  diffLines: DiffLine[] | undefined,
  ds: DetailStyles,
  t: TFunction,
): ReactNode[] {
  if (!detail) return [];
  if (detail.type === "shell") {
    return [
      <ShellDetailSection key="shell" command={detail.command} output={detail.output} ds={ds} />,
    ];
  }
  if (detail.type === "worktree_setup" || detail.type === "sub_agent") return [];
  if (detail.type === "edit") {
    return [<EditDetailSection key="edit" diffLines={diffLines} ds={ds} />];
  }
  if (detail.type === "write") {
    if (!detail.content) return [];
    return [
      <ScrollableTextSection
        key="write"
        content={detail.content}
        ds={ds}
        filePath={detail.filePath}
      />,
    ];
  }
  if (detail.type === "read") {
    if (!detail.content) return [];
    return [
      <ScrollableTextSection
        key="read"
        content={detail.content}
        ds={ds}
        filePath={detail.filePath}
        startLine={detail.offset ?? 1}
      />,
    ];
  }
  if (detail.type === "search") {
    return buildSearchSections(detail, ds);
  }
  if (detail.type === "fetch") {
    return [<FetchDetailSection key="fetch" url={detail.url} result={detail.result} ds={ds} />];
  }
  if (detail.type === "plain_text") {
    if (!detail.text) return [];
    return [<ScrollablePlainTextSection key="plain-text" text={detail.text} ds={ds} />];
  }
  if (detail.type === "unknown") {
    return buildPimiUnknownSections(toolName, detail) ?? buildUnknownSections(detail, ds, t);
  }
  return [];
}

function ErrorSection({ errorText, ds }: { errorText: string; ds: DetailStyles }) {
  return (
    <CodeSurface ds={ds}>
      <ScrollView
        horizontal
        nestedScrollEnabled
        contentContainerStyle={styles.scrollContent}
        showsHorizontalScrollIndicator={true}
      >
        <Text
          selectable
          style={[styles.scrollText, styles.errorText]}
          dataSet={CODE_SURFACE_DATASET}
        >
          {errorText}
        </Text>
      </ScrollView>
    </CodeSurface>
  );
}

function LoadingSkeleton({ containerStyle }: { containerStyle: StyleProp<ViewStyle> }) {
  return (
    <View style={containerStyle}>
      <View style={styles.loadingLineWide} />
      <View style={styles.loadingLineMedium} />
      <View style={styles.loadingLineShort} />
    </View>
  );
}

export function ToolCallDetailsContent({
  toolName,
  detail,
  errorText,
  maxHeight,
  fillAvailableHeight = false,
  showLoadingSkeleton = false,
  bodyStatus = "ready",
  onRetryBody,
}: ToolCallDetailsContentProps) {
  const { t } = useTranslation();
  const resolvedMaxHeight = fillAvailableHeight ? undefined : (maxHeight ?? 300);
  const ds = useDetailStyles(detail, resolvedMaxHeight, fillAvailableHeight);
  const diffLines = useDiffLines(detail);

  const sections: ReactNode[] = buildDetailSections(toolName, detail, diffLines, ds, t);

  if (errorText) {
    sections.push(<ErrorSection key="error" errorText={errorText} ds={ds} />);
  }

  if (sections.length === 0) {
    if (showLoadingSkeleton) {
      return <LoadingSkeleton containerStyle={ds.loadingContainerStyle} />;
    }
    return <Text style={styles.emptyStateText}>{t("toolCallDetails.empty")}</Text>;
  }

  return (
    <View style={ds.fullBleedContainerStyle}>
      {sections}
      <BodyStatusPill status={bodyStatus} onRetry={onRetryBody} />
    </View>
  );
}

const LOADING_INDICATOR_DELAY_MS = 150;

// Floats over the preview so loading and failure never change the row's height. The loading
// label waits so a fast fetch never flashes it.
function BodyStatusPill({
  status,
  onRetry,
}: {
  status: "ready" | "loading" | "error";
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  const [delayElapsed, setDelayElapsed] = useState(false);
  useEffect(() => {
    if (status !== "loading") {
      setDelayElapsed(false);
      return undefined;
    }
    const timer = setTimeout(() => setDelayElapsed(true), LOADING_INDICATOR_DELAY_MS);
    return () => clearTimeout(timer);
  }, [status]);
  if (status === "ready" || (status === "loading" && !delayElapsed)) return null;
  return (
    <View style={styles.bodyStatusPill} testID="tool-call-body-status" pointerEvents="box-none">
      <Text style={[styles.bodyStatusText, status === "error" && styles.errorText]}>
        {status === "loading" ? t("toolCallDetails.loadingBody") : t("toolCallDetails.bodyFailed")}
      </Text>
      {status === "error" && onRetry ? (
        <Button variant="ghost" size="sm" onPress={onRetry} testID="tool-call-body-retry">
          {t("toolCallDetails.retryBody")}
        </Button>
      ) : null}
    </View>
  );
}

// ---- Styles ----

const styles = StyleSheet.create((theme) => {
  const insets = getCodeInsets(theme);

  return {
    container: {
      gap: theme.spacing[2],
    },
    codeSurface: {
      backgroundColor: theme.colors.surface1,
      borderRadius: theme.borderRadius.xl,
      overflow: "hidden",
    },
    labeledSection: {
      gap: theme.spacing[1],
    },
    sectionLabel: {
      color: theme.colors.foregroundMuted,
      fontSize: theme.fontSize.sm,
    },
    pimiSection: {
      gap: theme.spacing[2],
    },
    pimiSectionTitle: {
      color: theme.colors.foreground,
      fontSize: theme.fontSize.base,
      fontWeight: theme.fontWeight.medium,
    },
    pimiProse: {
      color: theme.colors.foreground,
      fontSize: theme.fontSize.content,
      lineHeight: Math.round(theme.fontSize.content * 1.5),
      overflowWrap: "anywhere",
    },
    pimiFields: {
      gap: theme.spacing[3],
    },
    pimiFieldRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: theme.spacing[4],
    },
    pimiFieldLabel: {
      width: 120,
      color: theme.colors.foregroundMuted,
      fontSize: theme.fontSize.sm,
      lineHeight: Math.round(theme.fontSize.base * 1.5),
    },
    pimiFieldValue: {
      flex: 1,
      minWidth: 0,
      color: theme.colors.foreground,
      fontSize: theme.fontSize.base,
      lineHeight: Math.round(theme.fontSize.base * 1.5),
      overflowWrap: "anywhere",
    },
    section: {
      gap: theme.spacing[2],
    },
    fillHeight: {
      flex: 1,
      minHeight: 0,
    },
    plainText: {
      fontFamily: theme.fontFamily.ui,
      fontSize: theme.fontSize.base,
      color: theme.colors.foregroundMuted,
      lineHeight: Math.round(theme.fontSize.base * 1.5),
      overflowWrap: "anywhere",
    },
    codeVerticalScroll: {},
    codeVerticalContent: {
      flexGrow: 1,
      paddingBottom: insets.extraBottom,
    },
    codeHorizontalContent: {
      paddingRight: insets.extraRight,
    },
    codeLine: {
      minWidth: "100%",
      paddingHorizontal: insets.padding,
      paddingVertical: insets.padding,
    },
    scrollArea: {},
    scrollContent: {
      padding: insets.padding,
    },
    scrollText: {
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
      color: theme.colors.foreground,
      lineHeight: 18,
      ...(isWeb
        ? {
            whiteSpace: "pre",
            overflowWrap: "normal",
          }
        : null),
    },
    shellPrompt: {
      color: theme.colors.foregroundMuted,
    },
    errorText: {
      color: theme.colors.statusDanger,
    },
    bodyStatusPill: {
      position: "absolute",
      right: theme.spacing[2],
      bottom: theme.spacing[2],
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
      paddingHorizontal: theme.spacing[2],
      paddingVertical: theme.spacing[1],
      borderRadius: theme.borderRadius.md,
      backgroundColor: theme.colors.surface2,
    },
    bodyStatusText: {
      color: theme.colors.foregroundMuted,
      fontSize: theme.fontSize.sm,
    },
    emptyStateText: {
      color: theme.colors.foregroundMuted,
      fontSize: theme.fontSize.base,
      fontStyle: "italic",
    },
    loadingContainer: {
      gap: theme.spacing[2],
      padding: theme.spacing[3],
    },
    loadingLineWide: {
      height: 12,
      width: "100%",
      borderRadius: theme.borderRadius.full,
      backgroundColor: theme.colors.surface3,
    },
    loadingLineMedium: {
      height: 12,
      width: "72%",
      borderRadius: theme.borderRadius.full,
      backgroundColor: theme.colors.surface3,
    },
    loadingLineShort: {
      height: 12,
      width: "48%",
      borderRadius: theme.borderRadius.full,
      backgroundColor: theme.colors.surface3,
    },
  };
});
