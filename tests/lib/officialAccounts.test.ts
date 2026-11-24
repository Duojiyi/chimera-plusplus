import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  officialAccountsApi,
  type OfficialAccountDto,
} from "@/lib/api/officialAccounts";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const account: OfficialAccountDto = {
  key: "vault-key",
  accountId: "account-id",
  displayName: "Account",
  capturedAt: "2026-10-01",
  isCurrent: false,
  needsRelogin: false,
  providerId: "provider-id",
};
beforeEach(() => vi.mocked(invoke).mockReset());
describe("official account login contract", () => {
  it("routes pasted browser callbacks to the active native flow", async () => {
    const input = "http://localhost:1455/auth/callback?code=test&state=current";
    await officialAccountsApi.submitBrowserCallback("flow-current", input);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      "submit_official_browser_callback",
      {
        flowId: "flow-current",
        input,
      },
    );
  });
  it.each([
    ["startBrowserLogin", "start_official_browser_login"],
    ["startDeviceLogin", "start_official_device_login"],
  ] as const)("routes %s to its native command", async (method, command) => {
    const started = {
      flowId: "flow",
      verificationUrl: "https://auth.openai.com/",
      userCode: "",
      expiresAt: "2099-01-01",
    };
    vi.mocked(invoke).mockResolvedValueOnce(started);
    await expect(officialAccountsApi[method]()).resolves.toBe(started);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(command);
  });
});

describe("official account local import contract", () => {
  it.each([undefined, "", "Work account"])(
    "saves the current local login with name %s",
    async (name) => {
      vi.mocked(invoke).mockResolvedValueOnce("saved-vault-key");
      await expect(officialAccountsApi.saveCurrentLogin(name)).resolves.toBe(
        "saved-vault-key",
      );
      expect(invoke).toHaveBeenCalledExactlyOnceWith(
        "save_current_official_login",
        { name: name || null },
      );
    },
  );
});

describe("official account switch contract", () => {
  it.each(["vault-key", "provider-id"])(
    "resolves %s and uses the registered switch command",
    async (key) => {
      vi.mocked(invoke)
        .mockResolvedValueOnce([account])
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(undefined);
      await officialAccountsApi.switchAccount(key);
      expect(invoke).toHaveBeenNthCalledWith(1, "list_official_accounts");
      expect(invoke).toHaveBeenNthCalledWith(2, "switch_provider", {
        id: "provider-id",
        app: "codex",
      });
      expect(invoke).toHaveBeenNthCalledWith(3, "mark_official_account_used", {
        key: "vault-key",
      });
      expect(invoke).toHaveBeenCalledTimes(3);
    },
  );
  it.each([
    { accounts: [], message: "账号尚未关联线路，请先保存登录状态" },
    {
      accounts: [{ ...account, providerId: null }],
      message: "账号尚未关联线路，请先保存登录状态",
    },
    {
      accounts: [{ ...account, needsRelogin: true }],
      message: "账号登录已过期，请重新登录",
    },
  ])(
    "does not guess an id for unusable accounts %#",
    async ({ accounts, message }) => {
      vi.mocked(invoke).mockResolvedValueOnce(accounts);
      await expect(
        officialAccountsApi.switchAccount("vault-key"),
      ).rejects.toThrow(message);
      expect(invoke).toHaveBeenCalledTimes(1);
    },
  );
  it("propagates a native switching failure without a second mutation", async () => {
    const failure = new Error("native switch transaction failed");
    vi.mocked(invoke)
      .mockResolvedValueOnce([account])
      .mockRejectedValueOnce(failure);
    await expect(officialAccountsApi.switchAccount("vault-key")).rejects.toBe(
      failure,
    );
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it("propagates vault read failure without attempting a switch", async () => {
    const failure = new Error("vault read failed");
    vi.mocked(invoke).mockRejectedValueOnce(failure);
    await expect(officialAccountsApi.switchAccount("vault-key")).rejects.toBe(
      failure,
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe("official account quota contract", () => {
  it("queries the Vault command with its opaque key, not the ChatGPT account id", async () => {
    const quota = { tool: "codex", success: true, tiers: [] };
    vi.mocked(invoke).mockResolvedValueOnce(quota);
    await expect(officialAccountsApi.getQuota(account.key)).resolves.toBe(
      quota,
    );
    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      "get_official_account_quota",
      {
        key: "vault-key",
      },
    );
  });

  it("propagates errors without falling back to the legacy OAuth store", async () => {
    const failure = new Error("Vault account needs login");
    vi.mocked(invoke).mockRejectedValueOnce(failure);
    await expect(officialAccountsApi.getQuota(account.key)).rejects.toBe(
      failure,
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
