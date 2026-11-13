import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Image, Text, View } from "react-native";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ImageOff } from "lucide-react-native";
import { useTranslation } from "@/i18n/use-translation";
import type { DaemonClient } from "@pimi/client/internal/daemon-client";
import type { AgentImageRef } from "@pimi/protocol/agent-types";
import type { AttachmentMetadata } from "@/attachments/types";
import { useAttachmentPreviewUrl } from "@/attachments/use-attachment-preview-url";
import { AttachmentLightbox } from "@/components/attachment-lightbox";
import { isWeb } from "@/constants/platform";
import { useAgentImages, type AgentImageSlot } from "@/hooks/use-agent-images";

const SINGLE_IMAGE_MAX_SIZE = 480;
const MAX_VISIBLE_TILES = 8;

export interface AgentImageGridItem {
  slot: AgentImageSlot;
  width?: number;
  height?: number;
}

interface AgentImageGridProps {
  items: readonly AgentImageGridItem[];
}

/**
 * Images from one message or tool result: a lone image at its own proportions up to 480px, two or
 * more in a two-column grid, and a "+N" tile past eight. Tapping one opens the lightbox.
 */
export const AgentImageGrid = memo(function AgentImageGrid({ items }: AgentImageGridProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const readyIndexes = useMemo(
    () =>
      items.flatMap((item, index) =>
        item.slot.state === "ready" || item.slot.state === "remote" ? [index] : [],
      ),
    [items],
  );
  const closeLightbox = useCallback(() => setOpenIndex(null), []);
  const step = useCallback(
    (direction: 1 | -1) => {
      setOpenIndex((current) => {
        if (current === null || readyIndexes.length === 0) return current;
        const position = readyIndexes.indexOf(current);
        const next = (position + direction + readyIndexes.length) % readyIndexes.length;
        return readyIndexes[next] ?? current;
      });
    },
    [readyIndexes],
  );
  const showPrevious = useCallback(() => step(-1), [step]);
  const showNext = useCallback(() => step(1), [step]);

  // The "+N" tile opens the first image it stands for, or the next one that can be shown.
  const openAt = useCallback(
    (index: number) => {
      const target = readyIndexes.find((ready) => ready >= index) ?? readyIndexes.at(-1);
      if (target !== undefined) setOpenIndex(target);
    },
    [readyIndexes],
  );

  const openSlot = openIndex === null ? null : items[openIndex]?.slot;
  const lightboxSource = useMemo(() => {
    if (openSlot?.state === "ready") {
      return { type: "attachment" as const, metadata: openSlot.metadata };
    }
    return openSlot?.state === "remote" ? { type: "uri" as const, uri: openSlot.uri } : null;
  }, [openSlot]);

  if (items.length === 0) return null;
  const single = items.length === 1;
  const visible = items.slice(0, MAX_VISIBLE_TILES);
  const overflow = items.length - visible.length;

  return (
    <View style={single ? styles.single : styles.grid}>
      {visible.map((item, index) => (
        <ImageTile
          // Positions are the identity: refs repeat when the same screenshot appears twice.
          // eslint-disable-next-line react/no-array-index-key
          key={index}
          index={index}
          item={item}
          single={single}
          onOpen={openAt}
        />
      ))}
      {overflow > 0 ? <MoreTile count={overflow} index={visible.length} onOpen={openAt} /> : null}
      <AttachmentLightbox
        source={lightboxSource}
        onClose={closeLightbox}
        onPrevious={readyIndexes.length > 1 ? showPrevious : undefined}
        onNext={readyIndexes.length > 1 ? showNext : undefined}
      />
    </View>
  );
});

interface ImageTileProps {
  index: number;
  item: AgentImageGridItem;
  single: boolean;
  onOpen: (index: number) => void;
}

function ImageTile({ index, item, single, onOpen }: ImageTileProps) {
  const { t } = useTranslation();
  const { slot } = item;
  const metadata: AttachmentMetadata | null = slot.state === "ready" ? slot.metadata : null;
  const uri = useAttachmentPreviewUrl(metadata);
  const source = useMemo(() => ({ uri: uri ?? "" }), [uri]);
  const handlePress = useCallback(() => onOpen(index), [index, onOpen]);
  const remoteUri = slot.state === "remote" ? slot.uri : null;
  const [remoteFailed, setRemoteFailed] = useState(false);
  const handleRemoteError = useCallback(() => setRemoteFailed(true), []);
  // A new URL gets a fresh attempt.
  useEffect(() => setRemoteFailed(false), [remoteUri]);
  const remoteSource = useMemo(() => (remoteUri ? { uri: remoteUri } : null), [remoteUri]);

  const aspectRatio = tileAspectRatio(item, single);
  const frameStyle = useMemo(
    () => [
      styles.tile,
      single
        ? [styles.singleTile, { aspectRatio, ...singleTileSize(aspectRatio) }]
        : styles.gridTile,
    ],
    [aspectRatio, single],
  );

  if (slot.state === "ready") {
    return (
      <PressHighlight
        accessibilityRole="button"
        accessibilityLabel={t("composer.attachments.openImage")}
        onPress={handlePress}
        style={frameStyle}
      >
        {uri ? (
          <Image source={source} style={styles.image} resizeMode={single ? "contain" : "cover"} />
        ) : null}
      </PressHighlight>
    );
  }

  if (slot.state === "remote" && !remoteFailed && remoteSource) {
    return (
      <PressHighlight
        accessibilityRole="button"
        accessibilityLabel={t("composer.attachments.openImage")}
        onPress={handlePress}
        style={frameStyle}
      >
        <Image
          source={remoteSource}
          style={styles.image}
          resizeMode={single ? "contain" : "cover"}
          onError={handleRemoteError}
        />
      </PressHighlight>
    );
  }

  const labelKey =
    slot.state === "remote"
      ? "message.attachments.imageUnavailable"
      : PLACEHOLDER_LABELS[slot.state];
  return (
    <View style={[frameStyle, styles.placeholder]} testID={`agent-image-${slot.state}`}>
      {slot.state === "loading" ? null : (
        <>
          <ThemedImageOff size={18} />
          <Text style={styles.placeholderText}>{t(labelKey)}</Text>
        </>
      )}
    </View>
  );
}

const ThemedImageOff = withUnistyles(ImageOff, (theme) => ({
  color: theme.colors.foregroundMuted,
}));

const PLACEHOLDER_LABELS = {
  loading: "message.attachments.imageUnavailable",
  missing: "message.attachments.imageUnavailable",
  too_large: "message.attachments.imageTooLarge",
  unsupported: "message.attachments.imageUnsupported",
} as const;

function tileAspectRatio(item: AgentImageGridItem, single: boolean): number {
  if (!single) return 1;
  if (item.width && item.height) return Math.min(Math.max(item.width / item.height, 0.25), 4);
  return 4 / 3;
}

function singleTileSize(aspectRatio: number): { width: number } {
  // Fit inside a 480x480 box: wide images fill the width, tall ones shrink to keep the height cap.
  return { width: Math.min(SINGLE_IMAGE_MAX_SIZE, SINGLE_IMAGE_MAX_SIZE * aspectRatio) };
}

function MoreTile({
  count,
  index,
  onOpen,
}: {
  count: number;
  index: number;
  onOpen: (index: number) => void;
}) {
  const handlePress = useCallback(() => onOpen(index), [index, onOpen]);
  return (
    <PressHighlight
      accessibilityRole="button"
      onPress={handlePress}
      style={[styles.tile, styles.gridTile, styles.placeholder]}
      testID="agent-image-more"
    >
      <Text style={styles.moreText}>{`+${count}`}</Text>
    </PressHighlight>
  );
}

interface AgentImageRefsGridProps {
  client: DaemonClient | null | undefined;
  agentId: string | undefined;
  refs: readonly AgentImageRef[];
}

/** Fetches `refs` once the row is on screen, then shows them in a grid. */
export const AgentImageRefsGrid = memo(function AgentImageRefsGrid({
  client,
  agentId,
  refs,
}: AgentImageRefsGridProps) {
  const [containerRef, inView] = useInView();
  const slots = useAgentImages(client, agentId, refs, inView);
  const items = useMemo<AgentImageGridItem[]>(
    () =>
      refs.map((ref, index) => ({
        slot: slots[index] ?? { state: "loading" },
        width: ref.width,
        height: ref.height,
      })),
    [refs, slots],
  );
  return (
    <View ref={containerRef} style={styles.row} testID="assistant-images">
      <AgentImageGrid items={items} />
    </View>
  );
});

/** True once the element has been near the viewport. Native lists only mount rows near it. */
function useInView(): [RefObject<View | null>, boolean] {
  const ref = useRef<View | null>(null);
  const [inView, setInView] = useState(!isWeb);
  useEffect(() => {
    if (!isWeb || inView) return;
    const element = ref.current as unknown as Element | null;
    if (!element || typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: "300px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [inView]);
  return [ref, inView];
}

const styles = StyleSheet.create((theme) => ({
  row: {
    width: "100%",
    maxWidth: SINGLE_IMAGE_MAX_SIZE * 2 + theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  single: {
    alignSelf: "flex-start",
    maxWidth: "100%",
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    width: "100%",
    maxWidth: SINGLE_IMAGE_MAX_SIZE * 2 + theme.spacing[2],
  },
  tile: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
  },
  singleTile: {
    maxWidth: "100%",
    maxHeight: SINGLE_IMAGE_MAX_SIZE,
  },
  gridTile: {
    // Two tiles and the gap must fit one row down to phone widths; 49% wraps below 400px.
    width: "48%",
    aspectRatio: 1,
  },
  image: {
    width: "100%",
    height: "100%",
  },
  placeholder: {
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    padding: theme.spacing[2],
    minHeight: 96,
  },
  placeholderText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  moreText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xl,
  },
}));
