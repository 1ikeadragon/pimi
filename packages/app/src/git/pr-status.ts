import type { CheckoutPrStatusResponse, ForgeAuthState } from "@pimi/protocol/messages";
import { parseForgeAuthState } from "@/git/forge";

type WireCheckoutPrStatusPayload = CheckoutPrStatusResponse["payload"];

export type CheckoutPrStatusPayload = Omit<WireCheckoutPrStatusPayload, "authState"> & {
  authState: ForgeAuthState;
};

export function normalizeCheckoutPrStatusPayload(
  payload: WireCheckoutPrStatusPayload,
): CheckoutPrStatusPayload {
  return {
    ...payload,
    // The daemon omits authState when it cannot determine it; githubFeaturesEnabled still applies.
    authState:
      parseForgeAuthState(payload.authState) ??
      (payload.githubFeaturesEnabled ? "authenticated" : "unauthenticated"),
  };
}
