import { describe, expect, it } from "vitest";
import { parse as parseToml } from "smol-toml";
import {
  buildGrokBuildConfig,
  extractGrokBuildBaseUrl,
  grokBuildConfigEditDropsComments,
  parseGrokBuildConfig,
  planGrokBuildConfigUpdate,
  updateGrokBuildConfig,
  validateGrokBuildConfig,
} from "./grokBuildConfig";

const COMMENTED = `# Grok Build · written by hand
[models]
default = "grok-4.5" # the profile Grok opens with

# Relay used at work
[model."grok-4.5"]
model = "grok-upstream"
base_url = "https://relay.example.com/v1" # EU endpoint
name = 'Relay'
api_key = "secret"
api_backend = "responses"
context_window = 500000

[mcp_servers.files]
# keep the sandbox read-only
command = "files-mcp"
`;

describe("Grok Build config", () => {
  it("refuses to replace malformed TOML with a new config", () => {
    expect(() =>
      updateGrokBuildConfig("[models", parseGrokBuildConfig(undefined)),
    ).toThrow();
  });

  it("builds the expected provider TOML", () => {
    const config = buildGrokBuildConfig({
      model: "grok-4.5",
      baseUrl: "https://relay.example.com/v1",
      name: 'Relay "A"',
      apiKey: "secret",
      apiBackend: "responses",
      contextWindow: 500000,
    });
    const parsed = parseToml(config) as any;

    expect(parsed.models.default).toBe("grok-4.5");
    expect(parsed.model["grok-4.5"]).toEqual({
      model: "grok-4.5",
      base_url: "https://relay.example.com/v1",
      name: 'Relay "A"',
      api_key: "secret",
      api_backend: "responses",
      context_window: 500000,
    });
    expect(config).toContain('[model."grok-4.5"]');
  });

  it("reads values back from a generated config", () => {
    const config = buildGrokBuildConfig({
      model: "custom-model",
      upstreamModel: "upstream-model",
      baseUrl: "https://api.example.com",
      name: "Custom",
      apiKey: "key",
      envKey: "",
      apiBackend: "responses",
      contextWindow: 320000,
    });

    expect(parseGrokBuildConfig(config)).toEqual({
      model: "custom-model",
      upstreamModel: "upstream-model",
      baseUrl: "https://api.example.com",
      name: "Custom",
      apiKey: "key",
      envKey: "",
      apiBackend: "responses",
      contextWindow: 320000,
    });
    expect(extractGrokBuildBaseUrl(config)).toBe("https://api.example.com");
  });

  it("accepts env_key credentials without adding an empty api_key", () => {
    const config = `[models]
default = "env-profile"

[model."env-profile"]
model = "grok-4.5"
base_url = "https://api.example.com/v1"
name = "Env Relay"
env_key = "XAI_API_KEY"
api_backend = "responses"
context_window = 500000
`;

    expect(validateGrokBuildConfig(config)).toBeNull();
    expect(parseGrokBuildConfig(config).envKey).toBe("XAI_API_KEY");

    const updated = updateGrokBuildConfig(config, {
      ...parseGrokBuildConfig(config),
      baseUrl: "https://updated.example.com/v1",
    });
    const parsed = parseToml(updated) as any;
    expect(parsed.model["env-profile"].env_key).toBe("XAI_API_KEY");
    expect(parsed.model["env-profile"]).not.toHaveProperty("api_key");
  });

  it("reports malformed, incomplete, and invalid-window configs", () => {
    expect(validateGrokBuildConfig("")).toBe("config.toml must not be empty");
    expect(validateGrokBuildConfig("[models")).not.toBeNull();
    expect(validateGrokBuildConfig('[models]\ndefault = "missing"\n')).toBe(
      "Missing [models] default model table",
    );

    const missingCredentials = buildGrokBuildConfig({
      model: "grok-4.5",
      baseUrl: "https://api.example.com/v1",
      name: "Relay",
      apiKey: "",
      apiBackend: "responses",
      contextWindow: 500000,
    });
    expect(validateGrokBuildConfig(missingCredentials)).toBe(
      "Missing api_key or env_key",
    );

    const invalidWindow = missingCredentials.replace(
      "context_window = 500000",
      "context_window = 0",
    );
    expect(validateGrokBuildConfig(invalidWindow)).toBe(
      "Missing api_key or env_key",
    );
    expect(
      validateGrokBuildConfig(
        invalidWindow.replace(
          'name = "Relay"',
          'name = "Relay"\napi_key = "secret"',
        ),
      ),
    ).toBe("context_window must be a positive integer");
  });

  it("renames the selected profile without leaving the old table behind", () => {
    const original = buildGrokBuildConfig({
      model: "old-profile",
      upstreamModel: "grok-upstream",
      baseUrl: "https://api.example.com/v1",
      name: "Relay",
      apiKey: "secret",
      apiBackend: "responses",
      contextWindow: 500000,
    });

    const renamed = updateGrokBuildConfig(original, {
      ...parseGrokBuildConfig(original),
      model: "new-profile",
    });
    const parsed = parseToml(renamed) as any;

    expect(parsed.models.default).toBe("new-profile");
    expect(parsed.model["new-profile"].model).toBe("grok-upstream");
    expect(parsed.model).not.toHaveProperty("old-profile");
  });
});

describe("Grok Build config: hand-written files", () => {
  it("leaves the text untouched when the fields did not change", () => {
    const plan = planGrokBuildConfigUpdate(
      COMMENTED,
      parseGrokBuildConfig(COMMENTED),
    );
    expect(plan).toEqual({ text: COMMENTED, droppedComments: false });
  });

  it("edits only the changed value and keeps every comment", () => {
    const updated = updateGrokBuildConfig(COMMENTED, {
      ...parseGrokBuildConfig(COMMENTED),
      baseUrl: "https://relay.example.com/v2",
    });
    expect(updated).toBe(
      COMMENTED.replace(
        'base_url = "https://relay.example.com/v1" # EU endpoint',
        'base_url = "https://relay.example.com/v2" # EU endpoint',
      ),
    );
  });

  it("adds and removes keys inside the selected table only", () => {
    const withEnv = updateGrokBuildConfig(COMMENTED, {
      ...parseGrokBuildConfig(COMMENTED),
      apiKey: "",
      envKey: "XAI_API_KEY",
    });
    expect(withEnv).not.toContain("api_key");
    expect(withEnv).toContain(
      'context_window = 500000\nenv_key = "XAI_API_KEY"\n\n[mcp_servers.files]',
    );
    expect(withEnv).toContain("# keep the sandbox read-only");
    expect(withEnv).toContain("# Relay used at work");
    const parsed = parseToml(withEnv) as any;
    expect(parsed.model["grok-4.5"].env_key).toBe("XAI_API_KEY");
    expect(parsed.mcp_servers.files.command).toBe("files-mcp");
  });

  it("renames the profile table in place", () => {
    const renamed = updateGrokBuildConfig(COMMENTED, {
      ...parseGrokBuildConfig(COMMENTED),
      model: "work",
    });
    expect(renamed).toContain('default = "work" # the profile Grok opens with');
    expect(renamed).toContain("# Relay used at work\n[model.work]\n");
    const parsed = parseToml(renamed) as any;
    expect(parsed.model).not.toHaveProperty("grok-4.5");
    expect(parsed.model.work.base_url).toBe("https://relay.example.com/v1");
  });

  it("keeps CRLF line endings", () => {
    const crlf = COMMENTED.replace(/\n/g, "\r\n");
    const updated = updateGrokBuildConfig(crlf, {
      ...parseGrokBuildConfig(crlf),
      apiKey: "",
      envKey: "XAI_API_KEY",
    });
    expect(updated).not.toMatch(/[^\r]\n/);
    expect((parseToml(updated) as any).model["grok-4.5"].env_key).toBe(
      "XAI_API_KEY",
    );
  });

  it("regenerates unusual layouts and says that comments were lost", () => {
    const dotted = `# dotted keys
models.default = "grok-4.5"
model."grok-4.5".model = "grok-4.5"
model."grok-4.5".base_url = "https://a.example/v1" # note
model."grok-4.5".name = "A"
model."grok-4.5".api_key = "k"
model."grok-4.5".api_backend = "responses"
model."grok-4.5".context_window = 500000
`;
    // Unchanged fields never rewrite the text, whatever its layout.
    expect(
      planGrokBuildConfigUpdate(dotted, parseGrokBuildConfig(dotted)),
    ).toEqual({ text: dotted, droppedComments: false });
    const plan = planGrokBuildConfigUpdate(dotted, {
      ...parseGrokBuildConfig(dotted),
      baseUrl: "https://b.example/v1",
    });
    expect(plan.droppedComments).toBe(true);
    expect(plan.text).not.toContain("#");
    expect((parseToml(plan.text) as any).model["grok-4.5"].base_url).toBe(
      "https://b.example/v1",
    );
    // The editor can warn before the first edit.
    expect(grokBuildConfigEditDropsComments(dotted)).toBe(true);
    expect(grokBuildConfigEditDropsComments(COMMENTED)).toBe(false);
    expect(grokBuildConfigEditDropsComments(dotted.replace(/#.*$/gm, ""))).toBe(
      false,
    );
    // A "#" inside a string is not a comment.
    expect(
      grokBuildConfigEditDropsComments(
        dotted.replace(/#.*$/gm, "").replace('"A"', '"Relay #1"'),
      ),
    ).toBe(false);
  });
});
