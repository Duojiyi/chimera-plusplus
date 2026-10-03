import type { BackendModule } from "i18next";

const translations = {
  en: () => import("./locales/en.json"),
  ja: () => import("./locales/ja.json"),
  zh: () => import("./locales/zh.json"),
  "zh-TW": () => import("./locales/zh-TW.json"),
};

// i18next owns loading, caching, language changes and fallback resolution.
// All resources are packaged locally; switching languages needs no network API.
export const localeBackend: BackendModule = {
  type: "backend",
  init() {},
  read(language, _namespace, callback) {
    if (!Object.hasOwn(translations, language)) {
      callback(new Error(`Unsupported language: ${language}`), false);
      return;
    }
    void translations[language as keyof typeof translations]().then(
      (module) => callback(null, module.default),
      (error: unknown) =>
        callback(
          error instanceof Error ? error : new Error(String(error)),
          false,
        ),
    );
  },
};
