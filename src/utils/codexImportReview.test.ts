import type { TFunction } from "i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeCodexImportReview,
  promptCodexImportReview,
} from "./codexImportReview";

const { toastWarning, getCodexImportReview } = vi.hoisted(() => ({
  toastWarning: vi.fn(),
  getCodexImportReview: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { warning: toastWarning, success: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/api", () => ({
  settingsApi: { getCodexImportReview, confirmCodexImportSync: vi.fn() },
}));

// Render `{{var}}` placeholders of the default value, like i18next would.
const t = ((key: string, options?: Record<string, string>) =>
  (options?.defaultValue ?? key).replace(
    /\{\{(\w+)\}\}/g,
    (_, name: string) => options?.[name] ?? "",
  )) as unknown as TFunction;

describe("codex import review", () => {
  beforeEach(() => {
    toastWarning.mockReset();
    getCodexImportReview.mockReset();
  });

  it("lists every affected line and the common config by key name", () => {
    const lines = describeCodexImportReview(
      {
        providers: [
          {
            id: "a",
            name: "Relay",
            stripped: ["notify", "approval_policy"],
            needsConfirmation: [],
          },
          {
            id: "b",
            name: "Other",
            stripped: [],
            needsConfirmation: ["RELAY_API_KEY"],
          },
        ],
        commonConfig: { stripped: ["hooks"], needsConfirmation: [] },
      },
      t,
    );
    expect(lines).toEqual([
      "Relay：已移除 notify, approval_policy；待确认 无",
      "Other：已移除 无；待确认 RELAY_API_KEY",
      "通用配置：已移除 hooks；待确认 无",
    ]);
  });

  it("stays silent when nothing is pending", async () => {
    getCodexImportReview.mockResolvedValue(null);
    await promptCodexImportReview(t);
    expect(toastWarning).not.toHaveBeenCalled();
  });

  it("asks before syncing when a review is pending", async () => {
    getCodexImportReview.mockResolvedValue({
      providers: [
        { id: "a", name: "Relay", stripped: ["notify"], needsConfirmation: [] },
      ],
    });
    await promptCodexImportReview(t);
    expect(toastWarning).toHaveBeenCalledTimes(1);
    const options = toastWarning.mock.calls[0][1];
    expect(options.description).toContain("Relay：已移除 notify");
    expect(options.action.label).toBe("确认并同步");
  });
});
