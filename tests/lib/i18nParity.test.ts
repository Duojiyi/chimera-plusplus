import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KNOWN_APP_TYPES } from "@/types/usage";
import { MCP_APP_IDS } from "@/config/appConfig";

const LOCALE_NAMES = ["zh", "zh-TW", "en", "ja"] as const;

function flattenKeys(
  obj: Record<string, unknown>,
  prefix = "",
): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [childKey, childVal] of flattenKeys(
        v as Record<string, unknown>,
        key,
      )) {
        out.set(childKey, childVal);
      }
    } else {
      out.set(key, v);
    }
  }
  return out;
}

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, acc);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

describe("i18n locale parity and static t() key coverage", () => {
  const root = process.cwd();
  const locales = Object.fromEntries(
    LOCALE_NAMES.map((name) => {
      const raw = fs.readFileSync(
        path.join(root, "src/i18n/locales", `${name}.json`),
        "utf8",
      );
      return [name, flattenKeys(JSON.parse(raw) as Record<string, unknown>)];
    }),
  ) as Record<(typeof LOCALE_NAMES)[number], Map<string, unknown>>;

  it("keeps all 4 locale JSON files at 100% key parity", () => {
    const zhKeys = [...locales.zh.keys()].sort();
    for (const lang of LOCALE_NAMES) {
      const langKeys = [...locales[lang].keys()].sort();
      expect(langKeys, `locale ${lang} key mismatch vs zh`).toEqual(zhKeys);
    }
  });

  it("ensures every static dotted t('namespace.key') call in src/ exists in zh.json", () => {
    const re =
      /\b(?:i18n\.)?t\(\s*(["'])([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)\1/g;
    const missing: string[] = [];
    for (const file of collectSourceFiles(path.join(root, "src"))) {
      const source = fs.readFileSync(file, "utf8");
      let match: RegExpExecArray | null;
      while ((match = re.exec(source)) !== null) {
        const key = match[2];
        if (!locales.zh.has(key)) {
          missing.push(`${key} (${path.relative(root, file)})`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("covers all KNOWN_APP_TYPES in usage.appFilter and all MCP_APP_IDS in mcp.unifiedPanel.apps", () => {
    for (const app of KNOWN_APP_TYPES) {
      expect(
        locales.zh.has(`usage.appFilter.${app}`),
        `missing usage.appFilter.${app}`,
      ).toBe(true);
    }
    for (const app of MCP_APP_IDS) {
      expect(
        locales.zh.has(`mcp.unifiedPanel.apps.${app}`),
        `missing mcp.unifiedPanel.apps.${app}`,
      ).toBe(true);
    }
  });
});
