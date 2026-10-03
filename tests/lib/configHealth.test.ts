import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { configHealthApi } from "@/lib/api/configHealth";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
describe("configuration health command contract", () => {
  it("repairs only the observed token without accepting paths or replacement content", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      issues: [],
      readOnly: true,
      checkedAt: "now",
    });
    await configHealthApi.repairOwnedInstructions("observed-token");
    expect(invoke).toHaveBeenCalledWith("repair_codex_owned_instruction_refs", {
      expectedToken: "observed-token",
    });
  });
  it("requests the registered command without renderer-controlled file paths", async () => {
    const result = { issues: [], readOnly: true, checkedAt: "now" };
    vi.mocked(invoke).mockResolvedValueOnce(result);
    expect(await configHealthApi.check()).toEqual(result);
    expect(invoke).toHaveBeenCalledWith("check_codex_config_health");
  });
});
