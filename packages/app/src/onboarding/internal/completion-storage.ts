import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
import { readValidatedJson } from "@/storage/validated-storage";
import type { OnboardingCompletionStorage } from "./model";

export const ONBOARDING_STORAGE_KEY = "@pimi:onboarding";

const OnboardingRecordSchema = z.object({ completedAt: z.string() });

export function onboardingCompletionStorage(key: string): OnboardingCompletionStorage {
  return {
    async isCompleted() {
      return (await readValidatedJson(AsyncStorage, key, OnboardingRecordSchema)) !== null;
    },
    async markCompleted() {
      await AsyncStorage.setItem(key, JSON.stringify({ completedAt: new Date().toISOString() }));
    },
  };
}

export const asyncStorageOnboardingCompletion = onboardingCompletionStorage(ONBOARDING_STORAGE_KEY);
