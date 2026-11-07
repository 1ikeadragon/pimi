import { createInstance, type BackendModule } from "i18next";
import { initReactI18next } from "react-i18next";
import { observeI18nInit } from "./init";
import { getElectronHost } from "@/desktop/electron/host";
import { en } from "./resources/en";

// Brand the visible copy before interpolation so project names and provider
// output stay verbatim. The phone pairing hint names the actual companion app.
function brandTranslation(value: unknown, path = ""): unknown {
  if (typeof value === "string")
    return path === "pairing.device.hint" ? value : value.replace(/\bPaseo\b/g, "Pimi");
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

// Literal requires keep every locale bundled for offline use, while evaluating
// its resource module only when selected. Synchronous reads preserve the language
// provider's contract: translations are ready before it renders children.
const bundledTranslations: BackendModule = {
  type: "backend",
  init() {},
  read(language, _namespace, callback) {
    switch (language) {
      case "en":
        callback(null, appTranslation(en));
        return;
      case "ar":
        callback(null, appTranslation(require("./resources/ar").ar));
        return;
      case "es":
        callback(null, appTranslation(require("./resources/es").es));
        return;
      case "fr":
        callback(null, appTranslation(require("./resources/fr").fr));
        return;
      case "ja":
        callback(null, appTranslation(require("./resources/ja").ja));
        return;
      case "ko":
        callback(null, appTranslation(require("./resources/ko").ko));
        return;
      case "pt-BR":
        callback(null, appTranslation(require("./resources/pt-BR").ptBR));
        return;
      case "ru":
        callback(null, appTranslation(require("./resources/ru").ru));
        return;
      case "zh-CN":
        callback(null, appTranslation(require("./resources/zh-CN").zhCN));
        return;
      default:
        callback(null, undefined);
    }
  },
};

const i18n = createInstance();

observeI18nInit(
  i18n
    .use(bundledTranslations)
    .use(initReactI18next)
    .init({
      compatibilityJSON: "v4",
      fallbackLng: "en",
      lng: "en",
      partialBundledLanguages: true,
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
