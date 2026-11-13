import { useCallback, useSyncExternalStore, type ComponentType } from "react";
import type { PluginSlotId, PluginSlots } from "@pimi/plugin/client";
import { LayerBoundary } from "./boundary";
import { extensionRegistry } from "./registry";

/**
 * Renders the plugin items registered for a slot, in order, each in its own error boundary.
 * Renders nothing, and subscribes to nothing but this slot, when no plugin adds to it.
 */
export function Slot<Id extends PluginSlotId>({
  id,
  context,
}: {
  id: Id;
  context: PluginSlots[Id];
}) {
  const subscribe = useCallback(
    (listener: () => void) => extensionRegistry.subscribeSlot(id, listener),
    [id],
  );
  const getSnapshot = useCallback(() => extensionRegistry.getSlotItems(id), [id]);
  const items = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (items.length === 0) return null;
  return (
    <>
      {items.map((item) => {
        const Item = item.Component as ComponentType<Record<string, unknown>>;
        return (
          <LayerBoundary key={item.key} owner={item.owner} point={`slot:${id}`} fallback={null}>
            <Item {...(context as Record<string, unknown>)} />
          </LayerBoundary>
        );
      })}
    </>
  );
}
