import { getDesktopHost } from "@/desktop/host";
import {
  asyncStorageOnboardingCompletion,
  onboardingCompletionStorage,
} from "./completion-storage";
import { createOnboardingModel, type OnboardingModel } from "./model";

let instance: OnboardingModel | null = null;

/** The app's one setup model, created on first use so storage is read once per launch. */
export function getOnboardingModel(): OnboardingModel {
  const pimi = Boolean(getDesktopHost()?.showPimiWorkspace);
  instance ??= createOnboardingModel({
    pimi,
    storage: pimi
      ? onboardingCompletionStorage("@pimi:onboarding")
      : asyncStorageOnboardingCompletion,
  });
  return instance;
}
