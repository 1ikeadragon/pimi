import { createInstance, type BackendModule } from "i18next";
import { initReactI18next } from "react-i18next";
import { observeI18nInit } from "./init";
import { getElectronHost } from "@/desktop/electron/host";
import type { SupportedLocale } from "./locales";
import { en, type TranslationResources } from "./resources/en";

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

// English is bundled statically because it is the fallback for every other language. The
// other tables load with `import()` the first time their language is selected, so they stay
// out of the startup bundle (Metro splits them into async chunks on web and resolves them from
// the same bundle on native). The provider does not wait for a load: until the table arrives
// `i18n.language` stays on the previous language and text renders from it or from English.
// react-i18next re-renders on `languageChanged` once the table is registered.
const loadTranslations: Record<
  Exclude<SupportedLocale, "en">,
  () => Promise<TranslationResources>
> = {
  ar: () => import("./resources/ar").then((module) => module.ar),
  es: () => import("./resources/es").then((module) => module.es),
  fr: () => import("./resources/fr").then((module) => module.fr),
  ja: () => import("./resources/ja").then((module) => module.ja),
  ko: () => import("./resources/ko").then((module) => module.ko),
  "pt-BR": () => import("./resources/pt-BR").then((module) => module.ptBR),
  ru: () => import("./resources/ru").then((module) => module.ru),
  "zh-CN": () => import("./resources/zh-CN").then((module) => module.zhCN),
};

function isLazyLocale(language: string): language is Exclude<SupportedLocale, "en"> {
  return Object.hasOwn(loadTranslations, language);
}

const bundledTranslations: BackendModule = {
  type: "backend",
  init() {},
  // Two parameters select i18next's promise form: a rejection reaches changeLanguage's callback.
  async read(language, _namespace) {
    if (language === "en") return appTranslation(en);
    if (!isLazyLocale(language)) return undefined;
    return appTranslation(await loadTranslations[language]());
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
