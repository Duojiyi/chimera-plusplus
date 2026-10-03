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

/// Plan from the exact bytes the user previewed; never re-read and adopt a
/// newer config as the CAS baseline. Refuse unrelated sanitizer changes.
pub(crate) fn plan_observed_config(
    snapshot: FileSnapshot,
    config: &str,
) -> Result<PlannedCodexLiveWrite, AppError> {
    if snapshot.path() != get_codex_config_path().as_path() {
        return Err(AppError::InvalidInput("配置快照路径不匹配。".into()));
    }
    let prepared = prepare_config_text(config)?;
    if prepared != config {
        return Err(AppError::InvalidInput(
            "配置还有其他待处理设置，请重新检查。".into(),
        ));
    }
    let mut changeset = Changeset::new();
    changeset.write(snapshot, prepared.into_bytes())?;
    Ok(PlannedCodexLiveWrite { changeset })
}

/// Adds a restored config to the caller's atomic multi-file changeset, using
/// the same validation as every other live write and the already-read CAS baseline.
pub(crate) fn plan_restored_config(
    changeset: &mut Changeset,
    snapshot: FileSnapshot,
    bytes: &[u8],
) -> Result<(), AppError> {
    if snapshot.path() != get_codex_config_path().as_path() {
        return Err(AppError::InvalidInput("配置快照路径不匹配。".into()));
    }
    let config = std::str::from_utf8(bytes)
        .map_err(|_| AppError::Config("备份中的 config.toml 不是 UTF-8 文本".into()))?;
    changeset.write(snapshot, prepare_config_text(config)?.into_bytes())?;
    Ok(())
}

/// L5 gate: validate model_instructions_file references.
/// Codex 0.157 fails to start if an instructions file does not exist (line 3957)
/// or is empty (line 4513).
///
/// Chimera-owned instructions live in `chimera/instructions/`.
/// When an instruction file reference is a chimera-owned pointer that is dangling
/// (missing or empty), this gate strips the dangling pointer from `config.toml`
/// so Codex will still start safely. External/user paths are preserved verbatim.
pub(crate) fn validate_instruction_refs(toml_text: &str) -> Result<String, AppError> {
    if !toml_text.contains("model_instructions_file") {
        return Ok(toml_text.to_string());
    }

    let mut doc = match toml_text.parse::<toml_edit::DocumentMut>() {
        Ok(doc) => doc,
        Err(_) => return Ok(toml_text.to_string()),
    };

    let codex_dir = crate::codex_config::get_codex_config_dir();
    let mut modified = false;

    let check_ref = |raw_val: &str| -> Result<bool, AppError> {
        let resolved = if std::path::Path::new(raw_val).is_absolute() {
            PathBuf::from(raw_val)
        } else {
            codex_dir.join(raw_val)
        };
        // Ownership requires a strict descendant of our configured directory,
        // not a matching substring or a traversal through another directory.
        let owned_root = codex_dir.join("chimera/instructions");
        let is_owned = resolved.strip_prefix(&owned_root).is_ok_and(|relative| {
            !relative.as_os_str().is_empty()
                && relative
                    .components()
                    .all(|part| matches!(part, std::path::Component::Normal(_)))
                && resolved
                    .ancestors()
                    .find(|parent| !matches!(std::fs::symlink_metadata(parent), Err(error) if error.kind() == std::io::ErrorKind::NotFound))
                    .is_some_and(|parent| {
                        crate::security_limits::canonicalize_within_root(parent, &codex_dir).is_ok()
                    })
        });
        let is_dangling = match std::fs::metadata(&resolved) {
            Ok(meta) => meta.len() == 0,
            Err(_) => true,
        };
        if is_dangling {
            if is_owned {
                // Strip dangling chimera-owned instruction files
                Ok(true)
            } else {
                // Fail closed for broken external user paths: Codex 0.157 crashes on missing/empty files
                Err(AppError::Message(
                    "指令文件不存在或为空文件，Codex 0.157 拒载该配置。请修正路径或补充内容。"
                        .to_string(),
                ))
            }
        } else {
            Ok(false)
        }
    };

    if let Some(val) = doc.get("model_instructions_file").and_then(|v| v.as_str()) {
        if check_ref(val)? {
            log::warn!("Stripping dangling chimera instructions file pointer");
            doc.remove("model_instructions_file");
            modified = true;
        }
    }

    if let Some(profiles) = doc.get_mut("profiles").and_then(|p| p.as_table_like_mut()) {
        for (_name, profile_item) in profiles.iter_mut() {
            if let Some(table) = profile_item.as_table_like_mut() {
                if let Some(val) = table
                    .get("model_instructions_file")
                    .and_then(|v| v.as_str())
                {
                    if check_ref(val)? {
                        log::warn!("Stripping dangling profile instructions file pointer");
                        table.remove("model_instructions_file");
                        modified = true;
                    }
                }
            }
        }
    }

    if modified {
        Ok(doc.to_string())
    } else {
        Ok(toml_text.to_string())
    }
}

/// Every `config.toml` text passes here before it is planned: settings
/// Codex rejects wholesale are removed and the result must parse.
fn prepare_config_text(text: &str) -> Result<String, AppError> {
    let text = crate::codex_config::strip_rejected_codex_settings(text)?;
    let text = validate_instruction_refs(&text)?;
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

    #[test]
    #[serial]
    fn validate_instruction_refs_strips_dangling_chimera_instructions() {
        let _home = TestHome::new();
        let input = r#"model = "gpt-4o"
model_instructions_file = "chimera/instructions/nonexistent.md"

[profiles.custom]
model = "claude-3-7-sonnet"
model_instructions_file = "chimera/instructions/empty.md"
"#;
        // Create the empty file to test empty file stripping
        let empty_path =
            crate::codex_config::get_codex_config_dir().join("chimera/instructions/empty.md");
        std::fs::create_dir_all(empty_path.parent().unwrap()).unwrap();
        std::fs::write(&empty_path, b"").unwrap();

        let output = validate_instruction_refs(input).unwrap();
        assert!(
            !output.contains("chimera/instructions/nonexistent.md"),
            "missing instructions file must be stripped: {output}"
        );
        assert!(
            !output.contains("chimera/instructions/empty.md"),
            "empty instructions file must be stripped: {output}"
        );
        assert!(output.contains("model = \"gpt-4o\""));
        assert!(output.contains("[profiles.custom]"));
    }

    #[test]
    #[serial]
    fn validate_instruction_refs_preserves_external_and_valid_instructions() {
        let _home = TestHome::new();
        let valid_path =
            crate::codex_config::get_codex_config_dir().join("chimera/instructions/valid.md");
        std::fs::create_dir_all(valid_path.parent().unwrap()).unwrap();
        std::fs::write(&valid_path, b"You are an assistant.").unwrap();

        let ext_dir = tempfile::tempdir().unwrap();
        let ext_path = ext_dir.path().join("instructions.md");
        std::fs::write(&ext_path, b"External instructions").unwrap();
        let ext_str = ext_path.to_str().unwrap().replace('\\', "/");

        let input = format!(
            r#"model = "gpt-4o"
model_instructions_file = "chimera/instructions/valid.md"

[profiles.user]
model = "custom"
model_instructions_file = "{ext_str}"
"#
        );
        let output = validate_instruction_refs(&input).unwrap();
        assert!(
            output.contains("chimera/instructions/valid.md"),
            "valid instructions file must be preserved"
        );
        assert!(
            output.contains(&ext_str),
            "user external instructions file must be preserved"
        );
    }

    #[test]
    #[serial]
    fn instructions_ownership_rejects_lookalikes_and_traversal() {
        let _home = TestHome::new();
        let codex_dir = crate::codex_config::get_codex_config_dir();
        fs::create_dir_all(codex_dir.join("chimera/instructions")).unwrap();
        let outside = tempfile::tempdir().unwrap();
        let lookalike = outside.path().join("chimera/instructions/missing.md");
        for path in [
            lookalike.to_string_lossy().replace('\\', "/"),
            "chimera/instructions/../../private-missing.md".to_string(),
            "other/chimera/instructions/missing.md".to_string(),
        ] {
            let input = format!("model_instructions_file = '{}'\n", path);
            let error = validate_instruction_refs(&input).unwrap_err().to_string();
            assert!(
                !error.contains(&path),
                "must not disclose the external path"
            );
        }
        let absolute = codex_dir.join("chimera/instructions/missing.md");
        let input = format!(
            "model_instructions_file = '{}'\n",
            absolute.to_string_lossy()
        );
        assert!(!validate_instruction_refs(&input)
            .unwrap()
            .contains("model_instructions_file"));
    }

    #[cfg(unix)]
    #[test]
    #[serial]
    fn instructions_ownership_rejects_symlink_targets() {
        let _home = TestHome::new();
        let owned = crate::codex_config::get_codex_config_dir().join("chimera/instructions");
        fs::create_dir_all(&owned).unwrap();
        let outside = tempfile::tempdir().unwrap();
        let empty = outside.path().join("empty.md");
        fs::write(&empty, "").unwrap();
        std::os::unix::fs::symlink(&empty, owned.join("linked.md")).unwrap();
        std::os::unix::fs::symlink(outside.path(), owned.join("linked-dir")).unwrap();
        for path in [
            "chimera/instructions/linked.md",
            "chimera/instructions/linked-dir/missing.md",
        ] {
            let input = format!("model_instructions_file = '{}'\n", path);
            assert!(validate_instruction_refs(&input).is_err());
        }
        assert_eq!(fs::read_to_string(empty).unwrap(), "");
    }

    #[test]
    #[serial]
    fn validate_instruction_refs_fails_closed_on_broken_external_instructions() {
        let _home = TestHome::new();
        let input = r#"model = "gpt-4o"
model_instructions_file = "/nonexistent/external/path.md"
"#;
        let err = validate_instruction_refs(input).unwrap_err();
        assert!(err.to_string().contains("Codex 0.157 拒载该配置"));
    }
}
