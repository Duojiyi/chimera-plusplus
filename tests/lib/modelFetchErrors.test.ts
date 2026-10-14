import { describe, expect, it } from "vitest";
import { classifyModelFetchError } from "@/lib/api/model-fetch";

describe("classifyModelFetchError", () => {
  it.each([
    ["HTTP 401 Unauthorized: invalid key", "auth"],
    ["HTTP 403 Forbidden", "auth"],
    ["All candidates failed: HTTP 404 Not Found: {}", "endpoint"],
    ["HTTP 405 Method Not Allowed", "endpoint"],
    ["Request failed: operation timed out", "timeout"],
    ["timeout while reading", "timeout"],
    ["Failed to parse response: expected value", "parse"],
    ["Request failed: connection refused", "unknown"],
    [new Error("HTTP 404"), "endpoint"],
  ])("%s -> %s", (error, code) => {
    expect(classifyModelFetchError(error)).toBe(code);
  });
});
