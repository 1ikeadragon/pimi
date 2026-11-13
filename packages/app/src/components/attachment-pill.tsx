import { type ReactNode, useCallback, useMemo, useState } from "react";
import { Image, Pressable, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { X } from "lucide-react-native";
import { isNative } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { AttachmentMetadata } from "@/attachments/types";
import { useAttachmentPreviewUrl } from "@/attachments/use-attachment-preview-url";
import { ChipRemovalContext, InlineChip } from "@/components/ui/chip/inline-chip";
import type { Theme } from "@/styles/theme";

// Every attachment pill body — image thumbnail or labelled — renders at this
// height so mixed attachment trays line up.
const ATTACHMENT_CONTENT_HEIGHT = 48;

interface AttachmentPillProps {
  onOpen: () => void;
  onRemove: () => void;
  openAccessibilityLabel: string;
  removeAccessibilityLabel: string;
  disabled?: boolean;
  testID?: string;
  /** Images keep a floating remove button over their thumbnail; everything else is a chip. */
  kind?: "chip" | "thumbnail";
  /** Set by a host that already tracks hover, so the pill does not track it twice. */
  hovered?: boolean;
  children: ReactNode;
}

export function AttachmentPill({
  onOpen,
  onRemove,
  openAccessibilityLabel,
  removeAccessibilityLabel,
  disabled = false,
  testID,
  kind = "chip",
  hovered,
  children,
}: AttachmentPillProps) {
  const isCompact = useIsCompactFormFactor();
  const [isBodyHovered, setIsBodyHovered] = useState(false);
  const [isCloseHovered, setIsCloseHovered] = useState(false);
  const isHovered = hovered ?? isBodyHovered;
  const showRemove = isNative || isCompact || isHovered || isCloseHovered;
  const closeButtonStyle = useMemo(
    () => [styles.closeButton, !showRemove && styles.closeButtonHidden],
    [showRemove],
  );
  const handleBodyHoverIn = useCallback(() => setIsBodyHovered(true), []);
  const handleBodyHoverOut = useCallback(() => setIsBodyHovered(false), []);
  const handleCloseHoverIn = useCallback(() => setIsCloseHovered(true), []);
  const handleCloseHoverOut = useCallback(() => setIsCloseHovered(false), []);
  const removal = useMemo(
    () => ({
      hovered: isHovered,
      disabled,
      label: removeAccessibilityLabel,
      onRemove,
    }),
    [disabled, isHovered, onRemove, removeAccessibilityLabel],
  );
  const body = (
    <Pressable
      testID={testID}
      onPress={onOpen}
      disabled={disabled}
      onHoverIn={handleBodyHoverIn}
      onHoverOut={handleBodyHoverOut}
      accessibilityRole="button"
      accessibilityLabel={openAccessibilityLabel}
      style={kind === "thumbnail" ? styles.frame : undefined}
    >
      {children}
    </Pressable>
  );
  if (kind === "chip") {
    return <ChipRemovalContext.Provider value={removal}>{body}</ChipRemovalContext.Provider>;
  }
  return (
    <View style={styles.wrapper}>
      {body}
      <Pressable
        onPress={onRemove}
        disabled={disabled}
        onHoverIn={handleCloseHoverIn}
        onHoverOut={handleCloseHoverOut}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={removeAccessibilityLabel}
        style={closeButtonStyle}
      >
        <ThemedX size={12} uniProps={iconForegroundMutedMapping} />
      </Pressable>
    </View>
  );
}

interface AttachmentFrameProps {
  onPress?: () => void;
  accessibilityLabel?: string;
  testID?: string;
  children: ReactNode;
}

/** Press target for a chip on read-only surfaces (sent messages) — no remove button. */
export function AttachmentFrame({
  onPress,
  accessibilityLabel,
  testID,
  children,
}: AttachmentFrameProps) {
  if (!onPress) {
    return <View testID={testID}>{children}</View>;
  }
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      {children}
    </Pressable>
  );
}

interface AttachmentLabelProps {
  icon: ReactNode;
  title: string;
}

/** The chip body for an attachment that is named rather than pictured. */
export function AttachmentLabel({ icon, title }: AttachmentLabelProps) {
  return <InlineChip icon={icon} label={title} size="tray" />;
}

/** Square image preview pill body. */
export function AttachmentThumbnail({ metadata }: { metadata: AttachmentMetadata }) {
  const uri = useAttachmentPreviewUrl(metadata);
  const source = useMemo(() => ({ uri: uri ?? "" }), [uri]);
  if (!uri) {
    return <View style={styles.thumbnailPlaceholder} />;
  }
  return <Image source={source} style={styles.thumbnail} />;
}

const ThemedX = withUnistyles(X);
const iconForegroundMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const styles = StyleSheet.create((theme) => ({
  wrapper: {
    position: "relative",
  },
  frame: {
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    overflow: "hidden",
  },
  thumbnail: {
    width: ATTACHMENT_CONTENT_HEIGHT,
    height: ATTACHMENT_CONTENT_HEIGHT,
  },
  thumbnailPlaceholder: {
    width: ATTACHMENT_CONTENT_HEIGHT,
    height: ATTACHMENT_CONTENT_HEIGHT,
    backgroundColor: theme.colors.surface1,
  },
  closeButton: {
    position: "absolute",
    top: -8,
    left: -8,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1,
  },
  closeButtonHidden: {
    opacity: 0,
    pointerEvents: "none",
  },
}));
