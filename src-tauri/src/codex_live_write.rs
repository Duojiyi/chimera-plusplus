//! The write primitive for Codex live files: `auth.json`, `config.toml` and
//! the generated model catalog.
//!
//! Every change is one CAS changeset ([`crate::config::cas`]): each target is
//! read first (its bytes kept in memory), the plan commits all-or-nothing, a
//! file changed by another program after it was read aborts the commit before
//! anything is written, and a failure part-way restores the prior bytes from
//! memory. Rolling back `auth.json` therefore never persists it anywhere else.

use std::path::PathBuf;

use serde_json::Value;

use crate::codex_config::{
    get_codex_auth_path, get_codex_config_path, get_codex_model_catalog_path,
};
use crate::config::cas::{AppliedChangeset, Changeset, ChangesetError, FileSnapshot};
use crate::error::AppError;

/// What to do with one live file.
#[derive(Debug, Clone, Copy)]
pub(crate) enum LiveFile<T> {
    /// Leave the file exactly as it is.
    Keep,
    Write(T),
    Delete,
}

impl<T> LiveFile<T> {
    /// Snapshot restore: a captured file is written back, a file that did
    /// not exist is deleted.
    pub(crate) fn restore(captured: Option<T>) -> Self {
        captured.map_or(Self::Delete, Self::Write)
    }
}

/// One change to Codex's live files.
#[derive(Debug, Clone, Copy)]
pub(crate) struct CodexLiveWrite<'a> {
    pub auth: LiveFile<&'a Value>,
    pub config: LiveFile<&'a str>,
    pub model_catalog: LiveFile<&'a str>,
}

impl<'a> CodexLiveWrite<'a> {
    pub(crate) fn config_only(config: &'a str) -> Self {
        Self {
            auth: LiveFile::Keep,
            config: LiveFile::Write(config),
            model_catalog: LiveFile::Keep,
        }
    }
}

/// A write whose targets have been read; nothing is on disk yet.
pub(crate) struct PlannedCodexLiveWrite {
    changeset: Changeset,
}

impl PlannedCodexLiveWrite {
    pub(crate) fn commit(self) -> Result<AppliedChangeset, AppError> {
        self.changeset.commit().map_err(AppError::from)
    }
}

fn plan_file(
    changeset: &mut Changeset,
    path: PathBuf,
    change: LiveFile<Vec<u8>>,
    private: bool,
) -> Result<(), ChangesetError> {
    match change {
        LiveFile::Keep => Ok(()),
        LiveFile::Write(bytes) if private => {
            changeset.write_private(FileSnapshot::read(path)?, bytes)
        }
        LiveFile::Write(bytes) => changeset.write(FileSnapshot::read(path)?, bytes),
        LiveFile::Delete => changeset.delete(FileSnapshot::read(path)?),
    }
}

/// Reads every target of `write` and plans it.
pub(crate) fn plan(write: CodexLiveWrite<'_>) -> Result<PlannedCodexLiveWrite, AppError> {
    let auth = match write.auth {
        LiveFile::Keep => LiveFile::Keep,
        LiveFile::Write(auth) => LiveFile::Write(crate::config::json_file_text(auth)?.into_bytes()),
        LiveFile::Delete => LiveFile::Delete,
    };
    let text = |change: LiveFile<&str>| match change {
        LiveFile::Keep => LiveFile::Keep,
        LiveFile::Write(text) => LiveFile::Write(text.as_bytes().to_vec()),
        LiveFile::Delete => LiveFile::Delete,
    };
    let config = match write.config {
        LiveFile::Write(config) => LiveFile::Write(prepare_config_text(config)?.into_bytes()),
        other => text(other),
    };

    let mut changeset = Changeset::new();
    // The catalog first and config.toml last: config.toml points at the
    // catalog, and a rollback runs in reverse.
    plan_file(
        &mut changeset,
        get_codex_model_catalog_path(),
        text(write.model_catalog),
        false,
    )?;
    plan_file(&mut changeset, get_codex_auth_path(), auth, true)?;
    plan_file(&mut changeset, get_codex_config_path(), config, false)?;
    Ok(PlannedCodexLiveWrite { changeset })
}

/// Every `config.toml` text passes here before it is planned: settings
/// Codex rejects wholesale are removed and the result must parse.
fn prepare_config_text(text: &str) -> Result<String, AppError> {
    let text = crate::codex_config::strip_rejected_codex_settings(text)?;
    crate::codex_config::validate_config_toml(&text)?;
    Ok(text)
}

/// Plans and commits `write`.
pub(crate) fn write_codex_live_files(
    write: CodexLiveWrite<'_>,
) -> Result<AppliedChangeset, AppError> {
    plan(write)?.commit()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use serial_test::serial;
    use std::fs;

    struct TestHome {
        _dir: tempfile::TempDir,
        previous: Option<std::ffi::OsString>,
    }

    impl TestHome {
        fn new() -> Self {
            let dir = tempfile::tempdir().expect("temp home");
            let previous = std::env::var_os("CC_SWITCH_TEST_HOME");
            std::env::set_var("CC_SWITCH_TEST_HOME", dir.path());
            crate::settings::reload_settings().expect("reload settings");
            Self {
                _dir: dir,
                previous,
            }
        }
    }

    impl Drop for TestHome {
        fn drop(&mut self) {
            match self.previous.take() {
                Some(value) => std::env::set_var("CC_SWITCH_TEST_HOME", value),
                None => std::env::remove_var("CC_SWITCH_TEST_HOME"),
            }
            let _ = crate::settings::reload_settings();
        }
    }

    #[test]
    #[serial]
    fn a_conflict_aborts_before_any_file_is_written() {
        let _home = TestHome::new();
        let auth = json!({"OPENAI_API_KEY": "sk-before"});
        crate::config::write_json_file(&get_codex_auth_path(), &auth).unwrap();
        crate::config::write_text_file(&get_codex_config_path(), "model = \"a\"\n").unwrap();

        let next_auth = json!({"OPENAI_API_KEY": "sk-after"});
        let planned = plan(CodexLiveWrite {
            auth: LiveFile::Write(&next_auth),
            config: LiveFile::Write("model = \"b\"\n"),
            model_catalog: LiveFile::Keep,
        })
        .unwrap();
        fs::write(get_codex_config_path(), "model = \"external\"\n").unwrap();

        let error = planned.commit().unwrap_err();
        assert!(matches!(
            error,
            AppError::Localized {
                key: "config.changeset_conflict",
                ..
            }
        ));
        let live_auth: Value = crate::config::read_json_file(&get_codex_auth_path()).unwrap();
        assert_eq!(live_auth, auth);
        assert_eq!(
            fs::read_to_string(get_codex_config_path()).unwrap(),
            "model = \"external\"\n"
        );
    }

    #[test]
    #[serial]
    fn restore_deletes_files_that_did_not_exist() {
        let _home = TestHome::new();
        crate::config::write_text_file(&get_codex_config_path(), "model = \"a\"\n").unwrap();
        crate::config::write_text_file(&get_codex_model_catalog_path(), "{}").unwrap();

        write_codex_live_files(CodexLiveWrite {
            auth: LiveFile::restore(None),
            config: LiveFile::restore(Some("model = \"b\"\n")),
            model_catalog: LiveFile::restore(None),
        })
        .unwrap();

        assert!(!get_codex_auth_path().exists());
        assert!(!get_codex_model_catalog_path().exists());
        assert_eq!(
            fs::read_to_string(get_codex_config_path()).unwrap(),
            "model = \"b\"\n"
        );
    }
}
