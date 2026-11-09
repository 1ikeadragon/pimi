import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { BlockList } from "node:net";
import { networkInterfaces } from "node:os";
import type { Logger } from "pino";
import { WebSocketServer } from "ws";
import type {
  PimiLocalPairingRequest,
  PimiLocalPairingStatus,
} from "@pimi/protocol/connection-offer";
import { serializeRelayConnectionUri } from "@pimi/protocol/daemon-endpoints";
import { MAX_RELAY_WEBSOCKET_MESSAGE_BYTES } from "@pimi/protocol/websocket-message-limit";
import type { KeyPair } from "@pimi/relay/e2ee";
import { DEFAULT_PAIRING_APP_BASE_URL } from "./connection-offer.js";
import { admitSecuredRelaySocket } from "./websocket/secure-relay-ingress.js";
import type { VoiceAssistantWebSocketServer } from "./websocket-server.js";

function localAddresses() {
  return Object.entries(networkInterfaces()).flatMap(([name, interfaces]) =>
    (interfaces ?? []).flatMap((entry) => {
      if (entry.family !== "IPv4" || entry.internal || !entry.cidr) return [];
      const [first, second] = entry.address.split(".").map(Number);
      const isPrivate =
        first === 10 ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168);
      return isPrivate ? [{ name, address: entry.address, cidr: entry.cidr }] : [];
    }),
  );
}

export function createLocalNetworkPairing(options: {
  serverId: string;
  daemonPublicKeyB64: string;
  daemonKeyPair: KeyPair;
  hasPassword: boolean;
  logger: Logger;
  attach: VoiceAssistantWebSocketServer["attachExternalSocket"];
}) {
  let active:
    | { offer: NonNullable<PimiLocalPairingStatus["active"]>; close: () => Promise<void> }
    | undefined;
  let pending = Promise.resolve();
  let closed = false;

  async function disable() {
    const previous = active;
    active = undefined;
    await previous?.close();
  }

  async function enable(network: ReturnType<typeof localAddresses>[number]) {
    const { address, cidr } = network;
    const subnet = new BlockList();
    subnet.addSubnet(address, Number(cidr.split("/")[1]));
    const accessCode = options.hasPassword ? undefined : randomBytes(16).toString("base64url");
    const server = createServer({ headersTimeout: 5000, requestTimeout: 5000 }, (_req, res) => {
      res.writeHead(404, { connection: "close" }).end();
    });
    server.maxConnections = 32;
    const sockets = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_RELAY_WEBSOCKET_MESSAGE_BYTES,
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, address, () => {
        server.off("error", reject);
        resolve();
      });
    });
    server.on("error", (error) =>
      options.logger.warn({ err: error }, "Local pairing listener error"),
    );
    const endpoint = `${address}:${(server.address() as { port: number }).port}`;
    server.on("upgrade", (req, socket, head) => {
      const origin = `http://${endpoint}`;
      const remote = req.socket.remoteAddress;
      if (
        !remote ||
        !subnet.check(remote) ||
        req.headers.host !== endpoint ||
        (req.headers.origin && req.headers.origin !== origin) ||
        !req.url?.startsWith("/ws?")
      ) {
        socket.destroy();
        return;
      }
      const query = new URLSearchParams(req.url.slice(4));
      if (query.get("serverId") !== options.serverId || query.get("role") !== "client") {
        socket.destroy();
        return;
      }
      sockets.handleUpgrade(req, socket, head, (ws) => {
        void admitSecuredRelaySocket(
          ws,
          {
            daemonKeyPair: options.daemonKeyPair,
            logger: options.logger,
            requireProtectedMode: () => true,
          },
          ({ socket: secured, securityMode }) =>
            options.attach(secured, { transport: "lan", securityMode, lanAccessCode: accessCode }),
        );
      });
    });
    const uri = serializeRelayConnectionUri({
      offer: {
        v: 2,
        serverId: options.serverId,
        daemonPublicKeyB64: options.daemonPublicKeyB64,
        relay: { endpoint, useTls: false },
        minimumSecurityMode: "protected",
      },
      password: accessCode,
    });
    active = {
      offer: {
        address,
        url: `${DEFAULT_PAIRING_APP_BASE_URL}/#connect=${encodeURIComponent(uri)}`,
        needsPassword: options.hasPassword,
      },
      async close() {
        for (const ws of sockets.clients) ws.terminate();
        sockets.close();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      },
    };
  }

  return {
    request(input: PimiLocalPairingRequest): Promise<PimiLocalPairingStatus> {
      const next = pending.then(async () => {
        if (closed) throw new Error("The host is shutting down.");
        const addresses = localAddresses();
        if (
          input.action === "disable" ||
          (active && !addresses.some(({ address }) => address === active?.offer.address))
        ) {
          await disable();
        }
        if (input.action === "enable" && active?.offer.address !== input.address) {
          const network = addresses.find(({ address }) => address === input.address);
          if (!network) throw new Error("That local network address is no longer available.");
          await disable();
          await enable(network);
        }
        return {
          addresses: addresses.map(({ address, name }) => ({ address, name })),
          active: active?.offer ?? null,
        };
      });
      pending = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
    async close() {
      closed = true;
      await pending;
      await disable();
    },
  };
}
