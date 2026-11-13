import { useClientStorage, type PluginSurfaceProps } from "@pimi/plugin/client";
import { SettingsCard, SettingsSection, SettingsSwitch } from "@pimi/plugin/client/ui";
import { useCallback } from "react";
import { setThrowFlag, useThrowFlag } from "./throw-flag";

export function OverridesSettings(_props: PluginSurfaceProps) {
  const storage = useClientStorage();
  const enabled = useThrowFlag();
  const change = useCallback((next: boolean) => void setThrowFlag(storage, next), [storage]);
  return (
    <SettingsSection title="UI Overrides">
      <SettingsCard>
        <SettingsSwitch
          label="Make the message bubble throw"
          hint="The bubble fails on purpose. Chat falls back to Pimi's own message, and the Plugins page lists the error."
          value={enabled}
          onValueChange={change}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
