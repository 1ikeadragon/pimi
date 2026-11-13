import { useTranslation as useReactI18nTranslation } from "react-i18next";

// react-i18next defaults its options argument to a new object on every call. The hook derives its
// store subscription from that object, so without a stable one every render of every component
// tears down and rebuilds its i18n subscription.
const STABLE_OPTIONS = {};

export function useTranslation() {
  return useReactI18nTranslation(undefined, STABLE_OPTIONS);
}
