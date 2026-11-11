export { OwnedSubscriptions, type OwnedSubscription, type SubscriptionObserver } from "./owned.js";
import { CLIENT_CAPS, type ClientCapability } from "@pimi/protocol/client-capabilities";

// Protocol support belongs to the installed client. Keep this exhaustive as the protocol evolves.
export const DEFAULT_CLIENT_CAPABILITIES = {
  [CLIENT_CAPS.binaryChunkingV1]: true,
} satisfies Record<ClientCapability, true>;

/** Calling releases demand; ready waits for membership. */
export type TimelineSubscription = (() => void) & {
  readonly ready: Promise<void>;
  readonly subscriptionId: string | null;
  release(): Promise<void>;
};
