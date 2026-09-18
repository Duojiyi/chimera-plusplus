import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const app = fs.readFileSync(
  path.resolve(__dirname, "../../src/ChimeraApp.tsx"),
  "utf8",
);
const css = fs.readFileSync(
  path.resolve(__dirname, "../../src/chimera.css"),
  "utf8",
);

describe("route manager direct deletion", () => {
  it("deletes from a separate accessible action without opening the editor or closing the manager", () => {
    const button = app.slice(
      app.indexOf('className="route-line-edit route-line-delete"'),
      app.indexOf('className="route-line-edit route-line-delete"') + 1000,
    );
    expect(button).toContain("aria-label={`删除${lineName(provider)}`}");
    expect(button).toContain("onClick={() => void onDelete(provider)}");
    expect(button).not.toContain("setManagerOpen(false)");
    expect(button).not.toContain("onEdit(provider)");
    expect(app).toContain("onDelete={deleteProvider}");
    expect(app).toMatch(
      /isOfficialLine\(provider\)\s*\?\s*\([\s\S]*?由 Codex 管理[\s\S]*?:\s*\(\s*<div className="route-line-actions">/,
    );
  });

  it("protects the active line and prevents deletion while another operation is running", () => {
    const button = app.slice(
      app.indexOf('className="route-line-edit route-line-delete"'),
      app.indexOf('className="route-line-edit route-line-delete"') + 1000,
    );
    expect(button).toMatch(
      /disabled=\{\s*active\s*\|\|\s*Boolean\(deletingProviderId\)\s*\|\|\s*Boolean\(switchingId\)/,
    );
    expect(button).toContain("当前线路正在使用，请先切换到其他线路");
    expect(button).toContain("LoaderCircle");
    expect(app).toContain(
      "if (providerDeleteInFlightRef.current) return false;",
    );
  });

  it("shares backend deletion, refreshes the list, and resets the guard on failure", () => {
    const handler = app.slice(
      app.indexOf("  const deleteProvider ="),
      app.indexOf("  const fetchModels ="),
    );
    expect(handler).toContain('providersApi.delete(provider.id, "codex")');
    expect(handler).toContain(
      'if (!deleted) throw new Error("线路未删除，请重试")',
    );
    expect(handler).toContain("await loadProviders();");
    expect(handler).toContain('toast.error("删除失败"');
    expect(handler).toMatch(
      /finally\s*\{\s*providerDeleteInFlightRef.current = false;\s*setDeletingProviderId\(null\);/,
    );
    expect(app).toContain("if (await deleteProvider(pendingProviderDelete))");
  });

  it("keeps the edit and delete actions together with distinct danger styling", () => {
    expect(css).toMatch(/\.route-line-actions\s*\{[^}]*display: flex;/);
    expect(css).toContain(".route-line-delete:hover:not(:disabled)");
    expect(css).toContain(".route-line-actions button:disabled");
  });
});
