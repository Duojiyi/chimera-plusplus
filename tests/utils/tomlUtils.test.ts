import { describe, expect, it } from "vitest";
import { mcpServerToToml, tomlToMcpServer } from "@/utils/tomlUtils";

describe("MCP TOML transport inference", () => {
  it("keeps URL-only native HTTP fields across an editor round trip", () => {
    const server = {
      url: "https://example.invalid/mcp",
      http_headers: { "X-Test": "synthetic" },
      bearer_token_env_var: "MCP_TEST_TOKEN",
      startup_timeout_sec: 30,
      enabled: false,
      enabled_tools: ["search"],
    };
    expect(tomlToMcpServer(mcpServerToToml(server))).toEqual({
      ...server,
      type: "http",
    });
  });
  it("accepts URL-only wrapped Codex tables", () => {
    expect(
      tomlToMcpServer(
        '[mcp_servers.docs]\nurl = "https://example.invalid/mcp"',
      ),
    ).toEqual({ type: "http", url: "https://example.invalid/mcp" });
  });
  it("retains command inference and explicit SSE", () => {
    expect(tomlToMcpServer('command = "test-mcp"')).toEqual({
      type: "stdio",
      command: "test-mcp",
    });
    expect(
      tomlToMcpServer('type = "sse"\nurl = "https://example.invalid/sse"').type,
    ).toBe("sse");
  });
  it("does not turn malformed stdio into HTTP or accept an empty URL", () => {
    expect(() =>
      tomlToMcpServer('type = "stdio"\nurl = "https://example.invalid/mcp"'),
    ).toThrow(/command/);
    expect(() =>
      tomlToMcpServer('command = ""\nurl = "https://example.invalid/mcp"'),
    ).toThrow(/command/);
    expect(() => tomlToMcpServer('type = "http"\nurl = ""')).toThrow(/url/);
  });
});
