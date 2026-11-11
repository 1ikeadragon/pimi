import type {
  AggregateLoadState,
  AggregatedAutomation,
} from "@/automations/aggregated-automations";

export type AutomationsScreenBodyState =
  | { kind: "loading" }
  | { kind: "load-error" }
  | { kind: "empty" }
  | { kind: "content" };

export function resolveAutomationsScreenBodyState(input: {
  loadState: AggregateLoadState<AggregatedAutomation>;
  showLoadError: boolean;
}): AutomationsScreenBodyState {
  if (input.showLoadError) {
    return { kind: "load-error" };
  }
  if (input.loadState.status === "connecting" || input.loadState.status === "loading") {
    return { kind: "loading" };
  }
  if (input.loadState.data.length === 0) {
    return { kind: "empty" };
  }
  return { kind: "content" };
}
