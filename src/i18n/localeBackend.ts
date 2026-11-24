import type { BackendModule } from "i18next";

const translations = {
  zh: () => import("./locales/zh.json"),
};

// i18next owns loading, caching, language changes and fallback resolution.
// While the UI is single-language Chinese, only `zh.json` is imported so
// unreachable locale bundles are not emitted into `dist/`.
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
