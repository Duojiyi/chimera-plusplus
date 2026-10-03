//! v17 user notes on Skills and MCP servers (`notes` column).
//!
//! Notes are only written here; the regular saves leave the column alone.
use std::collections::HashMap;

use crate::database::{lock_conn, Database};
use crate::error::AppError;
use rusqlite::params;

// Adapted from yynxxxxx/Codex-X (MIT), apps/desktop/src-tauri/src/skills_mcp/mod.rs
// at 8f018fddd3ee1a68464e4df8765eb370ede0c76f: trimmed notes, 1000 Unicode characters.
const NOTE_MAX_CHARS: usize = 1000;

/// Tables that carry a `notes` column.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotesTable {
    Skills,
    McpServers,
}

impl NotesTable {
    fn name(self) -> &'static str {
        match self {
            NotesTable::Skills => "skills",
            NotesTable::McpServers => "mcp_servers",
        }
    }
}

impl Database {
    /// Non-empty notes by row id.
    pub fn get_notes(&self, table: NotesTable) -> Result<HashMap<String, String>, AppError> {
        let conn = lock_conn!(self.conn);
        let sql = format!(
            "SELECT id, notes FROM {} WHERE notes IS NOT NULL AND trim(notes) <> ''",
            table.name()
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| AppError::Database(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| AppError::Database(e.to_string()))?;
        rows.collect::<Result<_, _>>()
            .map_err(|e| AppError::Database(e.to_string()))
    }

    /// Sets (or clears, with `None` or whitespace-only) one row's note.
    /// `false` when the row does not exist.
    pub fn set_notes(
        &self,
        table: NotesTable,
        id: &str,
        notes: Option<&str>,
    ) -> Result<bool, AppError> {
        let normalized = notes.map(str::trim).filter(|s| !s.is_empty());
        if normalized.is_some_and(|value| value.chars().count() > NOTE_MAX_CHARS) {
            return Err(AppError::InvalidInput(format!(
                "备注不能超过 {NOTE_MAX_CHARS} 个字符"
            )));
        }
        let conn = lock_conn!(self.conn);
        let sql = format!("UPDATE {} SET notes = ?1 WHERE id = ?2", table.name());
        let affected = conn
            .execute(&sql, params![normalized, id])
            .map_err(|e| AppError::Database(e.to_string()))?;
        Ok(affected > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notes_limit_counts_unicode_characters_and_preserves_previous_value() {
        let db = Database::memory().unwrap();
        db.conn
            .lock()
            .unwrap()
            .execute_batch(
                "INSERT INTO skills (id, name, directory) VALUES ('local:test', 'test', 'test');",
            )
            .unwrap();
        let accepted = "界".repeat(NOTE_MAX_CHARS);
        assert!(db
            .set_notes(NotesTable::Skills, "local:test", Some(&accepted))
            .unwrap());
        let rejected = "界".repeat(NOTE_MAX_CHARS + 1);
        assert!(db
            .set_notes(NotesTable::Skills, "local:test", Some(&rejected))
            .is_err());
        assert_eq!(
            db.get_notes(NotesTable::Skills).unwrap()["local:test"],
            accepted
        );
    }

    #[test]
    fn notes_round_trip_and_clear() {
        let db = Database::memory().expect("memory db");
        {
            let conn = db.conn.lock().expect("lock");
            conn.execute_batch(
                "INSERT INTO mcp_servers (id, name, server_config) VALUES ('github', 'github', '{}');
                 INSERT INTO skills (id, name, directory) VALUES ('local:pdf', 'pdf', 'pdf');",
            )
            .expect("seed");
        }
        assert!(db
            .set_notes(NotesTable::McpServers, "github", Some("读 PR 与 issue"))
            .unwrap());
        assert!(db
            .set_notes(NotesTable::Skills, "local:pdf", Some("pdf note"))
            .unwrap());
        assert!(!db
            .set_notes(NotesTable::Skills, "missing", Some("x"))
            .unwrap());
        assert_eq!(
            db.get_notes(NotesTable::McpServers).unwrap().get("github"),
            Some(&"读 PR 与 issue".to_string())
        );
        // Whitespace only clears note
        assert!(db
            .set_notes(NotesTable::McpServers, "github", Some("   "))
            .unwrap());
        assert!(db.get_notes(NotesTable::McpServers).unwrap().is_empty());

        assert!(db.set_notes(NotesTable::Skills, "local:pdf", None).unwrap());
        assert!(db.get_notes(NotesTable::Skills).unwrap().is_empty());
    }
}
