// Source-contract checks only: these do not execute Rust or prove race freedom.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const commands = readFileSync(
  "src-tauri/src/commands/import_export.rs",
  "utf8",
);
const shared = readFileSync("src-tauri/src/commands/sync_support.rs", "utf8");
const database = readFileSync("src-tauri/src/database/backup.rs", "utf8");

function ordered(body: string, steps: string[]) {
  const positions = steps.map((step) => body.indexOf(step));
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
}

describe("backup restore safety wiring", () => {
  it("uses shared state for restore, SQL import and explicit Live sync", () => {
    expect(commands + shared).not.toContain("AppState::new(");
    for (const name of [
      "restore_db_backup",
      "import_config_from_file",
      "sync_current_providers_live",
    ]) {
      const body = commands
        .slice(commands.indexOf(`pub async fn ${name}`))
        .split("\n}\n")[0];
      expect(body).toContain("state.inner().clone()");
      expect(body).toContain("with_stopped_proxy(&state");
    }
  });

  it("holds profile and lifecycle guards before the running check and mutation", () => {
    const lock = shared.slice(
      shared.indexOf("pub(crate) async fn lock_import_runtime"),
      shared.indexOf("pub(crate) async fn lock_import_apps"),
    );
    ordered(lock, [
      "profile_apply_lock.clone().lock_owned()",
      "lock_lifecycle()",
      "is_running()",
      "ensure_no_takeover(state)?",
      "Ok((profile_guard, lifecycle_guard))",
    ]);
    const worker = shared.slice(
      shared.indexOf("pub(crate) fn with_stopped_proxy"),
      shared.indexOf("fn ensure_no_takeover"),
    );
    ordered(worker, [
      "let _guards = futures::executor::block_on(lock_import_runtime(state))?",
      "operation()",
    ]);
    const replace = shared.slice(
      shared.indexOf("pub(crate) fn replace_database"),
      shared.indexOf("pub(crate) fn run_post_import_sync"),
    );
    ordered(replace, [
      "lock_import_apps(state)",
      "ensure_no_takeover(state)?",
      "replace()",
    ]);
  });

  it("rejects staged backup runtime flags before safety snapshot and DB replacement", () => {
    const restore = database.slice(
      database.indexOf("pub fn restore_from_backup"),
    );
    ordered(restore, [
      "Self::apply_schema_migrations_on_conn",
      "Self::validate_stopped_proxy_state_on_conn(&staging_conn)?",
      "self.backup_database_file()?",
      "Backup::new(&staged_conn, &mut main_conn)",
    ]);
    expect(database).toContain("enabled != 0 OR proxy_enabled != 0");
    expect(database).toContain("OR EXISTS(SELECT 1 FROM proxy_live_backup)");
  });

  it("validates final local and cloud SQL state after preservation and before commit", () => {
    const sql = database.slice(
      database.indexOf("fn import_sql_string_inner"),
      database.indexOf("pub(crate) fn snapshot_to_memory"),
    );
    ordered(sql, [
      "Self::validate_basic_state(&temp_conn)?",
      "Self::restore_tables(local_snapshot, &temp_conn, preserve_tables)?",
      "Self::validate_stopped_proxy_state_on_conn(&temp_conn)?",
      "self.backup_database_file()?",
      "Backup::new(&temp_conn, &mut main_conn)",
    ]);
    expect(sql).not.toMatch(
      /if preserve_tables\.is_empty\(\) \{\s*Self::validate_stopped_proxy_state_on_conn\(&temp_conn\)\?;/,
    );
    expect(sql).toContain(
      "Self::restore_tables(local_snapshot, &temp_conn, preserve_tables)?",
    );
  });

  it("rechecks restored state before provider sync and separates commit from post-sync warning", () => {
    const sync = shared.slice(
      shared.indexOf("pub(crate) fn run_post_import_sync"),
      shared.indexOf("pub(crate) fn post_import_warning"),
    );
    ordered(sync, [
      "reload_settings()?",
      "ensure_no_takeover(state)?",
      "ProviderService::sync_current_to_live(state)",
    ]);
    const restore = commands.slice(
      commands.indexOf("pub async fn restore_db_backup"),
    );
    ordered(restore, [
      "replace_database(&state",
      "post_import_warning(&state)",
    ]);
    expect(commands).toContain('"dbRestored": true');
  });

  it.each(["s3", "webdav"])(
    "guards %s download before snapshot replacement and carries guards into post-sync",
    (kind) => {
      const source = readFileSync(
        `src-tauri/src/commands/${kind}_sync.rs`,
        "utf8",
      );
      const body = source
        .slice(source.indexOf(`pub async fn ${kind}_sync_download`))
        .split("\n#[tauri::command]")[0];
      expect(body).toContain("state.inner().clone()");
      expect(source).not.toContain("AppState::new(");
      expect(body).not.toContain("db_for_sync");
      ordered(body, [
        "lock_import_runtime(&state)",
        "lock_import_apps(&state)",
        `${kind}_sync_service::download(&db`,
        "drop(app_guards)",
        "spawn_blocking(move ||",
        "let _guards = guards",
        "let _suppression = _auto_sync_suppression",
        "run_post_import_sync(&state)",
        "attach_warning(result, warning)",
      ]);
    },
  );
});
