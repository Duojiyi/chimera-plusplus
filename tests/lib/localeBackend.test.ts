import { createInstance } from "i18next";
import { describe, expect, it, vi } from "vitest";
import { localeBackend } from "@/i18n/localeBackend";

describe("packaged language loading", () => {
  it.each(["en", "zh", "zh-TW", "ja"])(
    "loads %s and retains English fallback",
    async (language) => {
      const instance = createInstance();
      await instance.use(localeBackend).init({
        lng: language,
        fallbackLng: "en",
        supportedLngs: ["zh", "zh-TW", "en", "ja"],
      });
      expect(instance.hasResourceBundle(language, "translation")).toBe(true);
      expect(instance.hasResourceBundle("en", "translation")).toBe(true);
      expect(
        Object.keys(instance.getResourceBundle(language, "translation")).length,
      ).toBeGreaterThan(0);
      instance.addResource(
        "en",
        "translation",
        "testOnlyFallback",
        "fallback works",
      );
      expect(instance.t("testOnlyFallback")).toBe("fallback works");
      if (language !== "ja")
        expect(instance.hasResourceBundle("ja", "translation")).toBe(false);
    },
  );
  it("loads a different language when settings change", async () => {
    const instance = createInstance();
    await instance.use(localeBackend).init({ lng: "en", fallbackLng: "en" });
    expect(instance.hasResourceBundle("ja", "translation")).toBe(false);
    await instance.changeLanguage("ja");
    expect(instance.language).toBe("ja");
    expect(instance.hasResourceBundle("ja", "translation")).toBe(true);
    await instance.changeLanguage("zh-TW");
    expect(instance.hasResourceBundle("zh", "translation")).toBe(true);
    expect(instance.hasResourceBundle("zh-TW", "translation")).toBe(true);
  });
  it.each(["unknown", "__proto__", "constructor"])(
    "reports unsupported language %s without a request",
    (language) => {
      const callback = vi.fn();
      localeBackend.read(language, "translation", callback);
      expect(callback).toHaveBeenCalledWith(expect.any(Error), false);
    },
  );
});
