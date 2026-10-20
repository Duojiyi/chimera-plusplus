import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { providersApi } from "@/lib/api/providers";
import type { Provider } from "@/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const provider: Provider = { id: "line", name: "Line", settingsConfig: {} };

beforeEach(() => vi.mocked(invoke).mockReset().mockResolvedValue(true));

describe("Codex configuration apply IPC", () => {
  it("sends the provider and new common text in one activation request", async () => {
    await providersApi.addAndActivate(
      provider,
      "codex",
      false,
      "personality = 'friendly'",
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("add_and_activate_provider", {
      provider,
      app: "codex",
      addToLive: false,
      commonConfigSnippet: "personality = 'friendly'",
    });
  });

  it("does not drop an explicitly cleared common draft", async () => {
    await providersApi.updateAndActivate(provider, "codex", "original", {
      clearApiKey: true,
      commonConfigSnippet: "",
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("update_and_activate_provider", {
      provider,
      app: "codex",
      originalId: "original",
      clearApiKey: true,
      commonConfigSnippet: "",
    });
  });

  it("leaves common text unchanged when no draft was submitted", async () => {
    await providersApi.updateAndActivate(provider, "codex", provider.id);
    expect(invoke).toHaveBeenCalledWith("update_and_activate_provider", {
      provider,
      app: "codex",
      originalId: provider.id,
      clearApiKey: undefined,
      commonConfigSnippet: undefined,
    });
  });
});

// Static source guards only. These do not compile or execute Rust transactions.
const readRust = (relative: string) =>
  fs.readFileSync(
    path.resolve(__dirname, "../../src-tauri/src", relative),
    "utf8",
  );
const commands = readRust("commands/provider.rs");

describe("Codex transaction source guards", () => {
  it("keeps route write receipts until provider activation commits", () => {
    const undo = commands.slice(
      commands.indexOf("struct CodexRoutingUndo"),
      commands.indexOf("fn import_default_config_internal("),
    );
    expect(undo).toContain("set_takeover_for_app_inner_receipted");
    expect(undo).toContain("receipts.into_iter().rev()");
    expect(undo).toContain("receipt.rollback()");
    expect(undo).toContain("undo.restore(state, codex_routing_receipts).await");
    expect(undo).toContain("restore_provider_update_selection");
    expect(undo).toContain("restore_runtime_state_inner");
  });

  it("compensates fallible reads after staging a fresh provider", () => {
    const add = commands.slice(
      commands.indexOf("async fn add_provider_with_automatic_routing_locked("),
      commands.indexOf("fn compensate_failed_direct_provider_add("),
    );
    const staged = add.indexOf("ProviderService::add_inactive(");
    expect(add.indexOf("let result = async {")).toBeLessThan(staged);
    expect(add.indexOf("let previous_selection")).toBeLessThan(staged);
    expect(add).toContain("initialize_codex_live_for_takeover");
    expect(add).toContain("initial_codex_receipt");
    expect(add).toContain("compensate_failed_provider_add(");
    expect(add).toContain("previous_selection.as_ref()");
  });

  it("clears an in-memory target when rollback restores no current provider", () => {
    const proxy = readRust("services/proxy.rs");
    const refresh = proxy.slice(
      proxy.indexOf(
        "pub(crate) async fn refresh_active_target_from_current_provider(",
      ),
      proxy.indexOf("async fn rollback_hot_switch_preparation("),
    );
    expect(refresh).toContain(
      "None => server.clear_active_target(app_type.as_str()).await",
    );
    expect(readRust("proxy/server.rs")).toContain(
      "self.state.current_providers.write().await.remove(app_type)",
    );
  });

  it("uses the staged target when first takeover has no current selection", () => {
    expect(commands).toContain(
      "previous_provider_id.is_none().then_some(&target)",
    );
    const proxy = readRust("services/proxy.rs");
    expect(proxy).toContain("Some(provider) => provider.clone()");
    expect(commands).toContain(
      "first_unlogged_codex_chat_provider_activates_automatic_routing",
    );
  });

  it("retains direct and taken-over hot-switch receipts until selection commits", () => {
    const proxy = readRust("services/proxy.rs");
    const hotSwitch = proxy.slice(
      proxy.indexOf("pub(crate) async fn hot_switch_provider_inner("),
      proxy.indexOf("async fn lock_switch_for_test("),
    );
    expect(hotSwitch).toContain(
      "sync_codex_live_from_provider_while_proxy_active_receipted(&provider)",
    );
    expect(hotSwitch).toContain("write_codex_provider_live_with_catalog(");
    expect(hotSwitch.match(/codex_receipts\.push\(/g)).toHaveLength(2);
    expect(hotSwitch.match(/previous_selection\.as_ref\(\)/g)).toHaveLength(3);
    expect(proxy).toContain(
      "codex_taken_over_live_write_rolls_back_when_provider_commit_fails",
    );
  });

  it("keeps listener update receipts through failures in later apps", () => {
    const proxy = readRust("services/proxy.rs");
    const update = proxy.slice(
      proxy.indexOf("pub async fn update_config("),
      proxy.indexOf("pub async fn is_running("),
    );
    expect(update).toContain("codex_receipts.push(receipt)");
    expect(update).toContain(
      "Self::rollback_codex_live_writes(codex_receipts)",
    );
    expect(proxy).toContain(
      "later_app_takeover_failure_restores_codex_files_and_old_listener",
    );
  });

  it("tracks which empty parent tables the common projection created", () => {
    const projection = readRust("codex_common_projection.rs");
    expect(projection).toContain("created_parents: BTreeSet<Vec<String>>");
    expect(projection).toContain(
      "prune_created_parents(&mut out, &mut created_parents)",
    );
    expect(projection).toContain(
      "cleanup_preserves_preexisting_empty_normal_and_inline_tables",
    );
    expect(projection).toContain(
      "shared_generated_parents_are_removed_only_after_last_common_leaf",
    );
  });
});

// Legacy-ownership wiring guards; Rust behavior is covered by Rust regression
// test sources, which are not executed by this frontend test suite.
describe("Legacy Codex common-config ownership source guards", () => {
  it("repairs old persisted snippets during startup even after prior usage migration", () => {
    const startup = readRust("lib.rs").split(
      "fn initialize_common_config_snippets(",
    )[1];
    expect(startup).toBeTruthy();
    expect(
      startup.indexOf("migrate_legacy_codex_common_config()"),
    ).toBeLessThan(startup.indexOf("should_auto_extract_config_snippet("));
    expect(
      startup.indexOf("migrate_legacy_codex_common_config()"),
    ).toBeLessThan(startup.indexOf("is_legacy_common_config_migrated()"));
  });

  it("also repairs ordinary line edits without requiring a common draft", () => {
    const apply = commands.slice(
      commands.indexOf("async fn apply_codex_configuration("),
      commands.indexOf(
        "pub(crate) async fn update_provider_with_automatic_routing_state(",
      ),
    );
    expect(apply.indexOf("migrate_legacy_codex_common_config()")).toBeLessThan(
      apply.indexOf("if let Some(text) = snippet {"),
    );
    expect(apply).toContain(
      "preserve_legacy_codex_edit_intent(&mut change, &undo)",
    );
    expect(apply).toContain("let mut errors = undo.restore(&state)");
    const staleEdit = commands.slice(
      commands.indexOf("fn preserve_legacy_codex_edit_intent("),
      commands.indexOf("async fn apply_codex_configuration("),
    );
    expect(staleEdit).toContain("CodexConfigurationChange::Update");
    expect(staleEdit).toContain("previously_enabled && *enabled");
  });

  it("covers plain add and update without implicitly activating inactive lines", () => {
    for (const name of ["add_provider", "update_provider"]) {
      const command = commands
        .split(`pub async fn ${name}(`)[1]
        ?.split("#[tauri::command]")[0];
      expect(command).toContain("return apply_codex_configuration(");
      expect(command).toMatch(/None,\s*false,\s*\)/);
    }
    const apply = commands.slice(
      commands.indexOf("async fn apply_codex_configuration("),
      commands.indexOf(
        "pub(crate) async fn update_provider_with_automatic_routing_state(",
      ),
    );
    expect(apply).toContain("add_to_live, activate_when_inactive).await");
    expect(apply).toContain(
      "original_id, provider, activate_when_inactive).await",
    );
    expect(readRust("codex_key_ownership.rs")).toContain(
      "fn legacy_common_sanitizer_removes_newly_empty_protected_parents()",
    );
  });

  it("snapshots raw JSON and restores it after the typed row restore", () => {
    const undo = commands.slice(
      commands.indexOf("struct CodexCommonConfigUndo"),
      commands.indexOf("async fn seed_legacy_codex_common_projection("),
    );
    expect(undo).toContain('snapshot_provider_config_rows("codex")');
    expect(undo).toContain(
      'restore_provider_config_rows("codex", &self.provider_configs)',
    );
    expect(undo.indexOf("restore_provider_config_rows(")).toBeGreaterThan(
      undo.indexOf('save_provider("codex", provider)'),
    );
  });

  it("uses one ownership collector for validation and migration sanitization", () => {
    const ownership = readRust("codex_key_ownership.rs");
    const sanitizer = ownership.slice(
      ownership.indexOf(
        "pub(crate) fn sanitize_codex_common_snippet_with_report(",
      ),
      ownership.indexOf("pub(crate) fn inherit_legacy_codex_line_preferences("),
    );
    expect(sanitizer).toContain("collect_common_snippet_conflicts(");
    expect(sanitizer).toContain("remove_path(doc.as_table_mut(), &path)");
    const extraction = readRust("services/provider/mod.rs")
      .split("fn extract_codex_common_config(settings: &Value)")[1]
      ?.split("fn extract_gemini_common_config(")[0];
    expect(extraction).toContain(
      "sanitize_codex_common_snippet_with_report(config_toml)",
    );
  });

  it("migrates atomically and infers opt-in against the original snippet", () => {
    const ownership = readRust("services/provider/codex_ownership.rs");
    expect(ownership).toContain("let tx = conn.transaction()?");
    expect(ownership).toContain("tx.commit()?");
    expect(ownership).toContain("explicit == Some(false)");
    expect(ownership).toMatch(
      /settings_contain_common_config\([\s\S]*?&settings,\s*&old/,
    );
    expect(ownership).toContain("INSERT OR IGNORE INTO settings");
    expect(ownership).toContain("common_config_codex_legacy_backup_v1");
    expect(
      ownership.indexOf("migrate_legacy_codex_common_config()?"),
    ).toBeLessThan(
      ownership.indexOf("sanitize_untrusted_codex_config(config, official)"),
    );
  });
});
