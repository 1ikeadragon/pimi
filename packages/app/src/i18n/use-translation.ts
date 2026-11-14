import { useTranslation as useReactI18nTranslation } from "react-i18next";
import { i18n } from "./i18next";

// react-i18next defaults its options argument to a new object on every call. The hook derives its
// store subscription from that object, so without a stable one every render of every component
// tears down and rebuilds its i18n subscription.
// Passing the instance also keeps the hook working when it runs before any module that registers
// the global instance has evaluated, which logs NO_I18NEXT_INSTANCE and returns untranslated keys.
const STABLE_OPTIONS = { i18n };

export function useTranslation() {
  return useReactI18nTranslation(undefined, STABLE_OPTIONS);
}
