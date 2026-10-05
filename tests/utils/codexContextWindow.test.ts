import { describe, expect, it } from "vitest";
import {
  applyOneMillionContext,
  readContextWindowState,
} from "@/utils/codexContextWindow";

const on = (text: string) => applyOneMillionContext(text, true);
const off = (text: string) => applyOneMillionContext(text, false);

const PRESET = [
  "model_context_window = 1000000",
  "model_auto_compact_token_limit = 900000",
];

const lines = (...rows: string[]) => rows.join("\n");

const LINE = lines(
  "# 中转线路",
  'model_provider = "relay" # 当前线路',
  'model = "gpt-5.5"',
  'model_reasoning_effort = "high"',
  "",
  "[model_providers.relay]",
  'name = "Relay"',
  'base_url = "https://relay.example/v1"',
  "",
);

const LINE_ON = lines(
  "# 中转线路",
  'model_provider = "relay" # 当前线路',
  'model = "gpt-5.5"',
  'model_reasoning_effort = "high"',
  ...PRESET,
  "",
  "[model_providers.relay]",
  'name = "Relay"',
  'base_url = "https://relay.example/v1"',
  "",
);

const UNSET = {
  enabled: false,
  contextWindow: null,
  autoCompactLimit: null,
  hasCustomValues: false,
  editable: true,
};

describe("readContextWindowState", () => {
  it("reports an unset switch", () => {
    expect(readContextWindowState(LINE)).toEqual(UNSET);
    expect(readContextWindowState("")).toEqual(UNSET);
  });

  it("reads the preset", () => {
    expect(readContextWindowState(LINE_ON)).toEqual({
      enabled: true,
      contextWindow: 1_000_000,
      autoCompactLimit: 900_000,
      hasCustomValues: false,
      editable: true,
    });
  });

  it("reads quoted keys and other integer spellings", () => {
    const text = lines(
      '"model_context_window" = 1_000_000 # large',
      "'model_auto_compact_token_limit' = 0xDBBA0",
      "",
    );
    expect(readContextWindowState(text)).toEqual({
      enabled: true,
      contextWindow: 1_000_000,
      autoCompactLimit: 900_000,
      hasCustomValues: false,
      editable: true,
    });
  });

  it.each([
    [
      "a window of its own",
      "model_context_window = 256000\n",
      { enabled: false, contextWindow: 256_000, hasCustomValues: true },
    ],
    [
      "a limit of its own next to the 1M window",
      "model_context_window = 1000000\nmodel_auto_compact_token_limit = 850000\n",
      { enabled: true, autoCompactLimit: 850_000, hasCustomValues: true },
    ],
    [
      "a limit without the 1M window",
      "model_auto_compact_token_limit = 900000\n",
      { enabled: false, autoCompactLimit: 900_000, hasCustomValues: true },
    ],
    [
      "a float, which Codex rejects",
      "model_context_window = 1000000.0\n",
      { enabled: false, contextWindow: null, hasCustomValues: true },
    ],
    [
      "a string",
      'model_context_window = "1000000"\n',
      { enabled: false, contextWindow: null, hasCustomValues: true },
    ],
  ])("flags %s as hand-set", (_label, text, expected) => {
    expect(readContextWindowState(text)).toMatchObject({
      ...expected,
      editable: true,
    });
  });

  it("ignores the keys of tables, dotted keys and comments", () => {
    const text = lines(
      'model = "gpt-5.5"',
      "profiles.deep.model_context_window = 1000000",
      "# model_context_window = 1000000",
      "",
      "[model_providers.custom]",
      'name = "E-FlowCode"',
      "model_context_window = 1000000",
      "model_auto_compact_token_limit = 9000000",
      "",
    );
    expect(readContextWindowState(text)).toEqual(UNSET);
  });
});

describe("applyOneMillionContext", () => {
  it("adds the preset after the last root key and removes exactly it", () => {
    expect(on(LINE)).toBe(LINE_ON);
    expect(off(LINE_ON)).toBe(LINE);
  });

  it("is idempotent", () => {
    expect(on(LINE_ON)).toBe(LINE_ON);
    expect(off(LINE)).toBe(LINE);
    expect(off(off(LINE_ON))).toBe(LINE);
  });

  it("round-trips a blank draft", () => {
    expect(on("")).toBe(lines(...PRESET, ""));
    expect(off(on(""))).toBe("");
  });

  it("starts an empty root table at the top of the file", () => {
    const text = '[model_providers.relay]\nname = "Relay"\n';
    expect(on(text)).toBe(lines(...PRESET, text));
    expect(off(on(text))).toBe(text);
  });

  it("keeps a byte-order mark first", () => {
    const text = "\uFEFF[tui]\n";
    expect(on(text)).toBe(`\uFEFF${lines(...PRESET, "[tui]", "")}`);
    expect(off(on(text))).toBe(text);
  });

  it("keeps CRLF line breaks", () => {
    const crlf = LINE.replace(/\n/g, "\r\n");
    const enabled = on(crlf);
    expect(enabled).toBe(LINE_ON.replace(/\n/g, "\r\n"));
    expect(readContextWindowState(enabled).enabled).toBe(true);
    expect(off(enabled)).toBe(crlf);
  });

  it("handles a last line without a line break", () => {
    const text = 'model = "gpt-5.5"';
    expect(on(text)).toBe(lines(text, ...PRESET));
    expect(off(on(text))).toBe(text);
  });

  it("rewrites a hand-set window in place and keeps its comment", () => {
    const text =
      'model = "gpt-5.5"\nmodel_context_window = 256000 # 原值\n\n[tui]\n';
    expect(on(text)).toBe(
      lines(
        'model = "gpt-5.5"',
        "model_context_window = 1000000 # 原值",
        "model_auto_compact_token_limit = 900000",
        "",
        "[tui]",
        "",
      ),
    );
  });

  it("keeps a hand-set limit when turning on and off", () => {
    const text = "model_auto_compact_token_limit = 850000 # 自定\n";
    const enabled = on(text);
    expect(enabled).toBe(`${text}model_context_window = 1000000\n`);
    expect(readContextWindowState(enabled)).toMatchObject({
      enabled: true,
      autoCompactLimit: 850_000,
      hasCustomValues: true,
    });
    expect(off(enabled)).toBe(text);
  });

  it.each([
    "model_context_window = 256000\nmodel_auto_compact_token_limit = 900000\n",
    "model_auto_compact_token_limit = 900000\n",
    'model_context_window = "1000000"\n',
  ])("never removes hand-set values when turning off: %j", (text) => {
    expect(off(text)).toBe(text);
  });

  it("removes the preset in any integer spelling", () => {
    const text = lines(
      'model = "x"',
      "model_context_window = 1_000_000 # 1M",
      "  model_auto_compact_token_limit = +900_000",
      "",
    );
    expect(off(text)).toBe('model = "x"\n');
  });

  it("only touches root keys", () => {
    const tables = lines(
      "[profiles.wide]",
      "model_context_window = 1000000",
      "model_auto_compact_token_limit = 900000",
      "",
      "[model_providers.custom]",
      "model_context_window = 1000000",
      "",
    );
    const text = `model = "gpt-5.5"\n\n${tables}`;
    expect(on(text)).toBe(lines('model = "gpt-5.5"', ...PRESET, "", tables));
    expect(off(on(text))).toBe(text);
    expect(off(text)).toBe(text);
  });

  it("scans past multi-line strings, arrays and inline tables", () => {
    const head = lines(
      "instructions = '''",
      "model_context_window = 1000000",
      "[profiles.fake]",
      "'''",
      'notes = """',
      "model_auto_compact_token_limit = 900000",
      '"""',
      "matrix = [",
      "  [1, 2], # [not.a.table]",
      '  { a = "]" },',
      "]",
      "",
    );
    const text = `${head}${lines(...PRESET, "", "[tui]", "")}`;
    expect(readContextWindowState(text)).toMatchObject({
      enabled: true,
      hasCustomValues: false,
    });
    expect(off(text)).toBe(`${head}\n[tui]\n`);
  });

  it.each([
    'model = "unterminated\n',
    "[model_context_window]\nsize = 1\n",
    "model_context_window.size = 1\n",
  ])("leaves text it cannot edit unchanged: %j", (text) => {
    expect(readContextWindowState(text)).toMatchObject({
      enabled: false,
      editable: false,
    });
    expect(on(text)).toBe(text);
    expect(off(text)).toBe(text);
  });
});
