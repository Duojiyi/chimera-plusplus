import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { claudeAccountsApi } from "@/lib/api/claudeAccounts";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(undefined);
});

describe("Claude accounts command contract", () => {
  it.each([
    [
      () => claudeAccountsApi.listCode(),
      "list_claude_code_accounts",
      undefined,
    ],
    [
      () => claudeAccountsApi.saveCurrentCode("  "),
      "save_current_claude_code_login",
      { name: null },
    ],
    [
      () => claudeAccountsApi.saveCurrentCode(" 工作 "),
      "save_current_claude_code_login",
      { name: "工作" },
    ],
    [
      () => claudeAccountsApi.switchCode("a1"),
      "switch_claude_code_account",
      { id: "a1", allowRunning: false },
    ],
    [
      () => claudeAccountsApi.switchCode("a1", true),
      "switch_claude_code_account",
      { id: "a1", allowRunning: true },
    ],
    [
      () => claudeAccountsApi.renameCode("a1", "n"),
      "rename_claude_code_account",
      { id: "a1", name: "n" },
    ],
    [
      () => claudeAccountsApi.deleteCode("a1"),
      "delete_claude_code_account",
      { id: "a1" },
    ],
    [
      () => claudeAccountsApi.codeQuota("a1"),
      "get_claude_code_account_quota",
      { id: "a1", force: false },
    ],
    [
      () => claudeAccountsApi.codeQuota("a1", true),
      "get_claude_code_account_quota",
      { id: "a1", force: true },
    ],
    [
      () => claudeAccountsApi.listDesktop(),
      "list_claude_desktop_profiles",
      undefined,
    ],
    [
      () => claudeAccountsApi.createDesktop("n"),
      "create_claude_desktop_profile",
      { name: "n" },
    ],
    [
      () => claudeAccountsApi.renameDesktop("a1", "n"),
      "rename_claude_desktop_profile",
      { id: "a1", name: "n" },
    ],
    [
      () => claudeAccountsApi.deleteDesktop("a1"),
      "delete_claude_desktop_profile",
      { id: "a1" },
    ],
    [
      () => claudeAccountsApi.desktopQuota("default", true),
      "get_claude_desktop_profile_quota",
      { id: "default", force: true },
    ],
    [
      () => claudeAccountsApi.launchDesktop("a1"),
      "launch_claude_desktop_profile",
      { id: "a1" },
    ],
  ] as const)("%#: calls %s", async (call, command, args) => {
    await call();
    if (args === undefined)
      expect(invoke).toHaveBeenCalledExactlyOnceWith(command);
    else expect(invoke).toHaveBeenCalledExactlyOnceWith(command, args);
  });
});
