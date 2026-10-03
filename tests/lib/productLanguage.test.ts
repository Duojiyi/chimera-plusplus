import { expect, it, vi } from "vitest";

it("starts in Chinese despite a legacy cached language and a foreign system locale", async () => {
  window.localStorage.setItem("language", "ja");
  const language = vi
    .spyOn(window.navigator, "language", "get")
    .mockReturnValue("en-US");
  try {
    const { default: i18n, i18nReady } = await import("@/i18n");
    await i18nReady;
    expect(i18n.language).toBe("zh");
    expect(i18n.options.supportedLngs).toContain("zh");
    expect(i18n.options.supportedLngs).not.toContain("en");
    expect(i18n.options.supportedLngs).not.toContain("ja");
    expect(window.localStorage.getItem("language")).toBe("ja");
  } finally {
    language.mockRestore();
    window.localStorage.removeItem("language");
  }
});
