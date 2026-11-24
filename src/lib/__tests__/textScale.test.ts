import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyTextScale,
  initTextScale,
  normalizeTextScale,
  readTextScale,
  setTextScale,
  TEXT_SCALE_STORAGE_KEY,
} from "../textScale";

describe("textScale", () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.textScale;
  });

  afterEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.textScale;
  });

  it("normalizes unknown values to standard", () => {
    expect(normalizeTextScale(undefined)).toBe("standard");
    expect(normalizeTextScale("large")).toBe("standard");
    expect(normalizeTextScale("comfortable")).toBe("comfortable");
  });

  it("persists and applies comfortable scale to documentElement", () => {
    expect(readTextScale()).toBe("standard");
    setTextScale("comfortable");
    expect(readTextScale()).toBe("comfortable");
    expect(document.documentElement.dataset.textScale).toBe("comfortable");

    setTextScale("standard");
    expect(readTextScale()).toBe("standard");
    expect(document.documentElement.dataset.textScale).toBeUndefined();
  });

  it("syncs scale across windows via storage events", () => {
    const cleanup = initTextScale();
    expect(document.documentElement.dataset.textScale).toBeUndefined();

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: TEXT_SCALE_STORAGE_KEY,
        newValue: "comfortable",
      }),
    );
    expect(document.documentElement.dataset.textScale).toBe("comfortable");

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: TEXT_SCALE_STORAGE_KEY,
        newValue: "standard",
      }),
    );
    expect(document.documentElement.dataset.textScale).toBeUndefined();

    applyTextScale("comfortable");
    cleanup();
  });
});
