import { createInstance } from "i18next";
import { describe, expect, it, vi } from "vitest";
import { localeBackend } from "@/i18n/localeBackend";

describe("packaged language loading", () => {
  it("loads zh as the single packaged UI language", async () => {
    const instance = createInstance();
    await instance.use(localeBackend).init({
      lng: "zh",
      fallbackLng: "zh",
      supportedLngs: ["zh"],
    });
    expect(instance.hasResourceBundle("zh", "translation")).toBe(true);
    expect(
      Object.keys(instance.getResourceBundle("zh", "translation")).length,
    ).toBeGreaterThan(0);
    instance.addResource(
      "zh",
      "translation",
      "testOnlyFallback",
      "fallback works",
    );
    expect(instance.t("testOnlyFallback")).toBe("fallback works");
  });
  it.each(["en", "ja", "zh-TW", "unknown", "__proto__", "constructor"])(
    "reports unsupported or unpackaged language %s without a request",
    (language) => {
      const callback = vi.fn();
      localeBackend.read(language, "translation", callback);
      expect(callback).toHaveBeenCalledWith(expect.any(Error), false);
    },
  );
});
