// Pimi. PolyForm-Noncommercial-1.0.0.
// A review thread on the Conversation tab: where it sits, its comments in order, and what the
// reader can do with it. A resolved thread folds to one line until pressed. Reply and resolve
// write through `write/`; the rest of the actions are local.
import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { ChevronDown, ChevronRight, ExternalLink, Link, MoreHorizontal } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "@/i18n/use-translation";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/contexts/toast-context";
import { ActivityHeader } from "@/git/pull-request-panel/activity-kit";
import type { PrThreadEntry } from "@/git/pull-request-panel/timeline";
import type { Theme } from "@/styles/theme";
import { openExternalUrl } from "@/utils/open-external-url";
import { requestReviewFix } from "../agent-actions/fix-request";
import type { ReviewJumpTo } from "../types";
import { ResolveButton, ThreadReply } from "../write/thread-write";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedMore = withUnistyles(MoreHorizontal);
const ThemedExternalLink = withUnistyles(ExternalLink);
const ThemedLink = withUnistyles(Link);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const OPEN_ICON = <ThemedExternalLink size={14} uniProps={mutedMapping} />;
const LINK_ICON = <ThemedLink size={14} uniProps={mutedMapping} />;

function onLinkPress(url: string): boolean {
  void openExternalUrl(url);
  return false;
}

export function ThreadCard({
  entry,
  nested,
  brandLabel,
  onJumpTo,
}: {
  entry: PrThreadEntry;
  /** Inside a review block: a hairline above instead of a border of its own. */
  nested: boolean;
  brandLabel: string;
  onJumpTo: ReviewJumpTo;
}) {
  const { t } = useTranslation();
  const resolved = entry.isResolved === true;
  const outdated = entry.location?.isOutdated === true;
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  // Resolving from the card leaves it open; it folds on the next press of its header.
  const keepOpen = useCallback(() => setOpen(true), []);
  const location = entry.location
    ? `${entry.location.path}${entry.location.line ? `:${entry.location.line}` : ""}`
    : t("reviewScreen.conversation.generalDiscussion");
  const folded = resolved && !open;
  const Chevron = folded ? ThemedChevronRight : ThemedChevronDown;

  return (
    <View style={nested ? styles.nested : styles.block} testID={`review-thread-${entry.id}`}>
      <PressHighlight
        onPress={resolved ? toggle : undefined}
        disabled={!resolved}
        accessibilityRole={resolved ? "button" : undefined}
        style={styles.head}
      >
        {resolved ? <Chevron size={14} uniProps={mutedMapping} /> : null}
        <Text style={styles.location} numberOfLines={1} ellipsizeMode="head">
          {location}
        </Text>
        {resolved ? (
          <StatusBadge
            size="xs"
            variant="success"
            label={t("reviewScreen.conversation.resolved")}
          />
        ) : null}
        {outdated ? (
          <StatusBadge
            size="xs"
            variant="warning"
            label={t("reviewScreen.conversation.outdated")}
          />
        ) : null}
        {folded ? (
          <Text style={styles.count}>
            {t("reviewScreen.conversation.comments", { count: entry.comments.length })}
          </Text>
        ) : null}
      </PressHighlight>
      {folded ? null : (
        <>
          <ThreadComments entry={entry} />
          <ThreadReply entryId={entry.id} />
          <ThreadActions
            entry={entry}
            brandLabel={brandLabel}
            onJumpTo={onJumpTo}
            onResolveToggle={keepOpen}
          />
        </>
      )}
    </View>
  );
}

/** Every comment of a thread in order, in full. */
export function ThreadComments({ entry }: { entry: PrThreadEntry }) {
  return (
    <>
      {entry.comments.map((comment, index) => (
        <View key={comment.id} style={index === 0 ? styles.comment : styles.reply}>
          <View style={styles.commentHead}>
            <ActivityHeader activity={comment} avatarSize={16} />
          </View>
          <MarkdownRenderer text={comment.body} compact onLinkPress={onLinkPress} />
        </View>
      ))}
    </>
  );
}

function ThreadActions({
  entry,
  brandLabel,
  onJumpTo,
  onResolveToggle,
}: {
  entry: PrThreadEntry;
  brandLabel: string;
  onJumpTo: ReviewJumpTo;
  onResolveToggle: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const path = entry.location?.path ?? null;
  const line = entry.location?.line ?? null;
  const url = entry.comments[0]?.url ?? null;
  const fix = useCallback(
    () => requestReviewFix({ threadIds: [entry.id], checkKeys: [] }),
    [entry.id],
  );
  const openInFiles = useCallback(() => {
    if (path) onJumpTo(path, line);
  }, [line, onJumpTo, path]);
  const openOnForge = useCallback(() => {
    if (url) void openExternalUrl(url);
  }, [url]);
  const copyLink = useCallback(() => {
    if (!url) return;
    void Clipboard.setStringAsync(url).then(
      () => toast.copied(t("reviewScreen.link")),
      () => toast.error(t("common.errors.unableToCopy")),
    );
  }, [t, toast, url]);
  return (
    <View style={styles.actions}>
      <ResolveButton
        entryId={entry.id}
        resolved={entry.isResolved === true}
        onToggle={onResolveToggle}
      />
      <Button size="sm" variant="outline" onPress={fix} testID={`review-fix-${entry.id}`}>
        {t("reviewScreen.conversation.fixThis")}
      </Button>
      {path ? (
        <Button
          size="sm"
          variant="ghost"
          onPress={openInFiles}
          testID={`review-open-files-${entry.id}`}
        >
          {t("reviewScreen.conversation.openInFiles")}
        </Button>
      ) : null}
      {url ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            hitSlop={8}
            accessibilityLabel={t("reviewScreen.moreActions")}
            style={styles.kebab}
          >
            <ThemedMore size={14} uniProps={mutedMapping} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" width={220}>
            <DropdownMenuItem leading={OPEN_ICON} onSelect={openOnForge}>
              {t("reviewScreen.openOn", { brand: brandLabel })}
            </DropdownMenuItem>
            <DropdownMenuItem leading={LINK_ICON} onSelect={copyLink}>
              {t("reviewScreen.copyLink")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  block: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
  },
  nested: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    marginLeft: theme.spacing[4],
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
  },
  location: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
  count: {
    marginLeft: "auto",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  comment: { gap: theme.spacing[2], padding: theme.spacing[3] },
  reply: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  commentHead: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  kebab: {
    marginLeft: "auto",
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
  },
}));
