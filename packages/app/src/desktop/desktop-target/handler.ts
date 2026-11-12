import type { DaemonClient } from "@pimi/client/internal/daemon-client";
import type { SessionInboundMessage, SessionOutboundMessage } from "@pimi/protocol/messages";
import { getDesktopHost } from "@/desktop/host";

type ExecuteRequest = Extract<SessionOutboundMessage, { type: "desktop.target.execute.request" }>;
type ExecuteResponse = Extract<SessionInboundMessage, { type: "desktop.target.execute.response" }>;

/**
 * Registers this app as the host of `desktop_*` agent tools and forwards each request to the
 * main process, which enforces the run's window guard. The app adds no rule of its own.
 */
export function mountDesktopTargetDaemonClientHandler(client: DaemonClient): () => void {
  const observation = client.registerDesktopHost({ hostKind: "desktop app" });
  const unsubscribe = observation.subscribe({
    snapshot: () => {},
    update: (message) => {
      if (message.type !== "desktop.target.execute.request") return;
      void handle(client, message);
    },
  });
  return () => {
    unsubscribe();
    void observation
      .release()
      .catch((error) => console.warn("Failed to release desktop host", error));
  };
}

async function handle(client: DaemonClient, request: ExecuteRequest): Promise<void> {
  const respond = (payload: ExecuteResponse["payload"]) =>
    client.sendDesktopTargetExecuteResponse({
      type: "desktop.target.execute.response",
      payload,
    });
  const bridge = getDesktopHost()?.desktopTarget;
  if (!bridge) {
    respond({
      requestId: request.requestId,
      ok: false,
      error: { code: "unsupported", message: "Desktop targets are not available in this app." },
    });
    return;
  }
  try {
    respond(await bridge.execute(request));
  } catch (error) {
    respond({
      requestId: request.requestId,
      ok: false,
      error: { code: "failed", message: error instanceof Error ? error.message : String(error) },
    });
  }
}
