import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { RecapNarrative } from "@pimi/protocol/recap";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n/use-translation";

interface WriteState {
  pending: boolean;
  error: string | null;
  onWrite: () => void;
}

/**
 * The top of Recap: the archetype once a narrative exists, otherwise what writing one does. The
 * card keeps its place in both states so writing does not move the questions below it.
 */
export function RecapProfile({
  narrative,
  write,
}: {
  narrative: RecapNarrative | null;
  write: WriteState;
}) {
  const { t, i18n } = useTranslation();
  const written = narrative
    ? new Intl.DateTimeFormat(i18n.resolvedLanguage, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(narrative.generatedAt))
    : null;
  const byline = narrative?.model
    ? t("usageRecap.profile.writtenBy", { model: narrative.model, time: written })
    : t("usageRecap.profile.writtenAt", { time: written });
  return (
    <View style={styles.card} testID="recap-profile">
      <Text style={styles.cardTitle}>{t("usageRecap.profile.title")}</Text>
      {narrative ? (
        <>
          <Text style={styles.archetype} testID="recap-archetype">
            {narrative.archetype.name}
          </Text>
          <Text style={styles.body}>{narrative.archetype.description}</Text>
        </>
      ) : (
        <Text style={styles.muted}>{t("usageRecap.profile.hint")}</Text>
      )}
      <View style={styles.actions}>
        <Button
          variant={narrative ? "outline" : "default"}
          loading={write.pending}
          disabled={write.pending}
          onPress={write.onWrite}
          testID="recap-write"
        >
          {write.pending
            ? t("usageRecap.profile.writing")
            : t(narrative ? "usageRecap.profile.rewrite" : "usageRecap.profile.write")}
        </Button>
        {narrative ? <Text style={styles.muted}>{byline}</Text> : null}
      </View>
      {write.error ? (
        <Text style={styles.error} testID="recap-write-error">
          {t("usageRecap.profile.writeError", { message: write.error })}
        </Text>
      ) : null}
    </View>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Bullets({ items }: { items: readonly string[] }) {
  return (
    <View style={styles.list}>
      {items.map((item) => (
        <View key={item} style={styles.bullet}>
          <Text style={styles.dot}>•</Text>
          <Text style={styles.bulletText}>{item}</Text>
        </View>
      ))}
    </View>
  );
}

/** The written half of Recap: story, what was built, decision patterns, strengths, growth. */
export function RecapNarrativeSections({ narrative }: { narrative: RecapNarrative }) {
  const { t } = useTranslation();
  return (
    <View style={styles.sections} testID="recap-narrative">
      <Section title={t("usageRecap.sections.story")}>
        <Text style={styles.body}>{narrative.story}</Text>
      </Section>
      {narrative.built.length > 0 ? (
        <Section title={t("usageRecap.sections.built")}>
          <Bullets items={narrative.built} />
        </Section>
      ) : null}
      {narrative.patterns.length > 0 ? (
        <Section title={t("usageRecap.sections.patterns")}>
          <View style={styles.list}>
            {narrative.patterns.map((pattern) => (
              <View key={pattern.name} style={styles.pattern}>
                <Text style={styles.patternName}>{pattern.name}</Text>
                <Text style={styles.muted}>{pattern.description}</Text>
              </View>
            ))}
          </View>
        </Section>
      ) : null}
      {narrative.strengths.length > 0 ? (
        <Section title={t("usageRecap.sections.strengths")}>
          <Bullets items={narrative.strengths} />
        </Section>
      ) : null}
      {narrative.growth.length > 0 ? (
        <Section title={t("usageRecap.sections.growth")}>
          <Bullets items={narrative.growth} />
        </Section>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  sections: { gap: theme.spacing[4] },
  card: {
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.borderRadius.xl,
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  cardTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  archetype: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize["2xl"],
    fontWeight: theme.fontWeight.semibold,
  },
  body: { color: theme.colors.foreground, fontSize: theme.fontSize.content },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.palette.red[300], fontSize: theme.fontSize.sm },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  list: { gap: theme.spacing[2] },
  bullet: { flexDirection: "row", gap: theme.spacing[2] },
  dot: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.content },
  bulletText: { flex: 1, color: theme.colors.foreground, fontSize: theme.fontSize.content },
  pattern: { gap: theme.spacing[1] },
  patternName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
}));
