import { useMemo } from "react";
import { Image, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AttachmentMetadata } from "@/attachments/types";
import { useAttachmentPreviewUrl } from "@/attachments/use-attachment-preview-url";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";

interface BrowserElementPreviewProps {
  tag: string;
  url: string;
  comment?: string;
  /** The element's description as the agent received it. */
  text: string;
  screenshot?: AttachmentMetadata | null;
  onClose: () => void;
}

/** The note, screenshot and description behind a browser element pill, in a modal or sheet. */
export function BrowserElementPreview({
  tag,
  url,
  comment,
  text,
  screenshot,
  onClose,
}: BrowserElementPreviewProps) {
  const header = useMemo(() => ({ title: `<${tag}> · ${url}` }), [tag, url]);
  const uri = useAttachmentPreviewUrl(screenshot);
  const source = useMemo(() => ({ uri: uri ?? "" }), [uri]);
  return (
    <AdaptiveModalSheet
      visible
      header={header}
      onClose={onClose}
      testID="browser-element-preview"
      desktopMaxWidth={680}
    >
      <ScrollView>
        <View style={styles.column}>
          {uri ? <Image source={source} style={styles.screenshot} resizeMode="contain" /> : null}
          {comment ? <Text style={styles.note}>{comment}</Text> : null}
          <Text selectable style={styles.text}>
            {text}
          </Text>
        </View>
      </ScrollView>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  column: {
    gap: theme.spacing[3],
  },
  screenshot: {
    width: "100%",
    height: 200,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  note: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: 22,
  },
  text: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
    lineHeight: 20,
  },
}));
