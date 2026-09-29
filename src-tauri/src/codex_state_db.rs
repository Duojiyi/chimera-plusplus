//! Locating Codex's per-thread state SQLite databases.
//!
//! Codex stores thread metadata in `state_5.sqlite`, normally inside the Codex
//! config dir (`CODEX_HOME` / `~/.codex`). The SQLite location can be moved with
//! the `sqlite_home` key in `config.toml` or the `CODEX_SQLITE_HOME` env var;
//! when set, a second DB lives there. Both history migration and the session
//! list's title lookup need the same resolution, so it lives here once.

use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{backup::Backup, Connection};
use toml_edit::DocumentMut;

use crate::config::get_home_dir;

/// Filename of Codex's per-thread state database. Codex bumps the version
/// number across releases; update this single source of truth when a new state
/// DB version ships.
pub(crate) const CODEX_STATE_DB_FILENAME: &str = "state_5.sqlite";

/// Env var that overrides the Codex SQLite state directory.
const CODEX_SQLITE_HOME_ENV: &str = "CODEX_SQLITE_HOME";

// Adapted from openai/codex codex-rs/state/src/sqlite.rs (MIT)
/// The per-thread SQLite files Codex 0.157 keeps side by side in one SQLite
/// home (`RUNTIME_DBS` in `state/src/sqlite.rs`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CodexRuntimeDb {
    Logs,
    Queue,
    Memories,
    MemoriesV2,
    Goals,
    ThreadHistory,
    State,
}

impl CodexRuntimeDb {
    /// The order `delete_threads_strict` clears a thread in: logs, queue,
    /// memories, goals, then the state DB. The state DB is last because its
    /// spawn edges and thread rows are what a retry needs to find the same
    /// subtree again. Thread history (cleared separately by the thread store)
    /// goes just before it.
    pub(crate) const DELETE_ORDER: [Self; 7] = [
        Self::Logs,
        Self::Queue,
        Self::Memories,
        Self::MemoriesV2,
        Self::Goals,
        Self::ThreadHistory,
        Self::State,
    ];

    pub(crate) const fn filename(self) -> &'static str {
        match self {
            Self::Logs => "logs_2.sqlite",
            Self::Queue => "queue_1.sqlite",
            Self::Memories => "memories_1.sqlite",
            Self::MemoriesV2 => "memories_v2_1.sqlite",
            Self::Goals => "goals_1.sqlite",
            Self::ThreadHistory => "thread_history_1.sqlite",
            Self::State => CODEX_STATE_DB_FILENAME,
        }
    }
}

/// Resolve every candidate SQLite home: the config dir plus, when Codex is
/// configured to keep its SQLite state elsewhere, that directory too.
///
/// `config_dir` is the Codex config dir (`~/.codex`); `config_text` is the raw
/// `config.toml` contents, used to detect a `sqlite_home` override.
pub(crate) fn codex_sqlite_homes(config_dir: &Path, config_text: &str) -> Vec<PathBuf> {
    let mut homes = Vec::new();
    push_unique_path(&mut homes, config_dir.to_path_buf());
    // Codex lets SQLite state move away from CODEX_HOME; config takes precedence.
    if let Some(sqlite_home) = sqlite_home_from_codex_config(config_text) {
        push_unique_path(&mut homes, sqlite_home);
    } else if let Some(sqlite_home) = sqlite_home_from_env() {
        push_unique_path(&mut homes, sqlite_home);
    }
    homes
}

/// Resolve every candidate `state_5.sqlite` path, one per SQLite home.
pub(crate) fn codex_state_db_paths(config_dir: &Path, config_text: &str) -> Vec<PathBuf> {
    codex_sqlite_homes(config_dir, config_text)
        .into_iter()
        .map(|home| home.join(CODEX_STATE_DB_FILENAME))
        .collect()
}

/// Copy a SQLite DB with the online backup API. Codex keeps its DBs open in
/// WAL mode, so a plain file copy can miss pages still in the `-wal` file.
pub(crate) fn backup_sqlite_online(
    source: &Connection,
    backup_path: &Path,
) -> rusqlite::Result<()> {
    let mut backup_conn = Connection::open(backup_path)?;
    let backup = Backup::new(source, &mut backup_conn)?;
    backup.run_to_completion(5, Duration::from_millis(25), None)?;
    Ok(())
}

fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.contains(&path) {
        paths.push(path);
    }
}

fn sqlite_home_from_codex_config(config_text: &str) -> Option<PathBuf> {
    let doc = config_text.parse::<DocumentMut>().ok()?;
    let raw = doc.get("sqlite_home")?.as_str()?.trim();
    if raw.is_empty() {
        return None;
    }
    Some(resolve_user_path(raw))
}

fn sqlite_home_from_env() -> Option<PathBuf> {
    let raw = std::env::var(CODEX_SQLITE_HOME_ENV).ok()?;
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    Some(resolve_user_path(raw))
}

fn resolve_user_path(raw: &str) -> PathBuf {
    if raw == "~" {
        return get_home_dir();
    }
    if let Some(rest) = raw.strip_prefix("~/") {
        return get_home_dir().join(rest);
    }
    if let Some(rest) = raw.strip_prefix("~\\") {
        return get_home_dir().join(rest);
    }
    PathBuf::from(raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn includes_config_sqlite_home() {
        let temp = tempdir().expect("tempdir");
        let sqlite_home = temp.path().join("sqlite-home");
        // 用 TOML 字面量字符串(单引号)承载路径：Windows 路径含反斜杠，basic string(双引号)
        // 会把 `\U`/`\s` 等当作非法转义导致解析失败。
        let config_text = format!("sqlite_home = '{}'\n", sqlite_home.display());

        let paths = codex_state_db_paths(temp.path(), &config_text);

        assert_eq!(
            paths,
            vec![
                temp.path().join(CODEX_STATE_DB_FILENAME),
                sqlite_home.join(CODEX_STATE_DB_FILENAME),
            ]
        );
        assert_eq!(
            codex_sqlite_homes(temp.path(), &config_text),
            vec![temp.path().to_path_buf(), sqlite_home]
        );
        // An override naming the config dir itself is one home, not two.
        let same = format!("sqlite_home = '{}'\n", temp.path().display());
        assert_eq!(
            codex_sqlite_homes(temp.path(), &same),
            vec![temp.path().to_path_buf()]
        );
    }

    #[test]
    fn runtime_db_filenames_match_codex_0_157() {
        let names: Vec<_> = CodexRuntimeDb::DELETE_ORDER
            .iter()
            .map(|db| db.filename())
            .collect();
        assert_eq!(
            names,
            vec![
                "logs_2.sqlite",
                "queue_1.sqlite",
                "memories_1.sqlite",
                "memories_v2_1.sqlite",
                "goals_1.sqlite",
                "thread_history_1.sqlite",
                "state_5.sqlite",
            ]
        );
    }

    #[test]
    fn online_backup_includes_rows_still_in_the_wal() {
        let temp = tempdir().expect("tempdir");
        let db_path = temp.path().join(CODEX_STATE_DB_FILENAME);
        // Codex keeps its writer open in WAL mode, so committed rows can sit in
        // the -wal file that a plain copy of the main file would miss.
        let writer = Connection::open(&db_path).unwrap();
        let mode: String = writer
            .query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        writer
            .execute_batch(
                "CREATE TABLE threads (id TEXT PRIMARY KEY); INSERT INTO threads VALUES ('t1');",
            )
            .unwrap();

        let source = Connection::open(&db_path).unwrap();
        let backup_path = temp.path().join("backup.sqlite");
        backup_sqlite_online(&source, &backup_path).unwrap();
        drop(source);

        let backup = Connection::open(&backup_path).unwrap();
        let id: String = backup
            .query_row("SELECT id FROM threads", [], |row| row.get(0))
            .unwrap();
        assert_eq!(id, "t1");
        drop(writer);
    }
}
