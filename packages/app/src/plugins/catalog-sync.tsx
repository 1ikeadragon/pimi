import { useVoiceAudioEngineOptional } from "@/contexts/voice-context";
import { useEffect } from "react";
import type { DaemonClient } from "@pimi/client/internal/daemon-client";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { pluginRegistry } from "./registry";
import { syncPluginCatalog } from "./catalog-sync-model";

export function PluginCatalogSync({
  serverId,
  client,
}: {
  serverId: string;
  client: DaemonClient;
}) {
  const audio = useVoiceAudioEngineOptional();
  const connected = useHostRuntimeIsConnected(serverId);

  useEffect(
    () =>
      syncPluginCatalog({
        serverId,
        client,
        audio,
        connected,
        registry: pluginRegistry,
      }),
    [audio, client, connected, serverId],
  );

  useEffect(() => () => pluginRegistry.removeHost(serverId), [serverId]);
  return null;
}
