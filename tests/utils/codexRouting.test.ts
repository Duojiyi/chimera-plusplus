import vectors from "../fixtures/codex-routing-vectors.json";
import type { Provider } from "@/types";
import {
  codexProviderRouting,
  describeCodexRouting,
  type CodexRoutingReason,
} from "@/utils/codexRouting";

interface RoutingVector {
  name: string;
  provider: Provider;
  routed: boolean;
  reasons: CodexRoutingReason[];
}

describe("codexProviderRouting", () => {
  // The Rust test `automatic_routing_matches_shared_renderer_vectors` asserts
  // the same file against the backend predicate.
  it.each(vectors as RoutingVector[])("$name", (vector) => {
    const routing = codexProviderRouting(vector.provider);
    expect(routing.routed).toBe(vector.routed);
    expect(routing.reasons).toEqual(vector.reasons);
  });

  it("describes direct and routed lines in plain words", () => {
    expect(describeCodexRouting({ routed: false, reasons: [] })).toBe(
      "直连上游",
    );
    expect(
      describeCodexRouting({ routed: true, reasons: ["chat", "full-url"] }),
    ).toBe("经本地路由（转换为 Chat Completions、完整 API 地址）");
  });
});
