import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { bundledPromptTemplates } from "@/config/promptTemplates";
import allowlist from "@/config/prompt-templates/allowlist.json";

describe("curated bundled prompts", () => {
  it("ships exactly the six approved examples and no unregistered Markdown", () => {
    const ids = [
      "software-development-code-review",
      "software-development-debugging",
      "software-development-maintainer",
      "writing-clarity-editor",
      "writing-structured-draft",
      "writing-technical-docs",
    ];
    expect(bundledPromptTemplates.map((item) => item.id)).toEqual(ids);
    expect(allowlist.map((item) => item.id)).toEqual(ids);
    expect(
      readdirSync(resolve("src/config/prompt-templates"))
        .filter((name) => name.endsWith(".md"))
        .sort(),
    ).toEqual(ids.map((id) => `${id}.md`).sort());
  });
  it("only includes the software-development and writing categories", () => {
    expect([
      ...new Set(bundledPromptTemplates.map((item) => item.categoryId)),
    ]).toEqual(["software-development", "writing"]);
  });
  it.each(allowlist)(
    "preserves the pinned bytes and raw imported body: $id",
    ({ id, sha256 }) => {
      const bytes = readFileSync(
        resolve(`src/config/prompt-templates/${id}.md`),
      );
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
      expect(
        bundledPromptTemplates.find((item) => item.id === id)?.content,
      ).toBe(bytes.toString("utf8"));
      expect(bytes.includes(13)).toBe(false);
    },
  );
});
