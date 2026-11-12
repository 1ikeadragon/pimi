// Pimi. Apache-2.0.
// Stream S4: CI checks as rows inside a card. Failed first, then running, then passed and skipped
// collapsed; shards of one job fold into one group; a failing check expands to its log tail and
// annotations (`get_check_details`). Shared by the Overview Checks card and the inspector.
import { useCallback, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react-native";
import { PressHighlight } from "@/components/ui/press-highlight";
import { Button } from "@/components/ui/button";
import { CheckPresentationIcon } from "@/git/check-presentation.view";
import { settingsStyles } from "@/styles/settings";
import { openExternalUrl } from "@/utils/open-external-url";
import type { Theme } from "@/styles/theme";
import { requestReviewFix } from "../agent-actions/fix-request";
import type { ReviewJumpTo, ReviewSelection, ReviewSource } from "../types";
import {
  isAttention,
  useReviewCheckDetails,
  type ReviewCheck,
  type ReviewCheckGroup,
  type ReviewCheckSection,
} from "../use-review-timeline";
import { SelectionBox, toggleInSet } from "./selection-box";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const SECTION_TITLE: Record<ReviewCheckSection["id"], string> = {
  attention: "Failed",
  running: "Running",
  passed: "Passed",
  skipped: "Skipped",
};

export function CheckSections({
  source,
  sections,
  selection,
  onSelectionChange,
  onJumpTo,
}: {
  source: ReviewSource;
  sections: readonly ReviewCheckSection[];
  selection: ReviewSelection;
  onSelectionChange: (next: ReviewSelection) => void;
  onJumpTo: ReviewJumpTo;
}) {
  return (
    <>
      {sections.map((section, index) => (
        <SectionBlock
          key={section.id}
          source={source}
          section={section}
          first={index === 0}
          selection={selection}
          onSelectionChange={onSelectionChange}
          onJumpTo={onJumpTo}
        />
      ))}
    </>
  );
}

function SectionBlock({
  source,
  section,
  first,
  selection,
  onSelectionChange,
  onJumpTo,
}: {
  source: ReviewSource;
  section: ReviewCheckSection;
  first: boolean;
  selection: ReviewSelection;
  onSelectionChange: (next: ReviewSelection) => void;
  onJumpTo: ReviewJumpTo;
}) {
  // Failed and running stay open; what needs no attention is one tap away.
  const [open, setOpen] = useState(section.id === "attention" || section.id === "running");
  const toggle = useCallback(() => setOpen((value) => !value), []);
  const Chevron = open ? ThemedChevronDown : ThemedChevronRight;
  return (
    <View
      style={first ? undefined : settingsStyles.rowBorder}
      testID={`review-checks-${section.id}`}
    >
      <PressHighlight style={styles.sectionHead} onPress={toggle} accessibilityRole="button">
        <Chevron size={14} uniProps={mutedColor} />
        <Text style={styles.sectionTitle}>
          {SECTION_TITLE[section.id]} <Text style={styles.count}>{section.count}</Text>
        </Text>
      </PressHighlight>
      {open
        ? section.groups.map((group) => (
            <GroupRow
              key={group.key}
              source={source}
              group={group}
              selection={selection}
              onSelectionChange={onSelectionChange}
              onJumpTo={onJumpTo}
            />
          ))
        : null}
    </View>
  );
}

function GroupRow({
  source,
  group,
  selection,
  onSelectionChange,
  onJumpTo,
}: {
  source: ReviewSource;
  group: ReviewCheckGroup;
  selection: ReviewSelection;
  onSelectionChange: (next: ReviewSelection) => void;
  onJumpTo: ReviewJumpTo;
}) {
  const [open, setOpen] = useState(isAttention(group.presentation));
  const toggle = useCallback(() => setOpen((value) => !value), []);
  const only = group.checks[0];
  if (group.checks.length === 1 && only) {
    return (
      <CheckRow
        source={source}
        check={only}
        selection={selection}
        onSelectionChange={onSelectionChange}
        onJumpTo={onJumpTo}
      />
    );
  }
  const Chevron = open ? ThemedChevronDown : ThemedChevronRight;
  return (
    <View testID={`review-check-group-${group.label}`}>
      <PressHighlight style={styles.row} onPress={toggle} accessibilityRole="button">
        <Chevron size={14} uniProps={mutedColor} />
        <CheckPresentationIcon presentation={group.presentation} size={16} />
        <View style={styles.rowMain}>
          <Text style={styles.name} numberOfLines={1}>
            {group.label}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {[group.workflow, `${group.checks.length} jobs`].filter(Boolean).join(" · ")}
          </Text>
        </View>
      </PressHighlight>
      {open ? (
        <View style={styles.nested}>
          {group.checks.map((check) => (
            <CheckRow
              key={check.key}
              source={source}
              check={check}
              selection={selection}
              onSelectionChange={onSelectionChange}
              onJumpTo={onJumpTo}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function CheckRow({
  source,
  check,
  selection,
  onSelectionChange,
  onJumpTo,
}: {
  source: ReviewSource;
  check: ReviewCheck;
  selection: ReviewSelection;
  onSelectionChange: (next: ReviewSelection) => void;
  onJumpTo: ReviewJumpTo;
}) {
  const failing = isAttention(check.presentation);
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  const fix = useCallback(
    () => requestReviewFix({ threadIds: [], checkKeys: [check.key] }),
    [check.key],
  );
  const openOnForge = useCallback(() => void openExternalUrl(check.url), [check.url]);
  const toggleSelected = useCallback(
    () => onSelectionChange({ ...selection, checks: toggleInSet(selection.checks, check.key) }),
    [check.key, onSelectionChange, selection],
  );
  const expandable = failing && check.hasDetails;
  const Chevron = open ? ThemedChevronDown : ThemedChevronRight;
  return (
    <View testID={`review-check-${check.key}`}>
      <View style={styles.row}>
        {failing ? (
          <SelectionBox
            checked={selection.checks.has(check.key)}
            onToggle={toggleSelected}
            label={`Select ${check.name}`}
          />
        ) : null}
        <PressHighlight
          style={styles.rowPress}
          onPress={expandable ? toggle : openOnForge}
          accessibilityRole="button"
        >
          {expandable ? (
            <Chevron size={14} uniProps={mutedColor} />
          ) : (
            <View style={styles.chevronSlot} />
          )}
          <CheckPresentationIcon presentation={check.presentation} size={16} />
          <View style={styles.rowMain}>
            <Text style={styles.name} numberOfLines={1}>
              {check.name}
            </Text>
            <Text style={styles.meta} numberOfLines={1}>
              {[check.workflow, check.duration].filter(Boolean).join(" · ")}
            </Text>
          </View>
        </PressHighlight>
        {failing ? (
          <Button size="sm" variant="outline" onPress={fix} testID={`review-fix-${check.key}`}>
            Fix this
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          leftIcon={ExternalLink}
          onPress={openOnForge}
          accessibilityLabel={`Open ${check.name}`}
        />
      </View>
      {open ? <CheckDetails source={source} check={check} onJumpTo={onJumpTo} /> : null}
    </View>
  );
}

interface AnnotationRowData {
  key: string;
  path: string | null;
  line: number | null;
  where: string | null;
  text: string;
}

function annotationRows(
  annotations: NonNullable<ReturnType<typeof useReviewCheckDetails>["data"]>["annotations"],
): AnnotationRowData[] {
  const seen = new Map<string, number>();
  return annotations.map((annotation) => {
    const where = annotation.path
      ? `${annotation.path}${annotation.startLine ? `:${annotation.startLine}` : ""}`
      : null;
    const text = `${annotation.annotationLevel ? `${annotation.annotationLevel} ` : ""}${annotation.message ?? annotation.title ?? ""}`;
    const base = `${where ?? "none"}|${text}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return {
      key: `${base}#${count}`,
      path: annotation.path ?? null,
      line: annotation.startLine ?? null,
      where,
      text,
    };
  });
}

function AnnotationRow({ row, onJumpTo }: { row: AnnotationRowData; onJumpTo: ReviewJumpTo }) {
  const press = useCallback(() => {
    if (row.path) onJumpTo(row.path, row.line);
  }, [onJumpTo, row.line, row.path]);
  return (
    <PressHighlight disabled={!row.path} onPress={press}>
      <Text style={styles.annotation}>
        {row.where ? <Text style={styles.annotationPath}>{row.where} </Text> : null}
        {row.text}
      </Text>
    </PressHighlight>
  );
}

function CheckDetails({
  source,
  check,
  onJumpTo,
}: {
  source: ReviewSource;
  check: ReviewCheck;
  onJumpTo: ReviewJumpTo;
}) {
  const query = useReviewCheckDetails(source, check, true);
  // The cause of a failure is at the end of the log, so the tail opens scrolled to its last line.
  const logRef = useRef<ScrollView>(null);
  const scrollLogToEnd = useCallback(() => logRef.current?.scrollToEnd({ animated: false }), []);
  const details = query.data;
  if (query.isPending) return <Text style={styles.detailNote}>Loading log…</Text>;
  if (query.error) return <Text style={styles.detailError}>{query.error.message}</Text>;
  if (!details) return <Text style={styles.detailNote}>No details for this check.</Text>;
  const outputTitle = details.output?.title?.trim();
  return (
    <View style={styles.details} testID={`review-check-details-${check.key}`}>
      {outputTitle ? <Text style={styles.detailTitle}>{outputTitle}</Text> : null}
      {details.annotations.length > 0 ? (
        <View style={styles.annotations}>
          <Text style={styles.meta}>Annotations</Text>
          {annotationRows(details.annotations).map((row) => (
            <AnnotationRow key={row.key} row={row} onJumpTo={onJumpTo} />
          ))}
        </View>
      ) : null}
      {details.failedJobs.map((job) => (
        <View key={job.jobId} style={styles.job}>
          <Text style={styles.meta}>
            {job.name} · {job.conclusion ?? job.status ?? "unknown"}
            {job.logTruncated ? " · log tail" : ""}
          </Text>
          {job.logTail ? (
            <ScrollView
              ref={logRef}
              style={styles.log}
              nestedScrollEnabled
              onContentSizeChange={scrollLogToEnd}
            >
              <ScrollView horizontal nestedScrollEnabled>
                <Text style={styles.logText} selectable>
                  {job.logTail}
                </Text>
              </ScrollView>
            </ScrollView>
          ) : (
            <Text style={styles.detailNote}>No log available.</Text>
          )}
        </View>
      ))}
      {details.annotations.length === 0 && details.failedJobs.length === 0 && !outputTitle ? (
        <Text style={styles.detailNote}>The forge reported no log or annotations.</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  sectionHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  count: { color: theme.colors.foregroundMuted, fontWeight: theme.fontWeight.normal },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    minHeight: 40,
  },
  rowPress: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  chevronSlot: { width: 14 },
  rowMain: { flex: 1, minWidth: 0 },
  name: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  meta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  nested: { paddingLeft: theme.spacing[6] },
  details: {
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[3],
    paddingLeft: theme.spacing[4] + 30,
  },
  detailTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  detailNote: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[3],
  },
  detailError: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[3],
  },
  annotations: { gap: theme.spacing[1] },
  annotation: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  annotationPath: { color: theme.colors.foregroundMuted, fontFamily: theme.fontFamily.mono },
  job: { gap: theme.spacing[1] },
  log: {
    maxHeight: 240,
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing[3],
  },
  logText: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
}));
