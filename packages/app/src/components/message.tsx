import { UserMessageText } from "@/components/user-message-text";
import { overridable } from "@/extension-points";
import { placedChipRefs } from "@/components/user-message-text/runs";
import type { AnnotationAttachmentMetadata } from "@pimi/protocol/messages";
import { useDisclosureHold } from "@/agent-stream/disclosure";
import { MessagePreview, MessageSender } from "@/components/user-message";
import { useStableEvent } from "@/hooks/use-stable-event";
import { getAgentAttachmentPillContent } from "@/attachments/attachment-pill-content";
import { SentAnnotationPill, SentScreenshotContext } from "@/annotations/sent-pill";
import {
  isBrowserElementAttachment,
  SentBrowserElementPill,
} from "@/components/sent-browser-element-pill";
import { AgentImageGrid, type AgentImageGridItem } from "@/components/agent-image-grid";
import { useAgentImages, type AgentImageSlot } from "@/hooks/use-agent-images";
import { AssistantForkMenu, type AssistantForkTarget } from "@/components/assistant-fork-menu";
import { AttachmentFrame, AttachmentLabel } from "@/components/attachment-pill";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { RewindMenu, type RewindMode } from "@/components/rewind/rewind-menu";
import { useRewindAgentMutation } from "@/components/rewind/use-rewind-agent-mutation";
import { TaskListRow } from "@/components/task-list-row";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative, isWeb } from "@/constants/platform";
import { useRevealedText, type MarkdownPhase } from "@/hooks/use-revealed-text";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { buildToolCallPresentation } from "@/tool-calls/presentation";
import type { TaskActivity, TodoEntry, UserMessageImageAttachment } from "@/types/stream";
import { setAssistantMessageHeight } from "@/utils/assistant-message-height-estimate";
import { isRenderProfileEnabled } from "@/utils/render-profiler";
import { writeMarkdownToRichClipboard } from "@/utils/rich-clipboard";
import { getDefaultMarkdownClipboardEnvironment } from "@/utils/rich-clipboard-default-environment";
import { formatDuration, formatMessageTimestamp } from "@/utils/time";
import { resolveToolCallIcon } from "@/utils/tool-call-icon";
import { useToolCallExpanded } from "@/tool-calls/expansion-context";
import { useTargetAgentTitle } from "@/tool-calls/use-target-agent-title";
import type { DaemonClient } from "@pimi/client/internal/daemon-client";
import type { AgentMessage } from "@pimi/protocol/agent-message";
import type {
  AgentCapabilityFlags,
  AgentImageRef,
  ToolCallDetail,
} from "@pimi/protocol/agent-types";
import type { AgentAttachment } from "@pimi/protocol/messages";
import {
  Check,
  Copy,
  Info,
  ListTodo,
  MicVocal,
  Scissors,
  TriangleAlertIcon,
  XCircle,
} from "lucide-react-native";
import type { ReactNode } from "react";
import * as React from "react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "@/i18n/use-translation";
import { Pressable, StyleProp, Text, View, ViewStyle, type TextStyle } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { capAssistantMessageForRender, getUtf8ByteLength } from "./assistant-message-render-limit";
import { getTurnDurationLabel } from "./assistant-turn-footer-label";
import { getCompactionMarkerLabel } from "./message-compaction-label";
import { ActivityRow, type ActivityRowState } from "./activity-row";
import { PlanCard } from "./plan-card";
import { ToolCallDetailsContent } from "./tool-call-details";
import { useToolCallSheet } from "./tool-call-sheet";
import { readToolBodyOmitted } from "@pimi/protocol/tool-call-body";
import {
  prefetchToolCallBody,
  useToolCallBody,
  type ToolBodySource,
} from "@/tool-calls/use-tool-call-body";
export type { InlinePathTarget } from "@/assistant-file-links";
export type { AssistantForkTarget };

interface UserMessageProps {
  sender?: AgentMessage["sender"];
  serverId?: string;
  agentId?: string;
  messageId?: string;
  message: string;
  images?: UserMessageImageAttachment[];
  attachments?: AgentAttachment[];
  /** Images the daemon kept for this message, shown when there are no local copies. */
  sentImages?: AgentImageRef[];
  timestamp: number;
  capabilities?: AgentCapabilityFlags;
  client?: DaemonClient | null;
  isFirstInGroup?: boolean;
  isLastInGroup?: boolean;
  isPending?: boolean;
  disableOuterSpacing?: boolean;
}

const MessageOuterSpacingContext = createContext(false);

export function MessageOuterSpacingProvider({
  disableOuterSpacing,
  children,
}: {
  disableOuterSpacing: boolean;
  children: ReactNode;
}) {
  return (
    <MessageOuterSpacingContext.Provider value={disableOuterSpacing}>
      {children}
    </MessageOuterSpacingContext.Provider>
  );
}

function useDisableOuterSpacing(disableOuterSpacing: boolean | undefined) {
  const contextValue = useContext(MessageOuterSpacingContext);
  return disableOuterSpacing ?? contextValue;
}

const ThemedMicVocal = withUnistyles(MicVocal);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

// Font size for stream metadata (timestamps, durations, live elapsed timer).
// Lives between theme.fontSize.sm (12) and theme.fontSize.base (14); no token.
export const STREAM_METADATA_FONT_SIZE = 13;

const userMessageStylesheet = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    justifyContent: "flex-end",
    ...(isWeb ? { userSelect: "text" as const } : {}),
  },
  content: {
    alignItems: "flex-end",
    maxWidth: "100%",
    cursor: "auto",
  },
  containerSpacing: {
    marginBottom: theme.spacing[1],
  },
  containerFirstInGroup: {
    marginTop: theme.spacing[4],
  },
  containerLastInGroup: {
    marginBottom: theme.spacing[4],
  },
  bubble: {
    backgroundColor: theme.colors.surface3,
    borderRadius: theme.borderRadius["2xl"],
    borderTopRightRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
    minWidth: 0,
    flexShrink: 1,
  },
  text: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.content,
    ...(isWeb
      ? {
          lineHeight: Math.round(theme.fontSize.content * 1.4),
          overflowWrap: "anywhere" as const,
        }
      : {}),
  },
  imagePreviewContainer: {
    flexDirection: "row",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
  attachmentPreviewContainer: {
    flexDirection: "row",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
  imagePreviewSpacing: {
    marginBottom: theme.spacing[2],
  },
  copyButton: {
    alignSelf: "center",
    padding: theme.spacing[1],
    paddingTop: theme.spacing[1],
    marginTop: 0,
    marginRight: -theme.spacing[1],
  },
  trailingRow: {
    alignSelf: "flex-end",
    flexDirection: "row",
    alignItems: "center",
    height: 24,
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
  trailingRowHidden: {
    opacity: 0,
  },
  trailingRowVisible: {
    opacity: 1,
  },
  timestampText: {
    color: theme.colors.foregroundMuted,
    fontSize: STREAM_METADATA_FONT_SIZE,
  },
}));

const MESSAGE_TEXT_DATASET = { messageText: "true" };

function SentAttachmentRow({
  attachments,
  resolvedImages,
  style,
}: {
  attachments: readonly AgentAttachment[];
  resolvedImages: ReadonlyArray<UserMessageImageAttachment | null>;
  style: StyleProp<ViewStyle>;
}) {
  const { t } = useTranslation();
  return (
    <View style={style}>
      {attachments.map((attachment, index) => {
        if (isBrowserElementAttachment(attachment)) {
          const shot = attachment.browserElement.screenshotIndex;
          return (
            <SentBrowserElementPill
              key={`browser:${attachment.browserElement.url}:${attachment.browserElement.selector}:${attachment.browserElement.comment ?? ""}`}
              attachment={attachment}
              screenshot={shot === undefined ? null : (resolvedImages[shot] ?? null)}
            />
          );
        }
        if (attachment.type === "text" && attachment.annotation) {
          return (
            <SentAnnotationPill
              key={`annotation:${attachment.annotation.quote.slice(0, 48)}:${attachment.annotation.note.slice(0, 16)}`}
              annotation={attachment.annotation}
            />
          );
        }
        const content = getAgentAttachmentPillContent(attachment, t);
        return (
          <AttachmentFrame
            key={`${attachment.type}:${"number" in attachment ? attachment.number : index}`}
          >
            <AttachmentLabel icon={content.icon} title={content.title} />
          </AttachmentFrame>
        );
      })}
    </View>
  );
}

const UserMessageBase = memo(function UserMessage({
  sender,
  serverId,
  agentId,
  messageId,
  message,
  images = [],
  attachments = [],
  sentImages,
  timestamp,
  capabilities,
  client,
  isFirstInGroup = true,
  isLastInGroup = true,
  isPending = false,
  disableOuterSpacing,
}: UserMessageProps) {
  const isCompact = useIsCompactFormFactor();
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const resolvedDisableOuterSpacing = useDisableOuterSpacing(disableOuterSpacing);
  const hasText = message.trim().length > 0;
  // A message this client sent keeps its local images; any other copy fetches the daemon's.
  const fetchedImages = useAgentImages(images.length > 0 ? null : client, agentId, sentImages);
  const resolvedSlots = useMemo<AgentImageSlot[]>(
    () =>
      images.length > 0 ? images.map((metadata) => ({ state: "ready", metadata })) : fetchedImages,
    [images, fetchedImages],
  );
  const resolvedImages = useMemo<Array<UserMessageImageAttachment | null>>(
    () => resolvedSlots.map((slot) => (slot.state === "ready" ? slot.metadata : null)),
    [resolvedSlots],
  );
  // A browser element pill shows its own screenshot, so the bubble does not repeat it.
  const standaloneItems = useMemo<AgentImageGridItem[]>(() => {
    const pillShots = new Set<number>();
    for (const attachment of attachments) {
      if (isBrowserElementAttachment(attachment)) {
        const index = attachment.browserElement.screenshotIndex;
        if (index !== undefined) pillShots.add(index);
      }
      if (attachment.type === "text" && attachment.annotation?.screenshotIndex !== undefined) {
        pillShots.add(attachment.annotation.screenshotIndex);
      }
    }
    return resolvedSlots.flatMap((slot, index) =>
      pillShots.has(index)
        ? []
        : [{ slot, width: sentImages?.[index]?.width, height: sentImages?.[index]?.height }],
    );
  }, [attachments, resolvedSlots, sentImages]);
  const hasImages = standaloneItems.length > 0;
  const screenshotFor = useCallback(
    (index: number) => resolvedImages[index] ?? null,
    [resolvedImages],
  );
  // An annotation whose marker is in the text is drawn there; the rest stay in the row above.
  const annotationsByRef = useMemo(() => {
    const byRef = new Map<number, AnnotationAttachmentMetadata>();
    for (const attachment of attachments) {
      if (attachment.type === "text" && attachment.annotation?.ref !== undefined)
        byRef.set(attachment.annotation.ref, attachment.annotation);
    }
    return byRef;
  }, [attachments]);
  const inlineRefs = useMemo(
    () => placedChipRefs(message, annotationsByRef),
    [annotationsByRef, message],
  );
  const rowAttachments = useMemo(
    () =>
      attachments.filter(
        (attachment) =>
          !(
            attachment.type === "text" &&
            attachment.annotation?.ref !== undefined &&
            inlineRefs.has(attachment.annotation.ref)
          ),
      ),
    [attachments, inlineRefs],
  );
  const hasAttachments = rowAttachments.length > 0;
  const showTrailingRow = !isPending && hasText && (isCompact || isNative || isHovered);
  const formattedTimestamp = useMemo(
    () => formatMessageTimestamp(new Date(timestamp)),
    [timestamp],
  );
  const rewindMutation = useRewindAgentMutation({ serverId, agentId, client, messageId });

  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const getMessageContent = useCallback(() => message, [message]);
  const handleRewind = useCallback(
    (input: { mode: RewindMode; rewoundText: string }) => {
      return rewindMutation.rewindAgent({ ...input, rewoundAttachments: attachments });
    },
    [attachments, rewindMutation],
  );

  const containerStyle = useMemo(
    () => [
      userMessageStylesheet.container,
      !resolvedDisableOuterSpacing && [
        isFirstInGroup ? userMessageStylesheet.containerFirstInGroup : null,
        isLastInGroup ? userMessageStylesheet.containerLastInGroup : null,
        !isFirstInGroup || !isLastInGroup ? userMessageStylesheet.containerSpacing : null,
      ],
    ],
    [resolvedDisableOuterSpacing, isFirstInGroup, isLastInGroup],
  );
  const imagePreviewContainerStyle = useMemo(
    () => [
      userMessageStylesheet.imagePreviewContainer,
      hasText || hasAttachments ? userMessageStylesheet.imagePreviewSpacing : undefined,
    ],
    [hasAttachments, hasText],
  );
  const attachmentPreviewContainerStyle = useMemo(
    () => [
      userMessageStylesheet.attachmentPreviewContainer,
      hasText ? userMessageStylesheet.imagePreviewSpacing : undefined,
    ],
    [hasText],
  );
  const trailingRowStyle = useMemo(
    () => [
      userMessageStylesheet.trailingRow,
      showTrailingRow
        ? userMessageStylesheet.trailingRowVisible
        : userMessageStylesheet.trailingRowHidden,
    ],
    [showTrailingRow],
  );

  return (
    <View style={containerStyle} testID="user-message" aria-busy={isPending}>
      <View
        style={userMessageStylesheet.content}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
      >
        {sender ? <MessageSender sender={sender} serverId={serverId} /> : null}
        <View style={userMessageStylesheet.bubble}>
          <SentScreenshotContext.Provider value={screenshotFor}>
            <MessagePreview>
              {hasImages ? (
                <View style={imagePreviewContainerStyle}>
                  <AgentImageGrid items={standaloneItems} />
                </View>
              ) : null}
              {hasAttachments ? (
                <SentAttachmentRow
                  attachments={rowAttachments}
                  resolvedImages={resolvedImages}
                  style={attachmentPreviewContainerStyle}
                />
              ) : null}
              {hasText ? (
                <UserMessageText
                  message={message}
                  annotations={annotationsByRef}
                  style={userMessageStylesheet.text}
                  dataSet={MESSAGE_TEXT_DATASET}
                />
              ) : null}
            </MessagePreview>
          </SentScreenshotContext.Provider>
        </View>
        {hasText ? (
          <View
            style={trailingRowStyle}
            pointerEvents={showTrailingRow ? "auto" : "none"}
            testID="user-message-trailing-row"
          >
            <Text style={userMessageStylesheet.timestampText} testID="user-message-timestamp">
              {formattedTimestamp}
            </Text>
            {capabilities && messageId ? (
              <RewindMenu
                capabilities={capabilities}
                isPending={rewindMutation.isPending}
                rewoundText={message}
                onRewind={handleRewind}
              />
            ) : null}
            <TurnCopyButton
              getContent={getMessageContent}
              containerStyle={userMessageStylesheet.copyButton}
              accessibilityLabel={t("message.actions.copyMessage")}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
});

export const UserMessage = overridable("chat.userMessage", UserMessageBase, {
  toPlugin: ({ message, attachments, timestamp, isPending, agentId, serverId }) => ({
    message,
    attachments: (attachments ?? []).map((attachment) => ({
      type: attachment.type,
      name: "name" in attachment && typeof attachment.name === "string" ? attachment.name : null,
    })),
    timestamp,
    pending: isPending ?? false,
    agentId: agentId ?? null,
    serverId: serverId ?? null,
  }),
  merge: (core, patch) => ({
    ...core,
    message: patch.message ?? core.message,
    timestamp: patch.timestamp ?? core.timestamp,
    isPending: patch.pending ?? core.isPending,
  }),
});

interface AssistantTurnFooterProps {
  getContent?: () => string;
  completedAt?: Date;
  durationMs?: number | null;
  onFork?: (target: AssistantForkTarget) => Promise<void> | void;
}

const assistantTurnFooterStylesheet = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  copyButton: {
    alignSelf: "center",
    padding: theme.spacing[1],
    paddingTop: theme.spacing[1],
    marginTop: 0,
    marginLeft: -theme.spacing[1],
  },
  labelWrapper: {
    position: "relative",
  },
  labelSizer: {
    color: theme.colors.foregroundMuted,
    fontSize: STREAM_METADATA_FONT_SIZE,
    opacity: 0,
  },
  labelOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    color: theme.colors.foregroundMuted,
    fontSize: STREAM_METADATA_FONT_SIZE,
  },
}));

const TIMESTAMP_REVEAL_MS = 3000;

/**
 * Footer rendered next to the copy button at the end of an assistant turn.
 * Shows the turn duration and swaps to the end timestamp when both are known.
 * A turn without a visible start shows its end timestamp directly.
 */
export const AssistantTurnFooter = memo(function AssistantTurnFooter({
  getContent,
  completedAt,
  durationMs,
  onFork,
}: AssistantTurnFooterProps) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const [pressedReveal, setPressedReveal] = useState(false);
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (revealTimerRef.current) {
        clearTimeout(revealTimerRef.current);
        revealTimerRef.current = null;
      }
    };
  }, []);

  const durationLabel = useMemo(
    () =>
      durationMs !== undefined && durationMs !== null ? getTurnDurationLabel(durationMs, t) : "",
    [durationMs, t],
  );
  const timestampLabel = useMemo(
    () => (completedAt ? formatMessageTimestamp(completedAt) : ""),
    [completedAt],
  );

  const primaryLabel = durationLabel || timestampLabel;
  const canSwap = Boolean(durationLabel && timestampLabel);
  const showTimestamp = canSwap && (isWeb ? hovered : pressedReveal);

  const handleHoverIn = useCallback(() => setHovered(true), []);
  const handleHoverOut = useCallback(() => setHovered(false), []);
  const handlePress = useCallback(() => {
    if (isWeb || !canSwap) return;
    if (revealTimerRef.current) {
      clearTimeout(revealTimerRef.current);
    }
    setPressedReveal((prev) => !prev);
    revealTimerRef.current = setTimeout(() => {
      setPressedReveal(false);
      revealTimerRef.current = null;
    }, TIMESTAMP_REVEAL_MS);
  }, [canSwap]);
  const handleFork = useCallback(
    (target: AssistantForkTarget) => {
      return onFork?.(target);
    },
    [onFork],
  );
  const canFork = Boolean(onFork);

  return (
    <View style={assistantTurnFooterStylesheet.container}>
      {getContent ? (
        <TurnCopyButton
          getContent={getContent}
          containerStyle={assistantTurnFooterStylesheet.copyButton}
        />
      ) : null}
      {canFork ? <AssistantForkMenu onFork={handleFork} /> : null}
      {primaryLabel ? (
        <Pressable
          onPress={handlePress}
          onHoverIn={handleHoverIn}
          onHoverOut={handleHoverOut}
          accessibilityRole={canSwap ? "button" : undefined}
          accessibilityLabel={canSwap ? `${durationLabel}, ended ${timestampLabel}` : primaryLabel}
        >
          <View style={assistantTurnFooterStylesheet.labelWrapper}>
            {/* Sizer reserves space for whichever label is longer so the
                container width is stable across hover transitions. */}
            <Text style={assistantTurnFooterStylesheet.labelSizer} aria-hidden>
              {primaryLabel.length >= timestampLabel.length ? primaryLabel : timestampLabel}
            </Text>
            <Text style={assistantTurnFooterStylesheet.labelOverlay}>
              {showTimestamp ? timestampLabel : primaryLabel}
            </Text>
          </View>
        </Pressable>
      ) : null}
    </View>
  );
});

interface LiveElapsedProps {
  startedAt: Date;
  active?: boolean;
  style?: StyleProp<TextStyle>;
  testID?: string;
}

/**
 * Ticks every second to render an elapsed duration. Isolated from parents so
 * only this component re-renders on each tick.
 */
export const LiveElapsed = memo(function LiveElapsed({
  startedAt,
  active = true,
  style,
  testID,
}: LiveElapsedProps) {
  const startedAtMs = startedAt.getTime();
  const [elapsedMs, setElapsedMs] = useState(() => Math.max(0, Date.now() - startedAtMs));
  const visibleElapsedMs = active ? Math.max(0, Date.now() - startedAtMs) : elapsedMs;

  useEffect(() => {
    if (!active) {
      return;
    }
    setElapsedMs(Math.max(0, Date.now() - startedAtMs));
    const handle = setInterval(() => {
      setElapsedMs(Math.max(0, Date.now() - startedAtMs));
    }, 1000);
    return () => clearInterval(handle);
  }, [active, startedAtMs]);

  return (
    <Text style={style} testID={testID}>
      {formatDuration(visibleElapsedMs)}
    </Text>
  );
});

interface AssistantMessageProps {
  renderFullContent?: boolean;
  occurrenceKey: string;
  message: string;
  timestamp: number;
  workspaceRoot?: string;
  serverId?: string;
  client?: DaemonClient | null;
  spacing?: "default" | "compactTop" | "compactBottom" | "compactBoth";
  phase: MarkdownPhase;
}

export const assistantMessageStylesheet = StyleSheet.create((theme) => ({
  container: {
    paddingVertical: theme.spacing[3],
    ...(isWeb ? { userSelect: "text" as const } : {}),
  },
  containerCompactTop: {
    paddingTop: 0,
  },
  containerCompactBottom: {
    paddingBottom: 0,
  },
  cappedNotice: {
    marginTop: theme.spacing[3],
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.base,
    fontStyle: "italic",
    color: theme.colors.foregroundMuted,
  },
  imageFrame: {
    width: "100%",
    minHeight: 160,
    marginHorizontal: -theme.spacing[1],
  },
  imageSurface: {
    width: "100%",
    overflow: "hidden",
    position: "relative",
  },
  image: {
    width: "100%",
    height: "100%",
  },
  imageLoadingOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  imageState: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[6],
    gap: theme.spacing[2],
  },
  imageErrorText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));

const turnCopyButtonStylesheet = StyleSheet.create((theme) => ({
  container: {
    alignSelf: "flex-start",
    padding: theme.spacing[2],
    paddingTop: 0,
    marginTop: theme.spacing[2],
  },
  iconColor: {
    color: theme.colors.foregroundMuted,
  },
  iconHoveredColor: {
    color: theme.colors.foreground,
  },
}));

interface TurnCopyButtonProps {
  getContent: () => string;
  containerStyle?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  copiedAccessibilityLabel?: string;
}

export const TurnCopyButton = memo(function TurnCopyButton({
  getContent,
  containerStyle,
  accessibilityLabel,
  copiedAccessibilityLabel,
}: TurnCopyButtonProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = useCallback(async () => {
    const content = getContent();
    if (!content) {
      return;
    }

    await writeMarkdownToRichClipboard(content, getDefaultMarkdownClipboardEnvironment());
    setCopied(true);

    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current);
    }

    copyTimeoutRef.current = setTimeout(() => {
      setCopied(false);
      copyTimeoutRef.current = null;
    }, 1500);
  }, [getContent]);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const pressableStyle = useMemo(
    () => [turnCopyButtonStylesheet.container, containerStyle],
    [containerStyle],
  );

  return (
    <Pressable
      onPress={handleCopy}
      style={pressableStyle}
      accessibilityRole="button"
      accessibilityLabel={
        copied
          ? (copiedAccessibilityLabel ?? t("message.actions.copied"))
          : (accessibilityLabel ?? t("message.actions.copyTurn"))
      }
    >
      {({ hovered }) => {
        const iconColor = hovered
          ? turnCopyButtonStylesheet.iconHoveredColor.color
          : turnCopyButtonStylesheet.iconColor.color;
        return copied ? (
          <Check size={ICON_SIZE.sm} color={iconColor} />
        ) : (
          <Copy size={ICON_SIZE.sm} color={iconColor} />
        );
      }}
    </Pressable>
  );
});

const AssistantMessageBase = memo(function AssistantMessage({
  renderFullContent = false,
  occurrenceKey,
  message,
  timestamp: _timestamp,
  workspaceRoot,
  serverId,
  client,
  spacing = "default",
  phase,
}: AssistantMessageProps) {
  const { t } = useTranslation();
  const renderedMessage = useMemo(
    () =>
      renderFullContent ? { text: message, capped: false } : capAssistantMessageForRender(message),
    [message, renderFullContent],
  );
  const revealedText = useRevealedText(renderedMessage.text, phase);
  const revealedMessage = renderFullContent ? renderedMessage.text : revealedText;
  const fullMessageByteLength = useMemo(
    () => (renderedMessage.capped && phase === "complete" ? getUtf8ByteLength(message) : null),
    [message, phase, renderedMessage.capped],
  );

  const assistantContainerStyle = useMemo(
    () => [
      assistantMessageStylesheet.container,
      (spacing === "compactTop" || spacing === "compactBoth") &&
        assistantMessageStylesheet.containerCompactTop,
      (spacing === "compactBottom" || spacing === "compactBoth") &&
        assistantMessageStylesheet.containerCompactBottom,
    ],
    [spacing],
  );
  const revealDataSet = useMemo(
    () =>
      isRenderProfileEnabled()
        ? {
            ...MESSAGE_TEXT_DATASET,
            revealKey: occurrenceKey,
            revealLength: String(revealedMessage.length),
          }
        : MESSAGE_TEXT_DATASET,
    [occurrenceKey, revealedMessage.length],
  );

  const measureMessage = useStableEvent((event: import("react-native").LayoutChangeEvent) => {
    setAssistantMessageHeight({ markdown: revealedMessage, ...event.nativeEvent.layout });
  });
  return (
    <View
      testID="assistant-message"
      dataSet={revealDataSet}
      style={assistantContainerStyle}
      onLayout={measureMessage}
    >
      <MarkdownRenderer
        text={revealedMessage}
        agentCommands
        visualizations
        streaming={phase !== "complete" || revealedMessage.length < renderedMessage.text.length}
        client={client}
        workspaceRoot={workspaceRoot}
        serverId={serverId}
      />
      {fullMessageByteLength !== null ? (
        <Text
          testID="assistant-message-capped-notice"
          style={assistantMessageStylesheet.cappedNotice}
        >
          {t("agentStream.messageCapped", { bytes: fullMessageByteLength })}
        </Text>
      ) : null}
    </View>
  );
});

export const AssistantMessage = overridable("chat.assistantMessage", AssistantMessageBase, {
  toPlugin: ({ message, phase, timestamp, serverId }) => ({
    markdown: message,
    phase,
    timestamp,
    serverId: serverId ?? null,
  }),
  merge: (core, patch) => ({
    ...core,
    message: patch.markdown ?? core.message,
    phase: patch.phase ?? core.phase,
    timestamp: patch.timestamp ?? core.timestamp,
  }),
});

interface SpeakMessageProps {
  message: string;
  timestamp: number;
  disableOuterSpacing?: boolean;
}

const speakMessageStylesheet = StyleSheet.create((theme) => ({
  container: {
    paddingVertical: theme.spacing[3],
  },
  containerSpacing: {
    marginBottom: theme.spacing[4],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[2],
  },
  headerLabel: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  text: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.content,
    lineHeight: Math.round(theme.fontSize.content * 1.4),
    color: theme.colors.foreground,
  },
}));

export const SpeakMessage = memo(function SpeakMessage({
  message,
  timestamp: _timestamp,
  disableOuterSpacing,
}: SpeakMessageProps) {
  const { t } = useTranslation();
  const resolvedDisableOuterSpacing = useDisableOuterSpacing(disableOuterSpacing);
  const containerStyle = useMemo(
    () => [
      speakMessageStylesheet.container,
      !resolvedDisableOuterSpacing && speakMessageStylesheet.containerSpacing,
    ],
    [resolvedDisableOuterSpacing],
  );

  return (
    <View testID="speak-message" style={containerStyle}>
      <View style={speakMessageStylesheet.header}>
        <ThemedMicVocal size={12} uniProps={foregroundMutedColorMapping} />
        <Text style={speakMessageStylesheet.headerLabel}>{t("message.speak.header")}</Text>
      </View>
      <Text style={speakMessageStylesheet.text}>{message}</Text>
    </View>
  );
});

interface NotificationProps {
  level: "info" | "warning" | "error";
  message: string;
  disableOuterSpacing?: boolean;
}

const ThemedNotificationInfo = withUnistyles(Info);
const ThemedNotificationWarning = withUnistyles(TriangleAlertIcon);
const ThemedNotificationError = withUnistyles(XCircle);

const infoIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const warningIconMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });
const errorIconMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });

const notificationStylesheet = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.xl,
  },
  containerSpacing: {
    marginBottom: theme.spacing[1],
  },
  infoBg: {
    backgroundColor: theme.colors.surface2,
  },
  warningBg: {
    backgroundColor: theme.colors.statusWarningTint,
  },
  errorBg: {
    backgroundColor: theme.colors.statusDangerTint,
  },
  iconContainer: {
    flexShrink: 0,
    height: theme.fontSize.base * 1.5,
    justifyContent: "center",
  },
  messageText: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.5,
  },
}));

const NotificationBase = memo(function Notification({
  level,
  message,
  disableOuterSpacing,
}: NotificationProps) {
  const resolvedDisableOuterSpacing = useDisableOuterSpacing(disableOuterSpacing);

  const typeConfig = {
    info: {
      bg: notificationStylesheet.infoBg,
      iconColorMapping: infoIconMapping,
      Icon: ThemedNotificationInfo,
    },
    warning: {
      bg: notificationStylesheet.warningBg,
      iconColorMapping: warningIconMapping,
      Icon: ThemedNotificationWarning,
    },
    error: {
      bg: notificationStylesheet.errorBg,
      iconColorMapping: errorIconMapping,
      Icon: ThemedNotificationError,
    },
  };

  const config = typeConfig[level];
  const IconComponent = config.Icon;

  return (
    <View
      style={[
        notificationStylesheet.container,
        !resolvedDisableOuterSpacing && notificationStylesheet.containerSpacing,
        config.bg,
      ]}
    >
      <View style={notificationStylesheet.iconContainer}>
        <IconComponent size={ICON_SIZE.md} uniProps={config.iconColorMapping} />
      </View>
      <Text style={notificationStylesheet.messageText} selectable>
        {message}
      </Text>
    </View>
  );
});

export const Notification = overridable("chat.notification", NotificationBase, {
  toPlugin: ({ level, message }) => ({ level, message }),
  merge: (core, patch) => ({
    ...core,
    level: patch.level ?? core.level,
    message: patch.message ?? core.message,
  }),
});

interface CompactionMarkerProps {
  status: "loading" | "completed";
  trigger?: "auto" | "manual";
  preTokens?: number;
}

const ThemedCompactionSpinner = withUnistyles(LoadingSpinner, (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedCompactionIcon = withUnistyles(Scissors, (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));

const compactionStylesheet = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[2],
  },
  line: {
    flex: 1,
    height: 1,
    backgroundColor: theme.colors.border,
  },
  label: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  text: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));

export const CompactionMarker = memo(function CompactionMarker({
  status,
  trigger,
  preTokens,
}: CompactionMarkerProps) {
  const label = getCompactionMarkerLabel({ status, trigger, preTokens });

  return (
    <View style={compactionStylesheet.container}>
      <View style={compactionStylesheet.line} />
      <View style={compactionStylesheet.label}>
        {status === "loading" ? (
          <ThemedCompactionSpinner size="small" />
        ) : (
          <ThemedCompactionIcon size={ICON_SIZE.xs} />
        )}
        <Text style={compactionStylesheet.text}>{label}</Text>
      </View>
      <View style={compactionStylesheet.line} />
    </View>
  );
});

interface TodoListCardProps {
  items: TodoEntry[];
  activity: TaskActivity;
  disableOuterSpacing?: boolean;
}

const todoListCardStylesheet = StyleSheet.create((theme) => ({
  list: {
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));

const TodoListCardBase = memo(function TodoListCard({
  items,
  activity,
  disableOuterSpacing,
}: TodoListCardProps) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);
  const activityDisplay = useMemo(() => {
    if (activity.type === "created") {
      return {
        label: t("message.todo.activity.created", { count: activity.count }),
        target: undefined,
      };
    }
    return {
      label: t(`message.todo.activity.${activity.type}`),
      target: activity.task,
    };
  }, [activity, t]);
  const progress = useMemo(() => {
    if (items.length === 0) return undefined;
    const done = items.filter((item) => item.completed || item.status === "completed").length;
    return `${done}/${items.length}`;
  }, [items]);

  const hold = useDisclosureHold();
  const toggleExpanded = useCallback(() => setIsExpanded((prev) => !prev), []);
  const handleToggle = useCallback(() => hold(toggleExpanded), [hold, toggleExpanded]);

  const renderDetails = useCallback(() => {
    return (
      <View style={todoListCardStylesheet.list}>
        {items.length === 0 ? (
          <Text style={todoListCardStylesheet.emptyText}>{t("message.todo.empty")}</Text>
        ) : (
          items.map((item) => <TaskListRow key={item.id ?? item.text} task={item} />)
        )}
      </View>
    );
  }, [items, t]);

  return (
    <ActivityRow
      icon={ListTodo}
      verb={activityDisplay.label}
      target={activityDisplay.target}
      meta={progress}
      isExpanded={isExpanded}
      onToggle={handleToggle}
      renderDetails={renderDetails}
      disableOuterSpacing={disableOuterSpacing}
    />
  );
});

export const TodoListCard = overridable("chat.todoList", TodoListCardBase, {
  toPlugin: ({ items }) => ({
    items: items.map((item) => ({ text: item.text, completed: item.completed })),
  }),
  merge: (core) => core,
});

interface ToolCallProps {
  agentMessage?: AgentMessage;
  serverId?: string;
  toolName: string;
  args?: unknown;
  result?: unknown;
  error?: unknown;
  status: "executing" | "running" | "completed" | "failed" | "canceled";
  detail?: ToolCallDetail;
  cwd?: string;
  metadata?: Record<string, unknown>;
  isLastInSequence?: boolean;
  disableOuterSpacing?: boolean;
  onInlineDetailsHoverChange?: (hovered: boolean) => void;
  onInlineDetailsExpandedChange?: (expanded: boolean) => void;
  onOpenFilePath?: (filePath: string) => void;
  defaultExpanded?: boolean;
  forceInline?: boolean;
  maxDetailHeight?: number;
  itemId: string;
  /** Shown as its own row rather than inside a tool call group. */
  standalone?: boolean;
  agentId?: string;
  callId?: string;
  turnId?: string;
  /** The call belongs to the newest turn, so its body is likely to be opened. */
  prefetchBody?: boolean;
}

function toActivityRowState(status: ToolCallProps["status"]): ActivityRowState {
  switch (status) {
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    case "running":
    case "executing":
      return "running";
    default:
      return "idle";
  }
}

const ToolCallBase = memo(function ToolCall({
  agentMessage,
  serverId,
  toolName,
  args,
  result,
  error,
  status,
  detail,
  cwd,
  metadata,
  isLastInSequence = false,
  disableOuterSpacing,
  onInlineDetailsHoverChange,
  onInlineDetailsExpandedChange,
  onOpenFilePath,
  defaultExpanded,
  forceInline = false,
  maxDetailHeight = 400,
  itemId,
  standalone = true,
  agentId,
  callId,
  turnId,
  prefetchBody = false,
}: ToolCallProps) {
  const { t } = useTranslation();
  const { openToolCall } = useToolCallSheet();
  const { expanded: isExpanded, toggle: toggleExpanded } = useToolCallExpanded({
    callId: itemId,
    defaultExpanded: defaultExpanded ?? false,
    standalone,
  });

  const isMobile = useIsCompactFormFactor();
  const shouldRenderInline = !isMobile || forceInline;
  const hold = useDisclosureHold();

  const effectiveDetail = useMemo<ToolCallDetail | undefined>(() => {
    if (detail) {
      return detail;
    }
    if (args !== undefined || result !== undefined) {
      return {
        type: "unknown",
        input: args ?? null,
        output: result ?? null,
      };
    }
    return undefined;
  }, [detail, args, result]);

  const bodyOmitted = readToolBodyOmitted(metadata);
  const bodySource = useMemo<ToolBodySource | undefined>(
    () => (serverId && agentId && callId ? { serverId, agentId, callId, turnId } : undefined),
    [serverId, agentId, callId, turnId],
  );
  const body = useToolCallBody(
    shouldRenderInline && isExpanded && bodySource ? bodySource : null,
    bodyOmitted,
    effectiveDetail,
  );

  const handlePrefetch = useCallback(() => {
    if (bodySource) prefetchToolCallBody(bodySource, bodyOmitted);
  }, [bodySource, bodyOmitted]);
  useEffect(() => {
    if (prefetchBody) handlePrefetch();
  }, [prefetchBody, handlePrefetch]);

  const targetAgentTitle = useTargetAgentTitle({ serverId, toolName, detail: effectiveDetail });
  const presentation = useMemo(
    () =>
      buildToolCallPresentation({
        agentMessage,
        toolName,
        status,
        error: error ?? null,
        detail: effectiveDetail,
        metadata,
        cwd,
        targetAgentTitle,
        resolveIcon: resolveToolCallIcon,
        t,
      }),
    [toolName, status, error, effectiveDetail, metadata, cwd, agentMessage, targetAgentTitle, t],
  );
  const handleOpenFile = useMemo(() => {
    const openFilePath = presentation.openFilePath;
    if (!openFilePath || !onOpenFilePath) {
      return undefined;
    }
    return () => onOpenFilePath(openFilePath);
  }, [presentation.openFilePath, onOpenFilePath]);

  const handleToggle = useCallback(() => {
    if (!shouldRenderInline) {
      openToolCall({
        toolName,
        displayName: presentation.displayName,
        summary: presentation.summary,
        detail: presentation.detail,
        errorText: presentation.errorText,
        icon: presentation.icon,
        showLoadingSkeleton: presentation.isLoadingDetails,
        ...(bodyOmitted > 0 && bodySource ? { bodySource, bodyOmitted } : {}),
      });
    } else {
      hold(toggleExpanded);
    }
  }, [
    hold,
    shouldRenderInline,
    toggleExpanded,
    openToolCall,
    toolName,
    presentation.detail,
    presentation.displayName,
    presentation.summary,
    presentation.errorText,
    presentation.icon,
    presentation.isLoadingDetails,
    bodyOmitted,
    bodySource,
  ]);

  useEffect(() => {
    if (!onInlineDetailsHoverChange || !shouldRenderInline || isExpanded) {
      return;
    }
    onInlineDetailsHoverChange(false);
  }, [isExpanded, shouldRenderInline, onInlineDetailsHoverChange]);

  useEffect(() => {
    if (!onInlineDetailsExpandedChange) {
      return;
    }
    if (!shouldRenderInline) {
      onInlineDetailsExpandedChange(false);
      return;
    }
    onInlineDetailsExpandedChange(isExpanded);
  }, [isExpanded, shouldRenderInline, onInlineDetailsExpandedChange]);

  useEffect(() => {
    if (!onInlineDetailsExpandedChange) {
      return () => {};
    }
    return () => {
      onInlineDetailsExpandedChange(false);
    };
  }, [onInlineDetailsExpandedChange]);

  // Render inline details for desktop
  const renderDetails = useCallback(() => {
    if (!shouldRenderInline) return null;
    return (
      <ToolCallDetailsContent
        toolName={toolName}
        detail={body.detail === effectiveDetail ? presentation.detail : body.detail}
        errorText={presentation.errorText}
        maxHeight={maxDetailHeight}
        showLoadingSkeleton={presentation.isLoadingDetails}
        bodyStatus={body.status}
        onRetryBody={body.retry}
      />
    );
  }, [
    shouldRenderInline,
    toolName,
    body.detail,
    body.status,
    body.retry,
    effectiveDetail,
    presentation.detail,
    presentation.errorText,
    presentation.isLoadingDetails,
    maxDetailHeight,
  ]);

  if (presentation.isPlan && effectiveDetail?.type === "plan") {
    return (
      <PlanCard
        text={effectiveDetail.text}
        outcome={presentation.planOutcome}
        testID="timeline-plan-card"
        disableOuterSpacing={disableOuterSpacing}
      />
    );
  }

  return (
    <ActivityRow
      testID="tool-call-badge"
      icon={presentation.icon}
      verb={presentation.verb}
      target={presentation.target}
      targetMono={presentation.targetMono}
      diffStat={presentation.diffStat}
      state={toActivityRowState(status)}
      isExpanded={shouldRenderInline && isExpanded}
      onToggle={presentation.canOpenDetails ? handleToggle : undefined}
      onOpenFile={handleOpenFile}
      renderDetails={presentation.canOpenDetails && shouldRenderInline ? renderDetails : undefined}
      isLastInSequence={isLastInSequence}
      disableOuterSpacing={disableOuterSpacing}
      onDetailHoverChange={onInlineDetailsHoverChange}
      onPrefetch={bodyOmitted > 0 ? handlePrefetch : undefined}
    />
  );
}, areToolCallPropsEqual);

export const ToolCall = overridable("chat.toolCall", ToolCallBase, {
  toPlugin: ({ toolName, status, args, result, error, agentId, serverId }) => ({
    toolName,
    status,
    args,
    result,
    error,
    agentId: agentId ?? null,
    serverId: serverId ?? null,
  }),
  merge: (core, patch) => ({
    ...core,
    toolName: patch.toolName ?? core.toolName,
    status: patch.status ?? core.status,
    args: "args" in patch ? patch.args : core.args,
    result: "result" in patch ? patch.result : core.result,
    error: "error" in patch ? patch.error : core.error,
  }),
});

function areToolCallPropsEqual(previous: ToolCallProps, next: ToolCallProps) {
  if (previous.toolName !== next.toolName) return false;
  if (previous.serverId !== next.serverId) return false;
  if (previous.agentMessage !== next.agentMessage) return false;
  if (previous.args !== next.args) return false;
  if (previous.result !== next.result) return false;
  if (previous.error !== next.error) return false;
  if (previous.status !== next.status) return false;
  if (previous.detail !== next.detail) return false;
  if (previous.cwd !== next.cwd) return false;
  if (previous.metadata !== next.metadata) return false;
  if (previous.isLastInSequence !== next.isLastInSequence) return false;
  if (previous.disableOuterSpacing !== next.disableOuterSpacing) return false;
  if (previous.onOpenFilePath !== next.onOpenFilePath) return false;
  if (previous.defaultExpanded !== next.defaultExpanded) return false;
  if (previous.forceInline !== next.forceInline) return false;
  if (previous.maxDetailHeight !== next.maxDetailHeight) return false;
  if (previous.itemId !== next.itemId) return false;
  if (previous.standalone !== next.standalone) return false;
  return true;
}
