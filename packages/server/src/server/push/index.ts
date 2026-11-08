import type pino from "pino";

import { PushTokenStore } from "./token-store.js";

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

const PUSH_TOKEN_LEASE_MS = 48 * 60 * 60 * 1000;

export interface PushNotifications {
  renew(token: string): void;
  revoke(token: string): void;
  send(payload: PushPayload): Promise<void>;
}

export type PushNotificationSender = Pick<PushNotifications, "send">;

export function createPushNotifications(options: {
  logger: pino.Logger;
  filePath: string;
  now?: () => number;
  deliver: (tokens: string[], payload: PushPayload) => Promise<unknown>;
}): PushNotifications {
  const now = options.now ?? Date.now;
  const store = new PushTokenStore(options.logger, options.filePath, now, PUSH_TOKEN_LEASE_MS);

  return {
    renew(token) {
      store.renewToken(token);
    },
    revoke(token) {
      store.revokeToken(token);
    },
    async send(payload) {
      const tokens = store.getActiveTokens();
      options.logger.info({ tokenCount: tokens.length }, "Sending push notification");
      if (tokens.length === 0) return;
      await options.deliver(tokens, payload);
    },
  };
}
