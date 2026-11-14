import { createInstance } from "i18next";
import { initReactI18next } from "react-i18next";
import { observeI18nInit } from "./init";
import { getElectronHost } from "@/desktop/electron/host";
import { en } from "./resources/en";

// Brand the visible copy before interpolation so project names and provider
// output stay verbatim. The phone pairing hint names the actual companion app.
function brandTranslation(value: unknown, path = ""): unknown {
  if (typeof value === "string")
    return path === "pairing.device.hint" ? value : value.replace(/\bPimi\b/g, "Pimi");
  if (Array.isArray(value)) return value.map((item) => brandTranslation(item, path));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        brandTranslation(entry, path ? path + "." + key : key),
      ]),
    );
  return value;
}

function appTranslation<T extends object>(resource: T): T {
  return getElectronHost()?.pimiAppearance ? (brandTranslation(resource) as T) : resource;
}

const i18n = createInstance();

observeI18nInit(
  i18n.use(initReactI18next).init({
    compatibilityJSON: "v4",
    fallbackLng: "en",
    lng: "en",
    resources: {
      en: { translation: appTranslation(en) },
    },
    interpolation: {
      escapeValue: false,
    },
    react: {
      useSuspense: false,
    },
  }),
);

export { i18n };
