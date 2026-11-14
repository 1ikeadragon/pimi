import { Unmatched, useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import SettingsScreen from "@/screens/settings-screen";
import { isSettingsSectionSlug } from "@/utils/host-routes";

export default function SettingsSectionRoute() {
  const params = useLocalSearchParams<{ section?: string }>();
  const rawSection = typeof params.section === "string" ? params.section : "";
  const section = isSettingsSectionSlug(rawSection) ? rawSection : null;
  const view = useMemo(() => (section ? { kind: "section" as const, section } : null), [section]);

  if (!view) return <Unmatched />;

  return <SettingsScreen view={view} />;
}
