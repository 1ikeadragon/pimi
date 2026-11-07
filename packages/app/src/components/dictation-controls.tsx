import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useMemo } from "react";
import { View, Text, Pressable } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { X, ArrowUp, RefreshCcw, Check, Mic, Pencil, type LucideIcon } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { VolumeMeter } from "./volume-meter";
import { FOOTER_HEIGHT } from "@/constants/layout";
import type { DictationStatus } from "@/hooks/use-dictation";

interface DictationControlsProps {
  volume: number;
  duration: number;
  transcript?: string;
  isRecording: boolean;
  isProcessing: boolean;
  status: DictationStatus;
  onStart: () => void;
  onCancel: () => void;
  onAccept: () => void;
  onAcceptAndSend: () => void;
  onRetry?: () => void;
  onDiscard?: () => void;
  disabled?: boolean;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

export function DictationControls({
  volume,
  duration,
  isRecording,
  isProcessing,
  status,
  onStart,
  onCancel,
  onAccept,
  onAcceptAndSend,
  onRetry,
  onDiscard,
  disabled = false,
}: DictationControlsProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const isFailed = status === "failed";
  const showActiveState = isRecording || isProcessing || isFailed;
  const actionsDisabled = isProcessing;
  const handleCancel = isFailed && onDiscard ? onDiscard : onCancel;

  const micButtonStyle = useMemo(
    () => [styles.micButton, disabled && styles.buttonDisabled],
    [disabled],
  );
  const timerTextStyle = useMemo(
    () => [styles.timerText, { color: theme.colors.foreground }],
    [theme.colors.foreground],
  );
  const cancelButtonStyle = useMemo(
    () => [
      styles.actionButton,
      styles.actionButtonCancel,
      actionsDisabled && !isFailed ? styles.buttonDisabled : undefined,
    ],
    [actionsDisabled, isFailed],
  );

  if (!showActiveState) {
    return (
      <Pressable
        onPress={onStart}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={t("message.dictation.start")}
        style={micButtonStyle}
      >
        <Mic size={theme.iconSize.md} color={theme.colors.foreground} />
      </Pressable>
    );
  }

  return (
    <View style={styles.activeContainer}>
      <View style={styles.meterWrapper}>
        <VolumeMeter volume={volume} isMuted={false} isSpeaking={false} orientation="horizontal" />
      </View>
      <Text style={timerTextStyle}>
        {status === "paused" ? t("message.dictation.paused") : formatDuration(duration)}
      </Text>
      <View style={styles.actionGroup}>
        <Pressable
          onPress={handleCancel}
          disabled={actionsDisabled && !isFailed}
          accessibilityLabel={t("message.dictation.cancel")}
          style={cancelButtonStyle}
        >
          <X size={theme.iconSize.sm} color={theme.colors.foreground} />
        </Pressable>
        {actionsDisabled ? (
          <View style={styles.loadingContainer}>
            <LoadingSpinner size="small" color={theme.colors.foreground} />
          </View>
        ) : null}
        {!actionsDisabled && isFailed ? (
          <Pressable
            onPress={onRetry}
            accessibilityLabel={t("message.dictation.retry")}
            style={[styles.actionButton, styles.actionButtonConfirm]}
          >
            <RefreshCcw size={theme.iconSize.sm} color={theme.colors.surface0} />
          </Pressable>
        ) : null}
        {!actionsDisabled && !isFailed ? (
          <>
            <Pressable
              onPress={onAccept}
              accessibilityLabel={t("message.dictation.insert")}
              style={[styles.actionButton, styles.actionButtonSecondary]}
            >
              <Check size={theme.iconSize.sm} color={theme.colors.foreground} />
            </Pressable>
            <Pressable
              onPress={onAcceptAndSend}
              accessibilityLabel={t("message.dictation.insertAndSend")}
              style={[styles.actionButton, styles.actionButtonConfirm]}
            >
              <ArrowUp size={theme.iconSize.sm} color={theme.colors.surface0} />
            </Pressable>
          </>
        ) : null}
      </View>
    </View>
  );
}

/** Full-width overlay variant for the agent input footer and task brief. */
export function DictationOverlay({
  volume,
  duration,
  isRecording,
  isProcessing,
  status,
  errorText,
  transparent = false,
  compact = false,
  labelActions = false,
  onCancel,
  onAccept,
  onAcceptAndSend,
  onRetry,
  onDiscard,
}: Omit<DictationControlsProps, "onStart" | "disabled" | "transcript" | "onAcceptAndSend"> & {
  errorText?: string;
  transparent?: boolean;
  compact?: boolean;
  labelActions?: boolean;
  onAcceptAndSend?: () => void;
}) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const isFailed = status === "failed";
  const showActiveState = isRecording || isProcessing || isFailed;
  const actionsDisabled = isProcessing;
  const handleCancel = isFailed && onDiscard ? onDiscard : onCancel;
  const compactButton = compact ? overlayStyles.compactButton : undefined;
  const { background, foreground, actionBackground, actionForeground, insertBackground } = useMemo(
    () =>
      transparent
        ? {
            background: "transparent",
            foreground: theme.colors.foreground,
            actionBackground: theme.colors.surface2,
            actionForeground: theme.colors.foreground,
            insertBackground: { backgroundColor: theme.colors.surface2 },
          }
        : {
            background: theme.colors.accent,
            foreground: theme.colors.accentForeground,
            actionBackground: theme.colors.accentForeground,
            actionForeground: theme.colors.accent,
            insertBackground: OVERLAY_ACCEPT_BUTTON_BG,
          },
    [theme.colors, transparent],
  );

  const containerStyle = useMemo(
    () => [
      overlayStyles.container,
      labelActions && overlayStyles.labeledContainer,
      compact && overlayStyles.compactContainer,
      { backgroundColor: background },
    ],
    [background, compact, labelActions],
  );
  const overlayCancelButtonStyle = useMemo(
    () => [
      overlayStyles.cancelButton,
      compactButton,
      labelActions && overlayStyles.labeledButton,
      actionsDisabled && !isFailed && overlayStyles.buttonDisabled,
    ],
    [actionsDisabled, compactButton, isFailed, labelActions],
  );
  const overlayTimerTextStyle = useMemo(
    () => [overlayStyles.timerText, { color: foreground }],
    [foreground],
  );
  const overlayTranscriptTextStyle = useMemo(
    () => [overlayStyles.transcriptText, { color: foreground, opacity: 0.95 }],
    [foreground],
  );
  const overlayRetryButtonStyle = useMemo(
    () => [
      overlayStyles.actionButton,
      compactButton,
      labelActions && overlayStyles.labeledButton,
      { backgroundColor: actionBackground },
    ],
    [actionBackground, compactButton, labelActions],
  );
  const overlayConfirmButtonStyle = overlayRetryButtonStyle;
  const iconSize = compact ? 16 : theme.iconSize.lg;

  if (!showActiveState) {
    return null;
  }

  return (
    <View style={containerStyle}>
      <Pressable
        onPress={handleCancel}
        disabled={actionsDisabled && !isFailed}
        accessibilityRole="button"
        accessibilityLabel={t("message.dictation.cancel")}
        style={overlayCancelButtonStyle}
      >
        {overlayActionContent(labelActions, t("common.actions.cancel"), X, foreground, iconSize)}
      </Pressable>

      <View style={overlayStyles.centerContainer}>
        <View style={overlayStyles.meterRow}>
          <VolumeMeter
            volume={volume}
            isMuted={false}
            isSpeaking={false}
            orientation="horizontal"
            variant={compact ? "compact" : "default"}
            color={foreground}
          />
          <Text style={overlayTimerTextStyle}>{formatDuration(duration)}</Text>
        </View>
        <DictationStatusText
          status={status}
          errorText={errorText}
          fullText={labelActions}
          style={overlayTranscriptTextStyle}
        />
      </View>

      <View style={overlayStyles.actionButtonsContainer}>
        {actionsDisabled ? (
          <View style={[overlayStyles.loadingContainer, compactButton]}>
            <LoadingSpinner size="small" color={foreground} />
          </View>
        ) : null}
        {!actionsDisabled && isFailed ? (
          <Pressable
            onPress={onRetry}
            accessibilityRole="button"
            accessibilityLabel={t("message.dictation.retry")}
            style={overlayRetryButtonStyle}
          >
            {overlayActionContent(
              labelActions,
              t("common.actions.retry"),
              RefreshCcw,
              actionForeground,
              iconSize,
            )}
          </Pressable>
        ) : null}
        {!actionsDisabled && !isFailed ? (
          <>
            <Pressable
              onPress={onAccept}
              accessibilityRole="button"
              accessibilityLabel={t("message.dictation.insert")}
              style={[
                overlayStyles.actionButton,
                compactButton,
                labelActions && overlayStyles.labeledButton,
                insertBackground,
              ]}
            >
              {overlayActionContent(labelActions, "Insert", Pencil, foreground, iconSize)}
            </Pressable>
            {onAcceptAndSend ? (
              <Pressable
                onPress={onAcceptAndSend}
                accessibilityRole="button"
                accessibilityLabel={t("message.dictation.insertAndSend")}
                style={overlayConfirmButtonStyle}
              >
                <ArrowUp size={iconSize} color={actionForeground} strokeWidth={2.5} />
              </Pressable>
            ) : null}
          </>
        ) : null}
      </View>
    </View>
  );
}

function overlayActionContent(
  labeled: boolean,
  label: string,
  Icon: LucideIcon,
  color: string,
  size: number,
) {
  return labeled ? (
    <Text style={[overlayStyles.actionLabel, { color }]}>{label}</Text>
  ) : (
    <Icon size={size} color={color} strokeWidth={2.5} />
  );
}

function DictationStatusText({
  status,
  errorText,
  fullText,
  style,
}: {
  status: DictationStatus;
  errorText?: string;
  fullText: boolean;
  style: React.ComponentProps<typeof Text>["style"];
}) {
  const { t } = useTranslation();
  let message: string;
  if (status === "paused") message = t("message.dictation.paused");
  else if (status === "failed") {
    message = errorText
      ? t("message.dictation.failed", { error: errorText })
      : t("message.dictation.failedRetry");
  } else return null;
  return (
    <Text numberOfLines={fullText ? undefined : 2} style={style}>
      {message}
    </Text>
  );
}

const BUTTON_SIZE = 32;

const styles = StyleSheet.create((theme) => ({
  micButton: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  activeContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  meterWrapper: {
    width: 80,
    alignItems: "center",
    justifyContent: "center",
  },
  timerText: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    fontVariant: ["tabular-nums"],
  },
  actionGroup: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  actionButton: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: theme.borderWidth[1],
  },
  actionButtonCancel: {
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  actionButtonSecondary: {
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  actionButtonConfirm: {
    borderColor: theme.colors.foreground,
    backgroundColor: theme.colors.foreground,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  loadingContainer: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  statusLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
}));

const OVERLAY_BUTTON_SIZE = 44;
const OVERLAY_VERTICAL_PADDING = (FOOTER_HEIGHT - OVERLAY_BUTTON_SIZE) / 2;

const overlayStyles = StyleSheet.create((theme) => ({
  compactContainer: {
    maxWidth: 280,
    height: "auto",
    minHeight: 38,
    paddingVertical: 4,
    paddingHorizontal: 8,
    gap: 8,
  },
  compactButton: { width: 29, height: 29 },
  labeledContainer: { height: "auto", minHeight: FOOTER_HEIGHT, paddingVertical: theme.spacing[3] },
  labeledButton: { width: "auto", paddingHorizontal: theme.spacing[3], flexShrink: 0 },
  actionLabel: { fontSize: theme.fontSize.sm, fontWeight: theme.fontWeight.semibold },
  container: {
    flexDirection: "row",
    alignItems: "center",
    width: "100%",
    borderRadius: theme.borderRadius["2xl"],
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: OVERLAY_VERTICAL_PADDING,
    height: FOOTER_HEIGHT,
  },
  cancelButton: {
    width: OVERLAY_BUTTON_SIZE,
    height: OVERLAY_BUTTON_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: "rgba(0, 0, 0, 0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  centerContainer: {
    flex: 1,
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
  },
  meterRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[4],
  },
  timerText: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
    fontVariant: ["tabular-nums"],
  },
  transcriptText: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    textAlign: "center",
    paddingHorizontal: theme.spacing[2],
    opacity: 0.9,
  },
  actionButtonsContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  actionButton: {
    width: OVERLAY_BUTTON_SIZE,
    height: OVERLAY_BUTTON_SIZE,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  loadingContainer: {
    width: OVERLAY_BUTTON_SIZE,
    height: OVERLAY_BUTTON_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
}));

const OVERLAY_ACCEPT_BUTTON_BG = { backgroundColor: "rgba(255, 255, 255, 0.25)" };
