import type { DaemonTarget } from "../../utils/daemon-target.js";
import type { DaemonClient } from "@pimi/client/internal/daemon-client";
import { connectToDaemon } from "../../utils/client.js";

export async function withPluginClient<T>(
  target: DaemonTarget,
  run: (client: DaemonClient) => Promise<T>,
): Promise<T> {
  const client = await connectToDaemon({ target });
  try {
    return await run(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}
