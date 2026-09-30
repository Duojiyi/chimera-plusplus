//! Per-tool live backups (plan §2 M2.1 ②).
//!
//! A backup is one JSON record under `<app config dir>/backups/live/<app>/`,
//! owner-only on Unix (0600 files, 0700 directories). Cloud sync uploads the
//! database and the skills directory only, so backups never leave the
//! machine.
//!
//! - Codex `auth.json` is never part of a backup and is never opened here.
//!   A backup records only a fingerprint of the ChatGPT identity stored for
//!   the current Codex line in the database, and a restore never writes
//!   `auth.json`.
//! - A restore goes through a CAS changeset (`config::cas`) and writes only
//!   paths that are the tool's live files right now, whatever the record on
//!   disk claims. It never changes the `model` the user set in Codex.
//! - At most [`MAX_BACKUPS_PER_APP`] records are kept per tool.

use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};
use toml_edit::DocumentMut;

use crate::app_config::AppType;
use crate::config::cas::{Changeset, FileSnapshot};
use crate::database::Database;
use crate::error::AppError;
use crate::security_limits::{read_limited, MAX_CONFIG_FILE_BYTES};
use crate::store::AppState;

/// Retention cap per tool; the oldest records are removed first.
pub const MAX_BACKUPS_PER_APP: usize = 20;
const RECORD_VERSION: u32 = 1;
/// A record holds at most a few live files of `MAX_CONFIG_FILE_BYTES` each,
/// base64-encoded.
const MAX_RECORD_BYTES: u64 = 6 * MAX_CONFIG_FILE_BYTES;
const CODEX_AUTH_FILE_NAME: &str = "auth.json";

/// Why a backup was taken.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LiveBackupReason {
    Manual,
    /// Before the first provider write for a tool (first-switch protection).
    FirstWrite,
    /// Before a tool is enabled for the first time.
    FirstEnable,
    /// The state a restore replaced.
    PreRestore,
    /// Before a cc-switch import.
    PreImport,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredFile {
    path: String,
    /// Base64 of the file bytes.
    contents: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupRecord {
    version: u32,
    id: String,
    app: String,
    created_at: i64,
    reason: LiveBackupReason,
    #[serde(default)]
    identity_fingerprint: Option<String>,
    files: Vec<StoredFile>,
}

/// Renderer view of a backup: paths only, never contents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveBackupSummary {
    pub id: String,
    pub app: String,
    pub created_at: i64,
    pub reason: LiveBackupReason,
    pub files: Vec<String>,
    pub identity_fingerprint: Option<String>,
    /// Absolute path of the backup record.
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveBackupRestoreResult {
    pub restored: Vec<String>,
    /// Backup of the state the restore replaced.
    pub pre_restore_backup_id: Option<String>,
    /// The current Codex login differs from the one recorded with the
    /// backup. `auth.json` was left alone either way.
    pub identity_changed: bool,
}

/// The live files of one tool, in write order. Codex `auth.json` is never
/// listed. Tools added later declare their files here; until they do they
/// have none, so they are never backed up or restored.
pub fn live_files(app: &AppType) -> Result<Vec<PathBuf>, AppError> {
    #[allow(unreachable_patterns)]
    let files = match app {
        AppType::Claude => vec![crate::config::get_claude_settings_path()],
        AppType::ClaudeDesktop => crate::claude_desktop_config::live_file_paths()?,
        AppType::Codex => vec![
            crate::codex_config::get_codex_config_path(),
            crate::codex_config::get_codex_model_catalog_path(),
        ],
        AppType::Gemini => vec![
            crate::gemini_config::get_gemini_env_path(),
            crate::gemini_config::get_gemini_settings_path(),
        ],
        AppType::GrokBuild => vec![crate::grok_config::get_grok_config_path()],
        AppType::OpenCode => vec![crate::opencode_config::get_opencode_config_path()],
        AppType::OpenClaw => vec![crate::openclaw_config::get_openclaw_config_path()],
        AppType::Hermes => vec![crate::hermes_config::get_hermes_config_path()],
        _ => Vec::new(),
    };
    Ok(files
        .into_iter()
        .filter(|path| !is_codex_auth_file(path))
        .collect())
}

/// Defense in depth: whatever a table or a record says, `auth.json` is out.
fn is_codex_auth_file(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|name| name.eq_ignore_ascii_case(CODEX_AUTH_FILE_NAME))
        || path == crate::codex_config::get_codex_auth_path().as_path()
}

/// Whether any of the tool's live files exists.
#[allow(dead_code)]
pub fn has_live_files(app: &AppType) -> Result<bool, AppError> {
    Ok(live_files(app)?.iter().any(|path| path.exists()))
}

fn backups_root() -> PathBuf {
    crate::config::get_app_config_dir()
        .join("backups")
        .join("live")
}

pub fn backup_dir(app: &AppType) -> PathBuf {
    backups_root().join(app.as_str())
}

fn ensure_private_dir(dir: &Path) -> Result<(), AppError> {
    fs::create_dir_all(dir).map_err(|e| AppError::io(dir, e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
            .map_err(|e| AppError::io(dir, e))?;
    }
    Ok(())
}

/// Ids come back from the renderer: only the characters we generate.
fn validate_id(id: &str) -> Result<(), AppError> {
    let valid = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if valid {
        Ok(())
    } else {
        Err(AppError::InvalidInput(format!("无效的备份 ID: {id}")))
    }
}

fn record_path(app: &AppType, id: &str) -> PathBuf {
    backup_dir(app).join(format!("{id}.json"))
}

fn new_backup_id() -> String {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    format!(
        "{}_{}",
        chrono::Utc::now().format("%Y%m%d_%H%M%S_%6f"),
        &suffix[..8]
    )
}

/// ChatGPT identity of the current Codex line as stored in the database;
/// `auth.json` is never read for it.
fn identity_fingerprint(db: &Database, app: &AppType) -> Option<String> {
    if *app != AppType::Codex {
        return None;
    }
    let current = crate::settings::get_effective_current_provider(db, app)
        .ok()
        .flatten()?;
    let provider = db
        .get_provider_by_id(&current, app.as_str())
        .ok()
        .flatten()?;
    crate::codex_config::codex_auth_identity_fingerprint(provider.settings_config.get("auth")?)
}

fn summary(record: &BackupRecord, path: &Path) -> LiveBackupSummary {
    LiveBackupSummary {
        id: record.id.clone(),
        app: record.app.clone(),
        created_at: record.created_at,
        reason: record.reason,
        files: record.files.iter().map(|file| file.path.clone()).collect(),
        identity_fingerprint: record.identity_fingerprint.clone(),
        path: path.display().to_string(),
    }
}

/// Backs up the tool's live files. Returns `None` when none of them exists.
pub fn create_backup(
    db: &Database,
    app: &AppType,
    reason: LiveBackupReason,
) -> Result<Option<LiveBackupSummary>, AppError> {
    let mut files = Vec::new();
    for path in live_files(app)? {
        let snapshot = FileSnapshot::read(&path).map_err(AppError::from)?;
        if let Some(bytes) = snapshot.contents() {
            files.push(StoredFile {
                path: path.display().to_string(),
                contents: base64::engine::general_purpose::STANDARD.encode(bytes),
            });
        }
    }
    if files.is_empty() {
        return Ok(None);
    }

    let record = BackupRecord {
        version: RECORD_VERSION,
        id: new_backup_id(),
        app: app.as_str().to_string(),
        created_at: chrono::Utc::now().timestamp_millis(),
        reason,
        identity_fingerprint: identity_fingerprint(db, app),
        files,
    };
    ensure_private_dir(&backups_root())?;
    ensure_private_dir(&backup_dir(app))?;
    let path = record_path(app, &record.id);
    let json =
        serde_json::to_vec_pretty(&record).map_err(|source| AppError::JsonSerialize { source })?;
    // A new record is a CAS create: it fails instead of replacing a file
    // that appeared under the same name, and it is forced to 0600.
    let mut changeset = Changeset::new();
    changeset
        .write_private(FileSnapshot::read(&path).map_err(AppError::from)?, json)
        .map_err(AppError::from)?;
    changeset.commit().map_err(AppError::from)?;

    prune(app)?;
    Ok(Some(summary(&record, &path)))
}

/// Reuses the newest backup when it holds exactly the current live files,
/// otherwise takes a new one. Keeps repeated first-enable previews from
/// filling the retention cap with copies.
#[allow(dead_code)]
pub fn ensure_current_backup(
    db: &Database,
    app: &AppType,
    reason: LiveBackupReason,
) -> Result<Option<LiveBackupSummary>, AppError> {
    let mut current = Vec::new();
    for path in live_files(app)? {
        let snapshot = FileSnapshot::read(&path).map_err(AppError::from)?;
        if let Some(bytes) = snapshot.contents() {
            current.push((
                path.display().to_string(),
                base64::engine::general_purpose::STANDARD.encode(bytes),
            ));
        }
    }
    if current.is_empty() {
        return Ok(None);
    }
    if let Some((record, path)) = load_records(app)?.into_iter().next() {
        let same =
            record.files.len() == current.len()
                && record.files.iter().zip(&current).all(
                    |(file, (current_path, current_contents))| {
                        file.path == *current_path && file.contents == *current_contents
                    },
                );
        if same {
            return Ok(Some(summary(&record, &path)));
        }
    }
    create_backup(db, app, reason)
}

fn load_record_file(path: &Path) -> Result<BackupRecord, AppError> {
    let bytes = read_limited(path, MAX_RECORD_BYTES).map_err(|e| AppError::io(path, e))?;
    serde_json::from_slice(&bytes).map_err(|e| AppError::json(path, e))
}

/// Every readable record of a tool, newest first.
fn load_records(app: &AppType) -> Result<Vec<(BackupRecord, PathBuf)>, AppError> {
    let dir = backup_dir(app);
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(AppError::io(&dir, error)),
    };
    let mut records = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        match load_record_file(&path) {
            Ok(record) if record.app == app.as_str() => records.push((record, path)),
            Ok(_) => log::warn!("忽略应用不匹配的 Live 备份: {}", path.display()),
            Err(error) => log::warn!("忽略无法读取的 Live 备份 {}: {error}", path.display()),
        }
    }
    // Ids start with a UTC timestamp, so the lexicographic order is the
    // creation order.
    records.sort_by(|(a, _), (b, _)| b.id.cmp(&a.id));
    Ok(records)
}

fn prune(app: &AppType) -> Result<(), AppError> {
    for (_, path) in load_records(app)?.into_iter().skip(MAX_BACKUPS_PER_APP) {
        fs::remove_file(&path).map_err(|e| AppError::io(&path, e))?;
    }
    Ok(())
}

pub fn list_backups(app: &AppType) -> Result<Vec<LiveBackupSummary>, AppError> {
    Ok(load_records(app)?
        .iter()
        .map(|(record, path)| summary(record, path))
        .collect())
}

pub fn delete_backup(app: &AppType, id: &str) -> Result<(), AppError> {
    validate_id(id)?;
    let path = record_path(app, id);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(backup_not_found(id)),
        Err(error) => Err(AppError::io(&path, error)),
    }
}

fn backup_not_found(id: &str) -> AppError {
    AppError::localized(
        "live_backup.not_found",
        format!("找不到 Live 备份: {id}"),
        format!("Live backup not found: {id}"),
    )
}

/// Takeover owns the live file while it is active; restoring over it would
/// strand the proxy placeholders.
fn ensure_not_taken_over(state: &AppState, app: &AppType) -> Result<(), AppError> {
    let has_takeover_backup = futures::executor::block_on(state.db.get_live_backup(app.as_str()))
        .map_err(|e| AppError::Message(e.to_string()))?
        .is_some();
    // Codex placeholder detection reads auth.json, which this module never
    // touches; a Codex takeover always records the backup row checked above
    // before it writes any placeholder.
    let placeholders = *app != AppType::Codex
        && state
            .proxy_service
            .detect_takeover_in_live_config_for_app(app);
    if has_takeover_backup || placeholders {
        return Err(AppError::localized(
            "live_backup.taken_over",
            "该工具的 Live 配置当前由代理接管，请先关闭接管再恢复备份。",
            "This tool's live config is owned by proxy takeover. Turn takeover off before restoring a backup.",
        ));
    }
    Ok(())
}

/// Restores a backup through one CAS changeset (see the module docs).
pub fn restore_backup(
    state: &AppState,
    app: &AppType,
    id: &str,
) -> Result<LiveBackupRestoreResult, AppError> {
    validate_id(id)?;
    let _switch_guard =
        futures::executor::block_on(state.proxy_service.lock_switch_for_app(app.as_str()));
    ensure_not_taken_over(state, app)?;

    let path = record_path(app, id);
    if !path.exists() {
        return Err(backup_not_found(id));
    }
    let record = load_record_file(&path)?;
    if record.app != app.as_str() || record.version != RECORD_VERSION {
        return Err(AppError::localized(
            "live_backup.mismatch",
            "该备份不属于此工具或版本不受支持",
            "This backup belongs to another tool or has an unsupported version",
        ));
    }

    let allowed = live_files(app)?;
    let mut planned = Vec::with_capacity(record.files.len());
    for file in &record.files {
        let target = PathBuf::from(&file.path);
        if is_codex_auth_file(&target) || !allowed.contains(&target) {
            return Err(AppError::localized(
                "live_backup.foreign_path",
                format!(
                    "备份中的 {} 不是该工具当前的 Live 文件，已拒绝恢复",
                    file.path
                ),
                format!(
                    "{} in the backup is not one of this tool's live files; restore refused",
                    file.path
                ),
            ));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&file.contents)
            .map_err(|e| AppError::Config(format!("备份内容无法解码 ({}): {e}", file.path)))?;
        planned.push((target, bytes));
    }

    let pre_restore = create_backup(&state.db, app, LiveBackupReason::PreRestore)?;

    let codex_config_path = crate::codex_config::get_codex_config_path();
    let mut changeset = Changeset::new();
    for (target, bytes) in planned {
        let snapshot = FileSnapshot::read(&target).map_err(AppError::from)?;
        let bytes = if *app == AppType::Codex && target == codex_config_path {
            keep_user_codex_model(snapshot.contents(), bytes)?
        } else {
            bytes
        };
        changeset.write(snapshot, bytes).map_err(AppError::from)?;
    }
    let applied = changeset.commit().map_err(AppError::from)?;

    let current_identity = identity_fingerprint(&state.db, app);
    let identity_changed = matches!(
        (&record.identity_fingerprint, &current_identity),
        (Some(recorded), Some(current)) if recorded != current
    );
    Ok(LiveBackupRestoreResult {
        restored: applied.paths().map(|p| p.display().to_string()).collect(),
        pre_restore_backup_id: pre_restore.map(|backup| backup.id),
        identity_changed,
    })
}

/// A restore never changes the `model` the user set in Codex (C18): the
/// restored `config.toml` takes the current top-level `model`, or loses its
/// own when the current file has none. When the current file cannot be
/// parsed there is nothing trustworthy to keep and the backup wins.
pub(crate) fn keep_user_codex_model(
    current: Option<&[u8]>,
    restored: Vec<u8>,
) -> Result<Vec<u8>, AppError> {
    let current_model = match current {
        None => None,
        Some(bytes) => match std::str::from_utf8(bytes)
            .ok()
            .and_then(|text| text.parse::<DocumentMut>().ok())
        {
            Some(doc) => match doc.get("model") {
                None => None,
                Some(item) => match item.as_str() {
                    Some(model) => Some(model.to_string()),
                    // Not a model name Codex would accept: nothing to keep.
                    None => return Ok(restored),
                },
            },
            None => return Ok(restored),
        },
    };
    let text = String::from_utf8(restored)
        .map_err(|_| AppError::Config("备份中的 config.toml 不是 UTF-8 文本".to_string()))?;
    let mut doc = text
        .parse::<DocumentMut>()
        .map_err(|e| AppError::Config(format!("备份中的 config.toml 无法解析: {e}")))?;
    match current_model {
        Some(model) => {
            doc.insert("model", toml_edit::value(model));
        }
        None => {
            doc.remove("model");
        }
    }
    Ok(doc.to_string().into_bytes())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serial_test::serial;
    use std::env;
    use std::sync::Arc;
    use tempfile::TempDir;

    /// Temporary HOME for the whole test (restored on drop).
    pub(crate) struct TempHome {
        pub(crate) dir: TempDir,
        saved: Vec<(&'static str, Option<std::ffi::OsString>)>,
    }

    impl TempHome {
        pub(crate) fn new() -> Self {
            let dir = TempDir::new().expect("create temp home");
            let saved = ["HOME", "USERPROFILE", "CC_SWITCH_TEST_HOME", "LOCALAPPDATA"]
                .into_iter()
                .map(|key| (key, env::var_os(key)))
                .collect();
            env::set_var("HOME", dir.path());
            env::set_var("USERPROFILE", dir.path());
            env::set_var("CC_SWITCH_TEST_HOME", dir.path());
            #[cfg(windows)]
            env::set_var("LOCALAPPDATA", dir.path().join("AppData").join("Local"));
            Self { dir, saved }
        }

        pub(crate) fn path(&self) -> &Path {
            self.dir.path()
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            for (key, value) in &self.saved {
                match value {
                    Some(value) => env::set_var(key, value),
                    None => env::remove_var(key),
                }
            }
        }
    }

    fn state() -> AppState {
        AppState::new(Arc::new(Database::memory().expect("memory db")))
    }

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    const AUTH_SECRET: &str = "sk-live-backup-auth-json-secret";

    #[test]
    #[serial]
    fn backup_and_restore_never_read_or_write_codex_auth_json() {
        let _home = TempHome::new();
        let state = state();
        let config_path = crate::codex_config::get_codex_config_path();
        let auth_path = crate::codex_config::get_codex_auth_path();
        write(&config_path, "model = \"gpt-a\"\n[tui]\ntheme = \"dark\"\n");

        // An auth.json that cannot be read or replaced as a file: any access
        // by backup or restore would fail the operation.
        fs::create_dir_all(&auth_path).unwrap();
        let backup = create_backup(&state.db, &AppType::Codex, LiveBackupReason::Manual)
            .unwrap()
            .expect("config.toml is backed up");
        assert_eq!(backup.files, vec![config_path.display().to_string()]);
        write(
            &config_path,
            "model = \"gpt-a\"\n[tui]\ntheme = \"light\"\n",
        );
        restore_backup(&state, &AppType::Codex, &backup.id).unwrap();
        assert!(auth_path.is_dir(), "auth.json must be left alone");
        fs::remove_dir(&auth_path).unwrap();

        // A real auth.json: its bytes never reach the record, and a restore
        // leaves the current file byte-identical.
        write(
            &auth_path,
            &format!("{{\"OPENAI_API_KEY\":\"{AUTH_SECRET}\"}}"),
        );
        let backup = create_backup(&state.db, &AppType::Codex, LiveBackupReason::Manual)
            .unwrap()
            .unwrap();
        let record = fs::read(&backup.path).unwrap();
        let encoded = base64::engine::general_purpose::STANDARD.encode(AUTH_SECRET);
        let record_text = String::from_utf8_lossy(&record);
        assert!(!record_text.contains(AUTH_SECRET));
        assert!(!record_text.contains(&encoded));
        assert!(!record_text.contains("auth.json"));

        write(&auth_path, "{\"OPENAI_API_KEY\":\"sk-after\"}");
        let result = restore_backup(&state, &AppType::Codex, &backup.id).unwrap();
        assert!(result.restored.iter().all(|p| !p.ends_with("auth.json")));
        assert_eq!(
            fs::read_to_string(&auth_path).unwrap(),
            "{\"OPENAI_API_KEY\":\"sk-after\"}"
        );
    }

    #[test]
    #[serial]
    fn restore_uses_the_changeset_and_keeps_the_user_codex_model() {
        let _home = TempHome::new();
        let state = state();
        let config_path = crate::codex_config::get_codex_config_path();
        write(&config_path, "model = \"gpt-a\"\n[tui]\ntheme = \"dark\"\n");
        let backup = create_backup(&state.db, &AppType::Codex, LiveBackupReason::Manual)
            .unwrap()
            .unwrap();

        // The user changes the model in Codex and breaks another setting.
        write(
            &config_path,
            "model = \"gpt-b\"\n[tui]\ntheme = \"broken\"\n",
        );
        let result = restore_backup(&state, &AppType::Codex, &backup.id).unwrap();

        let restored: DocumentMut = fs::read_to_string(&config_path).unwrap().parse().unwrap();
        assert_eq!(restored["model"].as_str(), Some("gpt-b"));
        assert_eq!(restored["tui"]["theme"].as_str(), Some("dark"));
        // The replaced state is itself backed up.
        let pre = result.pre_restore_backup_id.expect("pre-restore backup");
        assert!(list_backups(&AppType::Codex)
            .unwrap()
            .iter()
            .any(|b| b.id == pre && b.reason == LiveBackupReason::PreRestore));
    }

    #[test]
    fn keep_user_codex_model_follows_the_current_file() {
        let restored = b"model = \"old\"\nx = 1\n".to_vec();
        let kept = keep_user_codex_model(Some(b"model = \"new\"\n"), restored.clone()).unwrap();
        assert!(String::from_utf8(kept).unwrap().contains("model = \"new\""));
        let dropped = keep_user_codex_model(Some(b"x = 2\n"), restored.clone()).unwrap();
        assert!(!String::from_utf8(dropped).unwrap().contains("model"));
        let missing = keep_user_codex_model(None, restored.clone()).unwrap();
        assert!(!String::from_utf8(missing).unwrap().contains("model"));
        let unparseable = keep_user_codex_model(Some(b"model = = ="), restored.clone()).unwrap();
        assert_eq!(unparseable, restored);
    }

    #[test]
    #[serial]
    fn restore_refuses_paths_that_are_not_the_tools_live_files() {
        let home = TempHome::new();
        let state = state();
        let settings_path = crate::config::get_claude_settings_path();
        write(&settings_path, "{\"env\":{}}");
        let backup = create_backup(&state.db, &AppType::Claude, LiveBackupReason::Manual)
            .unwrap()
            .unwrap();

        let outside = home.path().join("outside.txt");
        let mut record: BackupRecord = load_record_file(Path::new(&backup.path)).unwrap();
        record.files[0].path = outside.display().to_string();
        fs::write(&backup.path, serde_json::to_vec(&record).unwrap()).unwrap();

        let error = restore_backup(&state, &AppType::Claude, &backup.id).unwrap_err();
        assert!(
            matches!(
                error,
                AppError::Localized {
                    key: "live_backup.foreign_path",
                    ..
                }
            ),
            "{error:?}"
        );
        assert!(!outside.exists());
        assert!(restore_backup(&state, &AppType::Claude, "../escape").is_err());
    }

    #[test]
    #[serial]
    fn retention_keeps_the_newest_records_and_they_are_owner_only() {
        let _home = TempHome::new();
        let state = state();
        let settings_path = crate::config::get_claude_settings_path();
        let mut ids = Vec::new();
        for index in 0..MAX_BACKUPS_PER_APP + 2 {
            write(&settings_path, &format!("{{\"index\":{index}}}"));
            let backup = create_backup(&state.db, &AppType::Claude, LiveBackupReason::Manual)
                .unwrap()
                .unwrap();
            ids.push(backup.id);
        }
        let listed = list_backups(&AppType::Claude).unwrap();
        assert_eq!(listed.len(), MAX_BACKUPS_PER_APP);
        assert_eq!(listed[0].id, *ids.last().unwrap());
        assert!(!listed.iter().any(|b| b.id == ids[0] || b.id == ids[1]));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(Path::new(&listed[0].path)), 0o600);
            assert_eq!(mode(&backup_dir(&AppType::Claude)), 0o700);
        }

        delete_backup(&AppType::Claude, &listed[0].id).unwrap();
        assert_eq!(
            list_backups(&AppType::Claude).unwrap().len(),
            MAX_BACKUPS_PER_APP - 1
        );
        assert!(delete_backup(&AppType::Claude, &listed[0].id).is_err());
    }

    #[test]
    #[serial]
    fn ensure_current_backup_reuses_an_identical_newest_record() {
        let _home = TempHome::new();
        let state = state();
        let settings_path = crate::config::get_claude_settings_path();
        assert!(
            ensure_current_backup(&state.db, &AppType::Claude, LiveBackupReason::FirstEnable)
                .unwrap()
                .is_none(),
            "nothing to back up without live files"
        );
        write(&settings_path, "{\"a\":1}");
        let first =
            ensure_current_backup(&state.db, &AppType::Claude, LiveBackupReason::FirstEnable)
                .unwrap()
                .unwrap();
        let again =
            ensure_current_backup(&state.db, &AppType::Claude, LiveBackupReason::FirstEnable)
                .unwrap()
                .unwrap();
        assert_eq!(first.id, again.id);
        write(&settings_path, "{\"a\":2}");
        let changed =
            ensure_current_backup(&state.db, &AppType::Claude, LiveBackupReason::FirstEnable)
                .unwrap()
                .unwrap();
        assert_ne!(first.id, changed.id);
    }

    #[test]
    #[serial]
    fn every_tool_declares_live_files_and_none_is_auth_json() {
        let _home = TempHome::new();
        for app in AppType::all() {
            let files = live_files(&app).unwrap();
            assert!(files.iter().all(|p| !is_codex_auth_file(p)), "{app:?}");
            if app != AppType::ClaudeDesktop || cfg!(any(target_os = "macos", windows)) {
                assert!(!files.is_empty(), "{app:?} declares no live files");
            }
        }
    }
}
