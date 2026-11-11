export { OwnedSubscriptions, type OwnedSubscription, type SubscriptionObserver } from "./owned.js";
import { CLIENT_CAPS, type ClientCapability } from "@pimi/protocol/client-capabilities";

// Protocol support belongs to the installed client. Only browser hosting needs
// a resource supplied by the caller. Keep this exhaustive as the protocol evolves.
export const DEFAULT_CLIENT_CAPABILITIES = {
  [CLIENT_CAPS.binaryChunkingV1]: true,
  [CLIENT_CAPS.helloRejection]: true,
  [CLIENT_CAPS.allProviders]: true,
  [CLIENT_CAPS.reasoningMergeEnum]: true,
} satisfies Record<Exclude<ClientCapability, typeof CLIENT_CAPS.browserHost>, true>;

/** Calling releases demand; ready waits for membership. */
export type TimelineSubscription = (() => void) & {
  readonly ready: Promise<void>;
  readonly subscriptionId: string | null;
  release(): Promise<void>;
};
