import { defaultWebSocketFactory } from "@pimi/client/internal/daemon-client-websocket-transport";
import type { WebSocketFactory } from "@pimi/client/internal/daemon-client-transport-types";

export function createAppWebSocketFactory(): WebSocketFactory {
  return defaultWebSocketFactory;
}
