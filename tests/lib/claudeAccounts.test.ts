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
      () => claudeAccountsApi.exportLogins(),
      "export_claude_logins",
      { ids: null },
    ],
    [
      () => claudeAccountsApi.exportLogins(["a1"]),
      "export_claude_logins",
      { ids: ["a1"] },
    ],
    [() => claudeAccountsApi.importLogins(), "import_claude_logins", undefined],
    [
      () => claudeAccountsApi.beginBrowserLogin(),
      "begin_claude_browser_login",
      undefined,
    ],
    [
      () => claudeAccountsApi.pollBrowserLogin("flow-1"),
      "poll_claude_browser_login",
      { id: "flow-1" },
    ],
    [
      () => claudeAccountsApi.cancelBrowserLogin("flow-1"),
      "cancel_claude_browser_login",
      { id: "flow-1" },
    ],
    [
      () => claudeAccountsApi.addSecret("sk-ant-oat01-x", " CI "),
      "add_claude_secret_account",
      { name: "CI", secret: "sk-ant-oat01-x" },
    ],
    [
      () => claudeAccountsApi.addSecret("sk-ant-api03-x"),
      "add_claude_secret_account",
      { name: null, secret: "sk-ant-api03-x" },
    ],
    [
      () => claudeAccountsApi.setDisabled("a1", true),
      "set_claude_account_disabled",
      { id: "a1", disabled: true },
    ],
    [
      () => claudeAccountsApi.reorder(["a", "b"]),
      "reorder_claude_accounts",
      { ids: ["a", "b"] },
    ],
    [
      () => claudeAccountsApi.openSession({ id: "a1" }),
      "open_claude_session",
      { id: "a1", dir: null },
    ],
    [
      () => claudeAccountsApi.openSession({ dir: "D:\w" }),
      "open_claude_session",
      { id: null, dir: "D:\w" },
    ],
    [
      () => claudeAccountsApi.sessionCommands("a1"),
      "get_claude_session_commands",
      { id: "a1" },
    ],
    [() => claudeAccountsApi.listBindings(), "list_claude_bindings", undefined],
    [
      () => claudeAccountsApi.setBinding("D:\w", "a1"),
      "set_claude_binding",
      { path: "D:\w", accountId: "a1" },
    ],
    [
      () => claudeAccountsApi.removeBinding("D:\w"),
      "remove_claude_binding",
      { path: "D:\w" },
    ],
    [() => claudeAccountsApi.pickFolder(), "pick_claude_folder", undefined],
    [
      () => claudeAccountsApi.usageOverview(30),
      "get_claude_usage_overview",
      { rangeDays: 30 },
    ],
    [
      () => claudeAccountsApi.usageOverview(),
      "get_claude_usage_overview",
      { rangeDays: null },
    ],
    [
      () => claudeAccountsApi.desktopSwapStatus(),
      "get_claude_desktop_swap_status",
      undefined,
    ],
    [
      () => claudeAccountsApi.captureDesktopLogin("a1"),
      "capture_claude_desktop_login",
      { id: "a1", closeDesktop: false },
    ],
    [
      () => claudeAccountsApi.switchDesktop("a1", true),
      "switch_claude_desktop_account",
      { id: "a1", closeDesktop: true },
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
