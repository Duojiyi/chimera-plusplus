import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { localeBackend } from "./localeBackend";

export const i18nReady = i18n
  .use(localeBackend)
  .use(initReactI18next)
  .init({
    supportedLngs: ["zh"],
    lng: "zh",
    fallbackLng: "zh",
    interpolation: { escapeValue: false },
    debug: false,
  });

export default i18n;
