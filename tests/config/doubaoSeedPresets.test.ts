import { expect, it } from "vitest";
import { codexProviderPresets } from "@/config/codexProviderPresets";
it("keeps DouBaoSeed available in the Codex catalog", () => {
  expect(JSON.stringify(codexProviderPresets)).toContain(
    "doubao-seed-2-1-pro-260628",
  );
});
