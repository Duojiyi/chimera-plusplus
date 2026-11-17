//! Local-only history continuity between Desktop's account/deployment scopes.
//!
//! Run while Desktop is closed, before changing credentials or deployment mode.
//! Authentication, scheduled tasks, plugins and browser storage are never copied.
//! Code transcripts normally live in the account-independent ~/.claude/projects;
//! imported transcripts and Cowork payloads are copied before publishing metadata.
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, FileTimes};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::config::cas::{Changeset, FileSnapshot};
use crate::error::AppError;
use crate::security_limits::{
    open_regular_file_no_symlink, read_dir_without_links, read_limited, MAX_CONFIG_FILE_BYTES,
};

const KINDS: [&str; 2] = ["claude-code-sessions", "local-agent-mode-sessions"];
const MANIFEST: &str = ".chimera-local-history.json";
const LOCAL_ORG: &str = "00000000-0000-4000-8000-000000000001";
const MAX_RECORDS: usize = 20_000;
const MAX_PAYLOAD_BYTES: u64 = 1024 * 1024 * 1024;
static HISTORY_LOCK: Mutex<()> = Mutex::new(());

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    #[serde(default)]
    known: BTreeSet<String>,
    #[serde(default)]
    deleted: BTreeSet<String>,
}

struct Scope {
    dir: PathBuf,
    kind: usize,
    records: BTreeMap<String, Record>,
    manifest: Manifest,
}

#[derive(Clone)]
struct Record {
    path: PathBuf,
    data: Value,
    modified: SystemTime,
}

fn message(text: impl Into<String>) -> AppError {
    AppError::Message(text.into())
}

fn uuid(text: &str) -> bool {
    text.len() == 36 && uuid::Uuid::parse_str(text).is_ok()
}

fn scope_id(text: &str) -> bool {
    uuid(text) || text.len() == 8 && text.bytes().all(|ch| ch.is_ascii_hexdigit())
}

fn session_id(text: &str) -> bool {
    text.strip_prefix("local_").is_some_and(uuid)
}

fn same_scope_id(left: &str, right: &str) -> bool {
    left.eq_ignore_ascii_case(right)
        || (left.len() == 8 || right.len() == 8)
            && left
                .get(..8)
                .zip(right.get(..8))
                .is_some_and(|(a, b)| a.eq_ignore_ascii_case(b))
}

fn has_turns(data: &Value) -> bool {
    data.get("completedTurns")
        .and_then(Value::as_u64)
        .unwrap_or(1)
        > 0
}

/// Reject existing links/junctions before both reading and creating paths.
fn safe_path(path: &Path) -> Result<(), AppError> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(meta) if crate::security_limits::is_link_or_reparse_point(&meta) => {
                return Err(message("本地会话路径含链接，已取消切换，原始记录仍保留。"));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(AppError::io(ancestor, error)),
        }
    }
    Ok(())
}

fn directories(path: &Path) -> Result<Vec<PathBuf>, AppError> {
    safe_path(path)?;
    let entries = match read_dir_without_links(path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(AppError::io(path, error)),
    };
    let mut dirs = Vec::new();
    for entry in entries {
        if !entry.file_name().to_str().is_some_and(scope_id) {
            continue;
        }
        let metadata =
            fs::symlink_metadata(entry.path()).map_err(|e| AppError::io(entry.path(), e))?;
        if crate::security_limits::is_link_or_reparse_point(&metadata) {
            return Err(message("本地会话目录含链接，已取消切换以保留原始记录。"));
        }
        if metadata.is_dir() {
            dirs.push(entry.path());
        }
    }
    dirs.sort();
    Ok(dirs)
}

fn json(path: &Path) -> Result<Option<Value>, AppError> {
    safe_path(path)?;
    match read_limited(path, MAX_CONFIG_FILE_BYTES) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|_| {
            message(format!(
                "本地会话文件无法读取，已取消切换：{}",
                path.display()
            ))
        }),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(AppError::io(path, error)),
    }
}

fn scopes(roots: &[PathBuf]) -> Result<Vec<Scope>, AppError> {
    let mut scopes = Vec::new();
    let mut total = 0;
    for root in roots {
        for (kind, name) in KINDS.iter().enumerate() {
            for account in directories(&root.join(name))? {
                if !account
                    .file_name()
                    .and_then(|x| x.to_str())
                    .is_some_and(scope_id)
                {
                    continue;
                }
                for org in directories(&account)? {
                    if !org
                        .file_name()
                        .and_then(|x| x.to_str())
                        .is_some_and(scope_id)
                    {
                        continue;
                    }
                    let mut records = BTreeMap::new();
                    for entry in read_dir_without_links(&org).map_err(|e| AppError::io(&org, e))? {
                        let path = entry.path();
                        let Some(id) = path
                            .file_stem()
                            .and_then(|x| x.to_str())
                            .filter(|id| session_id(id))
                        else {
                            continue;
                        };
                        if path.extension().and_then(|x| x.to_str()) != Some("json") {
                            continue;
                        }
                        let Some(data) = json(&path)? else {
                            continue;
                        };
                        // Remote sessions remain owned by their remote host.
                        if data.get("sshConfig").is_some_and(|v| !v.is_null())
                            || data.get("wslConfig").is_some_and(|v| !v.is_null())
                        {
                            continue;
                        }
                        let cli = data.get("cliSessionId");
                        let valid_cli = cli.and_then(Value::as_str).is_some_and(uuid)
                            || (!has_turns(&data) && cli.is_none_or(Value::is_null));
                        if data.get("sessionId").and_then(Value::as_str) != Some(id) || !valid_cli {
                            return Err(message(format!(
                                "本地会话标识无效，已取消切换：{}",
                                path.display()
                            )));
                        }
                        total += 1;
                        if total > MAX_RECORDS {
                            return Err(message("本地会话数量超出单次整理上限，已取消切换。"));
                        }
                        let modified = fs::metadata(&path)
                            .and_then(|m| m.modified())
                            .map_err(|e| AppError::io(&path, e))?;
                        records.insert(
                            id.to_owned(),
                            Record {
                                path,
                                data,
                                modified,
                            },
                        );
                    }
                    let mut manifest = match json(&org.join(MANIFEST))? {
                        Some(data) => serde_json::from_value::<Manifest>(data)
                            .map_err(|_| message("本地会话保留索引损坏，已取消切换。"))?,
                        None => Manifest::default(),
                    };
                    for id in &manifest.known {
                        if !records.contains_key(id) {
                            manifest.deleted.insert(id.clone());
                        }
                    }
                    manifest.known.extend(records.keys().cloned());
                    scopes.push(Scope {
                        dir: org,
                        kind,
                        records,
                        manifest,
                    });
                }
            }
        }
    }
    Ok(scopes)
}

fn add_scope(scopes: &mut Vec<Scope>, root: &Path, account: &str, org: &str) {
    for (kind, name) in KINDS.iter().enumerate() {
        let dir = root.join(name).join(account).join(org);
        // Native scopes may independently shorten the account and org UUIDs.
        if scopes.iter().any(|s| {
            s.kind == kind
                && s.dir.parent().and_then(Path::parent) == Some(root.join(name).as_path())
                && s.dir
                    .parent()
                    .and_then(Path::file_name)
                    .and_then(|x| x.to_str())
                    .is_some_and(|id| same_scope_id(id, account))
                && s.dir
                    .file_name()
                    .and_then(|x| x.to_str())
                    .is_some_and(|id| same_scope_id(id, org))
        }) {
            continue;
        }
        scopes.push(Scope {
            dir,
            kind,
            records: BTreeMap::new(),
            manifest: Manifest::default(),
        });
    }
}

/// Creates the native client's *installation* identity, never an account or
/// organization identity. ant-did is a base64 UUID, written with create-new.
fn api_install_id(root: &Path) -> Result<String, AppError> {
    use base64::engine::general_purpose::STANDARD;
    let path = root.join("ant-did");
    safe_path(&path)?;
    for _ in 0..2 {
        match read_limited(&path, 1024) {
            Ok(bytes) => {
                let decoded = STANDARD
                    .decode(
                        bytes
                            .iter()
                            .copied()
                            .filter(|ch| !ch.is_ascii_whitespace())
                            .collect::<Vec<_>>(),
                    )
                    .ok()
                    .and_then(|v| String::from_utf8(v).ok())
                    .filter(|v| uuid(v));
                return decoded.ok_or_else(|| {
                    message("Claude 的本机安装标识无法读取，已取消切换；原文件保持不变。")
                });
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::create_dir_all(root).map_err(|e| AppError::io(root, e))?;
                let id = uuid::Uuid::new_v4().to_string();
                let mut temp =
                    tempfile::NamedTempFile::new_in(root).map_err(|e| AppError::io(root, e))?;
                temp.write_all(STANDARD.encode(&id).as_bytes())
                    .and_then(|_| temp.as_file().sync_all())
                    .map_err(|e| AppError::io(&path, e))?;
                match temp.persist_noclobber(&path) {
                    Ok(_) => return Ok(id),
                    Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(error) => return Err(AppError::io(&path, error.error)),
                }
            }
            Err(error) => return Err(AppError::io(&path, error)),
        }
    }
    Err(message("Claude 的本机安装标识正在变化，请重试。"))
}

fn add_identity_hints(
    scopes: &mut Vec<Scope>,
    root: &Path,
    config_dir: &Path,
) -> Result<(), AppError> {
    let Some(config) = json(&config_dir.join("config.json"))? else {
        return Ok(());
    };
    let Some(account) = config
        .get("lastKnownAccountUuid")
        .and_then(Value::as_str)
        .filter(|id| uuid(id))
    else {
        return Ok(());
    };
    let mut orgs = BTreeSet::new();
    if let Some(config) = config.as_object() {
        for key in config.keys() {
            if key.starts_with("dxt:") {
                if let Some(org) = key.rsplit(':').next().filter(|id| uuid(id)) {
                    orgs.insert(org.to_string());
                }
            }
        }
    }
    for scope in scopes.iter().filter(|s| {
        s.dir.parent().and_then(Path::parent).and_then(Path::parent) == Some(root)
            && s.dir
                .parent()
                .and_then(Path::file_name)
                .and_then(|x| x.to_str())
                .is_some_and(|id| same_scope_id(id, account))
    }) {
        if let Some(org) = scope
            .dir
            .file_name()
            .and_then(|x| x.to_str())
            .filter(|id| scope_id(id))
        {
            orgs.insert(org.to_owned());
        }
    }
    for org in orgs {
        add_scope(scopes, root, account, &org);
    }
    Ok(())
}

fn revision(record: &Record) -> (bool, u64, SystemTime) {
    (
        record
            .data
            .get("cliSessionId")
            .and_then(Value::as_str)
            .is_some(),
        record
            .data
            .get("lastActivityAt")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        record.modified,
    )
}

// Copy history and user choices, not account-bound grants, live processes,
// credentials, MCP snapshots or a pending send that could run on another account.
fn portable_record(record: &Record, target: &Path) -> Value {
    const FIELDS: &[&str] = &[
        "sessionId",
        "cliSessionId",
        "previousCliSessionIds",
        "cwd",
        "originCwd",
        "folderPlace",
        "gitAnchorsFolderRealpath",
        "createdAt",
        "lastActivityAt",
        "lastFocusedAt",
        "lastTurnEdgeAt",
        "title",
        "titleSource",
        "model",
        "effort",
        "effortOverride",
        "isArchived",
        "completedTurns",
        "importedFrom",
        "importedRunOf",
        "resumeConfirmed",
        "stagedTranscriptPath",
        "indexedAt",
        "processName",
        "vmProcessName",
        "hostLoopMode",
        "sessionType",
        "userSelectedFolders",
        "folderMountNames",
        "resolvedFolderKinds",
    ];
    let mut out = serde_json::Map::new();
    for key in FIELDS {
        if let Some(value) = record.data.get(*key) {
            out.insert((*key).to_string(), value.clone());
        }
    }
    // permissions are deliberately re-evaluated in the destination account.
    out.insert(
        "permissionMode".to_string(),
        Value::String("default".into()),
    );
    let source = record.path.parent().unwrap();
    let mut out = Value::Object(out);
    rewrite_paths(&mut out, source, target);
    out
}

fn rewrite_paths(value: &mut Value, source: &Path, target: &Path) {
    match value {
        Value::String(text) => {
            if let Ok(relative) = Path::new(text).strip_prefix(source) {
                if !relative.as_os_str().is_empty() {
                    *text = target.join(relative).to_string_lossy().into_owned();
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                rewrite_paths(item, source, target);
            }
        }
        Value::Object(items) => {
            for item in items.values_mut() {
                rewrite_paths(item, source, target);
            }
        }
        _ => {}
    }
}

fn digest(path: &Path) -> Result<Option<[u8; 32]>, AppError> {
    safe_path(path)?;
    let file = match open_regular_file_no_symlink(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(AppError::io(path, error)),
    };
    if file.metadata().map_err(|e| AppError::io(path, e))?.len() > MAX_PAYLOAD_BYTES {
        return Err(message("本地会话附件过大，已取消切换。"));
    }
    let mut file = file.take(MAX_PAYLOAD_BYTES + 1);
    let mut hash = Sha256::new();
    let mut read_bytes = 0u64;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| AppError::io(path, e))?;
        if n == 0 {
            break;
        }
        read_bytes += n as u64;
        if read_bytes > MAX_PAYLOAD_BYTES {
            return Err(message("本地会话附件过大，已取消切换。"));
        }
        hash.update(&buf[..n]);
    }
    Ok(Some(hash.finalize().into()))
}

// Large transcripts stay on disk. Nothing replaces a destination until every
// record has been validated and its new payload and rollback copy are staged.
#[derive(Default)]
struct PayloadChangeset {
    files: Vec<PayloadChange>,
}

struct PayloadChange {
    source: PathBuf,
    target: PathBuf,
    before: Option<[u8; 32]>,
    after: [u8; 32],
    staged: Option<tempfile::NamedTempFile>,
    original: Option<tempfile::NamedTempFile>,
    applied: bool,
}

impl PayloadChangeset {
    fn commit(&mut self) -> Result<(), AppError> {
        for change in &self.files {
            if digest(&change.source)? != Some(change.after)
                || digest(&change.target)? != change.before
            {
                return Err(message(
                    "本地会话正在变化，已取消切换，请退出 Claude 后重试。",
                ));
            }
        }
        for change in &mut self.files {
            safe_path(&change.target)?;
            if digest(&change.target)? != change.before
                || digest(&change.source)? != Some(change.after)
            {
                return Err(message(
                    "本地会话正在变化，已取消切换，请退出 Claude 后重试。",
                ));
            }
            change
                .staged
                .take()
                .unwrap()
                .persist(&change.target)
                .map_err(|e| AppError::io(&change.target, e.error))?;
            change.applied = true;
            if digest(&change.target)? != Some(change.after) {
                return Err(message("本地会话正文写入后校验失败，已取消切换。"));
            }
        }
        Ok(())
    }

    fn rollback(&mut self) -> Result<(), AppError> {
        let mut conflicts = Vec::new();
        for change in self.files.iter_mut().rev().filter(|change| change.applied) {
            let result = (|| -> Result<(), AppError> {
                // Never overwrite a conversation changed by another process.
                if digest(&change.target)? != Some(change.after) {
                    return Err(message("本地会话在恢复前被其他程序修改。"));
                }
                if let Some(original) = change.original.take() {
                    if let Err(error) = original.persist(&change.target) {
                        change.original = Some(error.file);
                        return Err(AppError::io(&change.target, error.error));
                    }
                } else {
                    fs::remove_file(&change.target).map_err(|e| AppError::io(&change.target, e))?;
                }
                change.applied = false;
                Ok(())
            })();
            if result.is_err() {
                // Keep recovery bytes if an external writer or I/O error stops rollback.
                let recovery = change.original.take().map(|file| {
                    let path = file.path().to_path_buf();
                    match file.keep() {
                        Ok(_) => path.display().to_string(),
                        Err(error) => {
                            // Retain the handle rather than delete the only original.
                            let path = error.file.path().display().to_string();
                            std::mem::forget(error.file);
                            path
                        }
                    }
                });
                conflicts.push(match recovery {
                    Some(path) => format!("{}（原内容备份：{path}）", change.target.display()),
                    None => change.target.display().to_string(),
                });
            }
        }
        if conflicts.is_empty() {
            Ok(())
        } else {
            Err(message(format!(
                "本地会话发生并发修改或恢复失败，已保留可恢复文件：{}",
                conflicts.join("、")
            )))
        }
    }
}

fn stage_payload(
    source: &Path,
    target: &Path,
    bytes: &mut u64,
    changes: &mut PayloadChangeset,
) -> Result<(), AppError> {
    let source_hash = digest(source)?.ok_or_else(|| message("本地会话正文不存在，已取消切换。"))?;
    let before = digest(target)?;
    if before == Some(source_hash) {
        return Ok(());
    }
    let mut file = open_regular_file_no_symlink(source).map_err(|e| AppError::io(source, e))?;
    *bytes = bytes.saturating_add(file.metadata().map_err(|e| AppError::io(source, e))?.len());
    if *bytes > MAX_PAYLOAD_BYTES {
        return Err(message(
            "本地会话附件超过单次 1 GB 整理上限，已取消切换，原始记录仍保留。",
        ));
    }
    let parent = target.parent().unwrap();
    safe_path(parent)?;
    fs::create_dir_all(parent).map_err(|e| AppError::io(parent, e))?;
    // Validate every existing ancestor (including Windows junctions).
    for ancestor in parent.ancestors() {
        if let Ok(meta) = fs::symlink_metadata(ancestor) {
            if crate::security_limits::is_link_or_reparse_point(&meta) {
                return Err(message("本地会话附件路径含链接，已取消切换。"));
            }
        }
    }
    // tempfile passes paths directly to Win32 when persisting. Canonicalizing
    // the existing parent supplies the extended-length prefix needed by deeply
    // nested Cowork transcripts and attachments on Windows.
    let write_parent = fs::canonicalize(parent).map_err(|e| AppError::io(parent, e))?;
    let write_target = write_parent.join(target.file_name().unwrap());
    if let Some(planned) = changes
        .files
        .iter()
        .find(|change| change.target == write_target)
    {
        return if planned.after == source_hash {
            Ok(())
        } else {
            Err(message("同一本地会话正文出现不一致，已取消切换。"))
        };
    }
    let mut temp =
        tempfile::NamedTempFile::new_in(&write_parent).map_err(|e| AppError::io(parent, e))?;
    let copied = io::copy(
        &mut (&mut file).take(MAX_PAYLOAD_BYTES + 1),
        temp.as_file_mut(),
    )
    .map_err(|e| AppError::io(source, e))?;
    if copied > MAX_PAYLOAD_BYTES
        || digest(temp.path())? != Some(source_hash)
        || digest(source)? != Some(source_hash)
        || digest(target)? != before
    {
        return Err(message(
            "本地会话正在变化，已取消切换，请退出 Claude 后重试。",
        ));
    }
    temp.as_file()
        .sync_all()
        .map_err(|e| AppError::io(target, e))?;
    let original = if let Some(before_hash) = before {
        let mut source =
            open_regular_file_no_symlink(target).map_err(|e| AppError::io(target, e))?;
        let modified = source
            .metadata()
            .and_then(|m| m.modified())
            .map_err(|e| AppError::io(target, e))?;
        let mut backup =
            tempfile::NamedTempFile::new_in(&write_parent).map_err(|e| AppError::io(parent, e))?;
        let copied = io::copy(
            &mut (&mut source).take(MAX_PAYLOAD_BYTES + 1),
            backup.as_file_mut(),
        )
        .map_err(|e| AppError::io(target, e))?;
        *bytes = bytes.saturating_add(copied);
        if *bytes > MAX_PAYLOAD_BYTES
            || digest(backup.path())? != Some(before_hash)
            || digest(target)? != before
        {
            return Err(message(
                "本地会话正在变化或超过整理上限，已取消切换，原始记录保持不变。",
            ));
        }
        backup
            .as_file()
            .set_times(FileTimes::new().set_modified(modified))
            .map_err(|e| AppError::io(target, e))?;
        backup
            .as_file()
            .sync_all()
            .map_err(|e| AppError::io(target, e))?;
        Some(backup)
    } else {
        None
    };
    changes.files.push(PayloadChange {
        source: source.to_path_buf(),
        target: write_target,
        before,
        after: source_hash,
        staged: Some(temp),
        original,
        applied: false,
    });
    Ok(())
}

fn copy_tree(
    source: &Path,
    target: &Path,
    bytes: &mut u64,
    files: &mut usize,
    depth: usize,
    changes: &mut PayloadChangeset,
) -> Result<(), AppError> {
    safe_path(source)?;
    safe_path(target)?;
    if depth > 32 {
        return Err(message("本地会话附件目录过深，已取消切换。"));
    }
    for entry in read_dir_without_links(source).map_err(|e| AppError::io(source, e))? {
        *files += 1;
        if *files > 100_000 {
            return Err(message("本地会话附件数量过多，已取消切换。"));
        }
        let metadata =
            fs::symlink_metadata(entry.path()).map_err(|e| AppError::io(entry.path(), e))?;
        if crate::security_limits::is_link_or_reparse_point(&metadata) {
            return Err(message(
                "本地会话附件含链接，已取消切换，原始记录保持不变。",
            ));
        }
        let name = entry.file_name();
        // Never propagate per-session credentials, settings, locks or runtime sockets.
        if matches!(
            name.to_str(),
            Some(".credentials.json" | "settings.json" | "settings.local.json" | ".lock")
        ) {
            continue;
        }
        if metadata.is_dir() {
            copy_tree(
                &entry.path(),
                &target.join(name),
                bytes,
                files,
                depth + 1,
                changes,
            )?;
        } else if metadata.is_file() {
            stage_payload(&entry.path(), &target.join(name), bytes, changes)?;
        }
    }
    Ok(())
}

// Native Windows builds choose an existing short folder before falling back to full UUIDs.
fn session_folder(scope: &Path, id: &str) -> PathBuf {
    let short = scope.join(&id[6..14]);
    let full = scope.join(id);
    if short.exists() {
        short
    } else {
        full
    }
}

fn transcript_exists(projects: &Path, cli: &str, files: &mut usize) -> Result<bool, AppError> {
    safe_path(projects)?;
    let entries = match read_dir_without_links(projects) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(AppError::io(projects, error)),
    };
    for entry in entries {
        *files += 1;
        if *files > 100_000 {
            return Err(message("本地会话文件数量过多，已取消切换。"));
        }
        let path = entry.path().join(format!("{cli}.jsonl"));
        safe_path(&path)?;
        if path.is_file() {
            return Ok(true);
        }
    }
    Ok(false)
}

fn payload(
    record: &Record,
    target: &Path,
    kind: usize,
    projects: &Path,
    bytes: &mut u64,
    files: &mut usize,
    changes: &mut PayloadChangeset,
) -> Result<Value, AppError> {
    let source = record.path.parent().unwrap();
    let mut data = portable_record(record, target);
    let cli = record.data.get("cliSessionId").and_then(Value::as_str);
    if kind == 0 {
        let Some(cli) = cli else {
            return Ok(data);
        };
        if let Some(staged) = record
            .data
            .get("stagedTranscriptPath")
            .and_then(Value::as_str)
        {
            let expected = source.join("imported-staging").join(format!("{cli}.jsonl"));
            if Path::new(staged) != expected {
                return Err(message(
                    "导入会话的正文路径不在本地会话目录内，已取消切换。",
                ));
            }
            stage_payload(
                &expected,
                &target.join("imported-staging").join(format!("{cli}.jsonl")),
                bytes,
                changes,
            )?;
        } else if has_turns(&record.data) {
            // Regular Code transcripts are already shared across all accounts.
            if !transcript_exists(projects, cli, files)? {
                return Err(message(format!(
                    "本地 Code 会话正文缺失，已取消切换：{}",
                    record.path.display()
                )));
            }
        }
        return Ok(data);
    }
    let id = record.data["sessionId"].as_str().unwrap();
    let folder = session_folder(source, id);
    let destination = session_folder(target, id);
    safe_path(&folder)?;
    safe_path(&destination)?;
    if !folder.is_dir() {
        if has_turns(&record.data) {
            return Err(message("Cowork 本地会话的正文目录缺失，已取消切换。"));
        }
        return Ok(data);
    }
    // Copy only portable history and generated files. Per-session settings,
    // credentials, plugins, grants and runtime state stay with their account.
    let transcript_root = folder.join(".claude").join("projects");
    if has_turns(&record.data) && !transcript_exists(&transcript_root, cli.unwrap(), files)? {
        return Err(message("Cowork 本地会话正文缺失，已取消切换。"));
    }
    if transcript_root.is_dir() {
        copy_tree(
            &transcript_root,
            &destination.join(".claude").join("projects"),
            bytes,
            files,
            0,
            changes,
        )?;
    }
    for name in ["outputs", "uploads", "attachments"] {
        let path = folder.join(name);
        if path.exists() {
            copy_tree(&path, &destination.join(name), bytes, files, 0, changes)?;
        }
    }
    // Replace both full and shortened source paths with the folder the native
    // client will actually open at the destination.
    rewrite_paths(&mut data, &target.join(id), &destination);
    rewrite_paths(&mut data, &target.join(&id[6..14]), &destination);
    Ok(data)
}

/// Only called at an explicit switch/launch, never as a startup data migration.
/// The injected roots and identity hint keep all tests off real user data.
pub(crate) fn prepare_switch(
    normal: &Path,
    api: &Path,
    seed_api: bool,
    incoming_login: Option<&Path>,
    projects: &Path,
) -> Result<(), AppError> {
    let _guard = HISTORY_LOCK
        .lock()
        .map_err(|_| message("本地会话正在整理，请重试。"))?;
    for root in [normal, api] {
        safe_path(root)?;
        if crate::claude_desktop_paths::data_locked(root) {
            return Err(message(
                "请先完整退出 Claude Desktop（包括托盘），再切换。Chimera 会自动保留本地会话。",
            ));
        }
    }
    let roots = vec![normal.to_path_buf(), api.to_path_buf()];
    let mut scopes = scopes(&roots)?;
    if scopes.iter().all(|s| s.records.is_empty()) {
        return Ok(());
    }
    add_identity_hints(&mut scopes, normal, normal)?;
    if let Some(login) = incoming_login {
        add_identity_hints(&mut scopes, normal, login)?;
    }
    if seed_api {
        let install = api_install_id(api)?;
        add_scope(&mut scopes, api, &install, LOCAL_ORG);
    }
    let mut newest: BTreeMap<(usize, String), Record> = BTreeMap::new();
    for scope in &scopes {
        for (id, record) in &scope.records {
            let key = (scope.kind, id.clone());
            if let Some(old) = newest.get(&key) {
                if old
                    .data
                    .get("cliSessionId")
                    .and_then(Value::as_str)
                    .is_some()
                    && record
                        .data
                        .get("cliSessionId")
                        .and_then(Value::as_str)
                        .is_some()
                    && old.data["cliSessionId"] != record.data["cliSessionId"]
                {
                    return Err(message(
                        "发现同名但正文标识不同的本地会话，已取消切换，避免覆盖。",
                    ));
                }
                if revision(old) >= revision(record) {
                    continue;
                }
            }
            newest.insert(key, record.clone());
        }
    }
    let mut payload_bytes = 0;
    let mut files = 0;
    let mut changes = Changeset::new();
    let mut payloads = PayloadChangeset::default();
    let mut published = Vec::new();
    let mut sources = Vec::new();
    for scope in &mut scopes {
        safe_path(&scope.dir)?;
        for ((kind, id), record) in &newest {
            if *kind != scope.kind || scope.manifest.deleted.contains(id) {
                continue;
            }
            if let Some(current) = scope.records.get(id) {
                if revision(current) >= revision(record) {
                    continue;
                }
            }
            let source = FileSnapshot::read(record.path.clone())?;
            let target = FileSnapshot::read(scope.dir.join(format!("{id}.json")))?;
            if source
                .contents()
                .and_then(|b| serde_json::from_slice::<Value>(b).ok())
                .as_ref()
                != Some(&record.data)
            {
                return Err(message(
                    "本地会话正在变化，已取消切换，请退出 Claude 后重试。",
                ));
            }
            let portable = payload(
                record,
                &scope.dir,
                *kind,
                projects,
                &mut payload_bytes,
                &mut files,
                &mut payloads,
            )?;
            sources.push(source);
            let data = serde_json::to_vec_pretty(&portable)
                .map_err(|e| AppError::JsonSerialize { source: e })?;
            changes.write(target, data)?;
            published.push((scope.dir.join(format!("{id}.json")), record.modified));
            scope.manifest.known.insert(id.clone());
        }
        let manifest_path = scope.dir.join(MANIFEST);
        let manifest_snapshot = FileSnapshot::read(&manifest_path)?;
        let manifest_bytes = serde_json::to_vec_pretty(&scope.manifest)
            .map_err(|e| AppError::JsonSerialize { source: e })?;
        if manifest_snapshot.contents() != Some(manifest_bytes.as_slice()) {
            changes.write(manifest_snapshot, manifest_bytes)?;
        }
    }
    for source in &sources {
        if FileSnapshot::read(source.path())?.state() != source.state() {
            return Err(message(
                "本地会话正在变化，已取消切换，请退出 Claude 后重试。",
            ));
        }
    }
    publish_changes(&mut payloads, changes, published)
}

fn publish_changes(
    payloads: &mut PayloadChangeset,
    changes: Changeset,
    published: Vec<(PathBuf, SystemTime)>,
) -> Result<(), AppError> {
    if let Err(error) = payloads.commit() {
        payloads.rollback()?;
        return Err(error);
    }
    let applied = match changes.commit() {
        Ok(applied) => applied,
        Err(error) => {
            payloads.rollback()?;
            return Err(error.into());
        }
    };
    let timestamps = (|| -> Result<(), AppError> {
        for (path, modified) in published {
            // Preserve source ordering; copying itself must not make an old
            // conversation look newer on the return trip.
            let file = crate::security_limits::open_regular_file_no_symlink_rw(&path)
                .map_err(|e| AppError::io(&path, e))?;
            file.set_times(FileTimes::new().set_modified(modified))
                .map_err(|e| AppError::io(&path, e))?;
        }
        Ok(())
    })();
    if let Err(error) = timestamps {
        let metadata_rollback = applied.rollback();
        let payload_rollback = payloads.rollback();
        metadata_rollback?;
        payload_rollback?;
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    const ACCOUNT: &str = "11111111-1111-4111-8111-111111111111";
    const SECOND: &str = "22222222-2222-4222-8222-222222222222";
    const ORG: &str = "33333333-3333-4333-8333-333333333333";
    const ID: &str = "local_44444444-4444-4444-8444-444444444444";
    const CLI: &str = "55555555-5555-4555-8555-555555555555";

    fn write(path: &Path, bytes: impl AsRef<[u8]>) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }
    fn scope(root: &Path, kind: usize, account: &str, org: &str) -> PathBuf {
        root.join(KINDS[kind]).join(account).join(org)
    }
    fn record(dir: &Path, activity: u64) -> PathBuf {
        let path = dir.join(format!("{ID}.json"));
        write(&path, serde_json::to_vec(&json!({
            "sessionId": ID, "cliSessionId": CLI, "title": "local conversation",
            "cwd": "work", "createdAt": 1, "lastActivityAt": activity, "completedTurns": 1,
            "permissionMode": "bypassPermissions", "remoteMcpServersConfig": {"secret": "private"},
            "sessionPermissionUpdates": ["grant"], "isArchived": false
        })).unwrap());
        path
    }
    fn setup() -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let normal = dir.path().join("normal");
        let api = dir.path().join("api");
        let projects = dir.path().join("projects");
        write(
            &projects.join("work").join(format!("{CLI}.jsonl")),
            b"{\"type\":\"user\",\"message\":\"hello\"}\n",
        );
        (dir, normal, api, projects)
    }
    fn sync(normal: &Path, api: &Path, projects: &Path) -> Result<(), AppError> {
        prepare_switch(normal, api, true, None, projects)
    }
    fn api_scope(api: &Path, kind: usize) -> PathBuf {
        scope(api, kind, &api_install_id(api).unwrap(), LOCAL_ORG)
    }

    #[test]
    fn local_history_roundtrip_keeps_transcripts_and_newer_progress_without_credentials() {
        let (_dir, normal, api, projects) = setup();
        let official = scope(&normal, 0, ACCOUNT, ORG);
        let source = record(&official, 10);
        let original = fs::read(&source).unwrap();
        sync(&normal, &api, &projects).unwrap();
        let destination = api_scope(&api, 0).join(format!("{ID}.json"));
        let copied = json(&destination).unwrap().unwrap();
        assert_eq!(copied["permissionMode"], "default");
        assert!(copied.get("remoteMcpServersConfig").is_none());
        assert!(copied.get("sessionPermissionUpdates").is_none());
        assert_eq!(fs::read(&source).unwrap(), original);
        assert!(projects.join("work").join(format!("{CLI}.jsonl")).is_file());
        let mut continued = copied;
        continued["lastActivityAt"] = json!(20);
        continued["completedTurns"] = json!(2);
        continued["title"] = json!("continued on API");
        write(&destination, serde_json::to_vec(&continued).unwrap());
        sync(&normal, &api, &projects).unwrap();
        assert_eq!(json(&source).unwrap().unwrap()["completedTurns"], 2);
        assert_eq!(json(&source).unwrap().unwrap()["title"], "continued on API");
        let bytes = fs::read(&source).unwrap();
        sync(&normal, &api, &projects).unwrap();
        assert_eq!(fs::read(&source).unwrap(), bytes);
    }

    #[test]
    fn incoming_official_account_receives_api_history_before_first_open() {
        let (dir, normal, api, projects) = setup();
        record(&scope(&normal, 0, ACCOUNT, ORG), 10);
        let login = dir.path().join("saved-login");
        write(
            &login.join("config.json"),
            serde_json::to_vec(&json!({
                "lastKnownAccountUuid": SECOND, format!("dxt:cache:{ORG}"): {}
            }))
            .unwrap(),
        );
        prepare_switch(&normal, &api, true, Some(&login), &projects).unwrap();
        assert!(scope(&normal, 0, SECOND, ORG)
            .join(format!("{ID}.json"))
            .is_file());
    }

    #[test]
    fn deleted_destination_entry_is_not_resurrected_and_source_is_retained() {
        let (_dir, normal, api, projects) = setup();
        let source = record(&scope(&normal, 0, ACCOUNT, ORG), 10);
        sync(&normal, &api, &projects).unwrap();
        let destination = api_scope(&api, 0).join(format!("{ID}.json"));
        fs::remove_file(&destination).unwrap();
        sync(&normal, &api, &projects).unwrap();
        assert!(!destination.exists());
        assert!(source.exists());
    }

    #[test]
    fn staged_transcript_is_copied_and_relocated_with_metadata() {
        let (_dir, normal, api, projects) = setup();
        let official = scope(&normal, 0, ACCOUNT, ORG);
        let source = record(&official, 10);
        let staging = official
            .join("imported-staging")
            .join(format!("{CLI}.jsonl"));
        write(&staging, b"staged history");
        let mut data = json(&source).unwrap().unwrap();
        data["stagedTranscriptPath"] = json!(staging);
        write(&source, serde_json::to_vec(&data).unwrap());
        sync(&normal, &api, &projects).unwrap();
        let target = api_scope(&api, 0);
        assert_eq!(
            fs::read(target.join("imported-staging").join(format!("{CLI}.jsonl"))).unwrap(),
            b"staged history"
        );
        assert_eq!(
            json(&target.join(format!("{ID}.json"))).unwrap().unwrap()["stagedTranscriptPath"],
            json!(target.join("imported-staging").join(format!("{CLI}.jsonl")))
        );
    }

    #[test]
    fn cowork_short_paths_copy_body_outputs_and_uploads_without_runtime_settings() {
        let (_dir, normal, api, projects) = setup();
        let official = scope(&normal, 1, &ACCOUNT[..8], &ORG[..8]);
        let source = record(&official, 10);
        let payload = official.join(&ID[6..14]);
        write(
            &payload
                .join(".claude/projects/work")
                .join(format!("{CLI}.jsonl")),
            b"cowork body",
        );
        write(&payload.join("outputs/report.txt"), b"output");
        write(&payload.join("uploads/input.txt"), b"input");
        write(&payload.join("settings.json"), b"private settings");
        let mut data = json(&source).unwrap().unwrap();
        data["cwd"] = json!(payload.join("outputs"));
        write(&source, serde_json::to_vec(&data).unwrap());
        sync(&normal, &api, &projects).unwrap();
        let target = api_scope(&api, 1);
        assert_eq!(
            fs::read(
                target
                    .join(ID)
                    .join(".claude/projects/work")
                    .join(format!("{CLI}.jsonl"))
            )
            .unwrap(),
            b"cowork body"
        );
        assert_eq!(
            fs::read(target.join(ID).join("outputs/report.txt")).unwrap(),
            b"output"
        );
        assert_eq!(
            fs::read(target.join(ID).join("uploads/input.txt")).unwrap(),
            b"input"
        );
        assert!(!target.join(ID).join("settings.json").exists());
        assert_eq!(
            json(&target.join(format!("{ID}.json"))).unwrap().unwrap()["cwd"],
            json!(target.join(ID).join("outputs"))
        );
    }

    #[test]
    fn missing_body_or_corrupt_metadata_prevents_publication() {
        let (_dir, normal, api, projects) = setup();
        record(&scope(&normal, 0, ACCOUNT, ORG), 10);
        fs::remove_file(projects.join("work").join(format!("{CLI}.jsonl"))).unwrap();
        assert!(sync(&normal, &api, &projects).is_err());
        assert!(!api_scope(&api, 0).join(format!("{ID}.json")).exists());
        write(
            &scope(&normal, 0, ACCOUNT, ORG).join(format!("{ID}.json")),
            b"{bad JSON",
        );
        assert!(sync(&normal, &api, &projects).is_err());
    }

    #[test]
    fn conflicting_transcript_ids_do_not_overwrite_either_copy() {
        let (_dir, normal, api, projects) = setup();
        let one = record(&scope(&normal, 0, ACCOUNT, ORG), 10);
        let two = record(&scope(&normal, 0, SECOND, ORG), 20);
        let mut data = json(&two).unwrap().unwrap();
        data["cliSessionId"] = json!(SECOND);
        write(&two, serde_json::to_vec(&data).unwrap());
        let before = fs::read(&one).unwrap();
        assert!(sync(&normal, &api, &projects).is_err());
        assert_eq!(fs::read(&one).unwrap(), before);
    }

    #[test]
    fn an_invalid_native_installation_identity_is_never_replaced() {
        let (_dir, normal, api, projects) = setup();
        record(&scope(&normal, 0, ACCOUNT, ORG), 10);
        write(&api.join("ant-did"), b"unrecognized");
        assert!(sync(&normal, &api, &projects).is_err());
        assert_eq!(fs::read(api.join("ant-did")).unwrap(), b"unrecognized");
    }

    #[test]
    fn empty_sessions_survive_switching_and_can_later_receive_a_transcript() {
        let (_dir, normal, api, projects) = setup();
        for kind in 0..2 {
            let official = scope(&normal, kind, ACCOUNT, ORG);
            let source = record(&official, 10);
            let mut data = json(&source).unwrap().unwrap();
            data["cliSessionId"] = Value::Null;
            data["completedTurns"] = json!(0);
            write(&source, serde_json::to_vec(&data).unwrap());
        }
        sync(&normal, &api, &projects).unwrap();
        for kind in 0..2 {
            assert!(api_scope(&api, kind).join(format!("{ID}.json")).is_file());
        }
        let continued = api_scope(&api, 0).join(format!("{ID}.json"));
        let mut data = json(&continued).unwrap().unwrap();
        data["cliSessionId"] = json!(CLI);
        data["completedTurns"] = json!(1);
        data["lastActivityAt"] = json!(20);
        write(&continued, serde_json::to_vec(&data).unwrap());
        sync(&normal, &api, &projects).unwrap();
        let restored = json(&scope(&normal, 0, ACCOUNT, ORG).join(format!("{ID}.json")))
            .unwrap()
            .unwrap();
        assert_eq!(restored["cliSessionId"], CLI);
        assert_eq!(restored["completedTurns"], 1);
    }

    #[test]
    fn mixed_short_account_and_org_names_are_reused_without_duplicate_scopes() {
        let (dir, normal, api, projects) = setup();
        let code_scope = scope(&normal, 0, &ACCOUNT[..8], ORG);
        let cowork_scope = scope(&normal, 1, ACCOUNT, &ORG[..8]);
        record(&code_scope, 10);
        fs::create_dir_all(&cowork_scope).unwrap();
        write(
            &normal.join("config.json"),
            serde_json::to_vec(&json!({
                "lastKnownAccountUuid": ACCOUNT, format!("dxt:cache:{ORG}"): {}
            }))
            .unwrap(),
        );
        let incoming = dir.path().join("incoming");
        write(
            &incoming.join("config.json"),
            serde_json::to_vec(&json!({
                "lastKnownAccountUuid": ACCOUNT, format!("dxt:cache:{ORG}"): {}
            }))
            .unwrap(),
        );
        prepare_switch(&normal, &api, true, Some(&incoming), &projects).unwrap();
        assert!(!scope(&normal, 0, ACCOUNT, ORG).exists());
        assert!(!scope(&normal, 1, ACCOUNT, ORG).exists());
        assert_eq!(scopes(&[normal]).unwrap().len(), 2);
    }

    #[test]
    fn cowork_with_only_unrelated_transcripts_does_not_publish_a_broken_session() {
        let (_dir, normal, api, projects) = setup();
        let official = scope(&normal, 1, ACCOUNT, ORG);
        record(&official, 10);
        write(
            &official
                .join(ID)
                .join(".claude/projects/work")
                .join(format!("{SECOND}.jsonl")),
            b"unrelated",
        );
        assert!(sync(&normal, &api, &projects).is_err());
        assert!(!api_scope(&api, 1).join(format!("{ID}.json")).exists());
    }

    fn file_bytes(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
        let mut out = BTreeMap::new();
        if root.is_dir() {
            for entry in fs::read_dir(root).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    out.extend(file_bytes(&path));
                } else {
                    out.insert(path.clone(), fs::read(path).unwrap());
                }
            }
        }
        out
    }

    #[test]
    fn later_invalid_session_leaves_all_transcripts_attachments_and_metadata_unchanged() {
        for kind in 0..2 {
            let (_dir, normal, api, projects) = setup();
            let source = scope(&normal, kind, ACCOUNT, ORG);
            let target = api_scope(&api, kind);
            let source_record = record(&source, 20);
            record(&target, 10);
            if kind == 0 {
                for (dir, text) in [
                    (&source, b"new body".as_slice()),
                    (&target, b"old body".as_slice()),
                ] {
                    let body = dir.join("imported-staging").join(format!("{CLI}.jsonl"));
                    write(&body, text);
                    let path = dir.join(format!("{ID}.json"));
                    let mut data = json(&path).unwrap().unwrap();
                    data["stagedTranscriptPath"] = json!(body);
                    write(&path, serde_json::to_vec(&data).unwrap());
                }
            } else {
                for (dir, text) in [
                    (&source, b"new body".as_slice()),
                    (&target, b"old body".as_slice()),
                ] {
                    write(
                        &dir.join(ID)
                            .join(".claude/projects/work")
                            .join(format!("{CLI}.jsonl")),
                        text,
                    );
                    write(&dir.join(ID).join("attachments/result.txt"), text);
                }
            }
            // This valid metadata sorts after ID but its required body is absent.
            let later = format!("local_{SECOND}").replace("local_2222", "local_9999");
            let mut data = json(&source_record).unwrap().unwrap();
            data["sessionId"] = json!(later);
            data["cliSessionId"] = json!(SECOND);
            data.as_object_mut().unwrap().remove("stagedTranscriptPath");
            write(
                &source.join(format!("{later}.json")),
                serde_json::to_vec(&data).unwrap(),
            );
            let before = file_bytes(_dir.path());
            assert!(sync(&normal, &api, &projects).is_err());
            assert_eq!(file_bytes(_dir.path()), before, "kind {kind}");
        }
    }

    #[test]
    fn metadata_conflict_restores_payloads_without_overwriting_external_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let mut payloads = PayloadChangeset::default();
        let mut metadata = Changeset::new();
        let source = dir.path().join("source-body");
        let target = dir.path().join("target-body");
        let target_metadata = dir.path().join("record.json");
        write(&source, b"new transcript");
        write(&target, b"original transcript");
        write(&target_metadata, b"old metadata");
        stage_payload(&source, &target, &mut 0, &mut payloads).unwrap();
        metadata
            .write(
                FileSnapshot::read(&target_metadata).unwrap(),
                b"new metadata".to_vec(),
            )
            .unwrap();
        write(&target_metadata, b"external metadata");

        assert!(publish_changes(&mut payloads, metadata, Vec::new()).is_err());

        assert_eq!(fs::read(target).unwrap(), b"original transcript");
        assert_eq!(fs::read(target_metadata).unwrap(), b"external metadata");
        assert!(payloads.files.iter().all(|change| !change.applied));
    }

    #[test]
    fn payload_commit_failure_restores_already_replaced_files() {
        let dir = tempfile::tempdir().unwrap();
        let mut changes = PayloadChangeset::default();
        let mut bytes = 0;
        let first = dir.path().join("first-target");
        for name in ["first", "second"] {
            let source = dir.path().join(format!("{name}-source"));
            let target = dir.path().join(format!("{name}-target"));
            write(&source, b"new content");
            write(&target, b"original content");
            stage_payload(&source, &target, &mut bytes, &mut changes).unwrap();
        }
        // Delete just the second staged file to inject a later persist failure.
        fs::remove_file(changes.files[1].staged.as_ref().unwrap().path()).unwrap();
        assert!(changes.commit().is_err());
        assert_eq!(fs::read(&first).unwrap(), b"new content");
        changes.rollback().unwrap();
        assert_eq!(fs::read(&first).unwrap(), b"original content");
        assert_eq!(
            fs::read(dir.path().join("second-target")).unwrap(),
            b"original content"
        );
    }

    #[test]
    fn payload_rollback_keeps_external_edits_and_a_recoverable_original() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        let target = dir.path().join("target");
        write(&source, b"new");
        write(&target, b"original");
        let mut changes = PayloadChangeset::default();
        stage_payload(&source, &target, &mut 0, &mut changes).unwrap();
        changes.commit().unwrap();
        let recovery = changes.files[0]
            .original
            .as_ref()
            .unwrap()
            .path()
            .to_path_buf();
        write(&target, b"external edit");
        assert!(changes.rollback().is_err());
        drop(changes);
        assert_eq!(fs::read(target).unwrap(), b"external edit");
        assert_eq!(fs::read(recovery).unwrap(), b"original");
    }

    #[test]
    fn payload_source_or_target_changed_after_staging_is_rejected() {
        for change_source in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let source = dir.path().join("source");
            let target = dir.path().join("target");
            write(&source, b"new");
            write(&target, b"original");
            let mut changes = PayloadChangeset::default();
            stage_payload(&source, &target, &mut 0, &mut changes).unwrap();
            write(
                if change_source { &source } else { &target },
                b"external edit",
            );
            assert!(changes.commit().is_err());
            changes.rollback().unwrap();
            assert_eq!(
                fs::read(&target).unwrap(),
                if change_source {
                    b"original".as_slice()
                } else {
                    b"external edit".as_slice()
                }
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn long_payload_paths_support_both_copying_and_updates() {
        use std::os::windows::ffi::OsStrExt;
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.jsonl");
        let target = dir.path().join("nested-".repeat(32)).join("body.jsonl");
        assert!(target.as_os_str().encode_wide().count() > 260);
        let mut bytes = 0;
        for contents in ["first turn", "first turn\ncontinued turn"] {
            write(&source, contents);
            let mut changes = PayloadChangeset::default();
            stage_payload(&source, &target, &mut bytes, &mut changes).unwrap();
            changes.commit().unwrap();
            assert_eq!(fs::read_to_string(&target).unwrap(), contents);
        }
    }

    #[cfg(windows)]
    #[test]
    fn junction_ancestor_is_rejected_before_writing() {
        use std::os::windows::fs::symlink_dir;
        let (dir, normal, api, projects) = setup();
        record(&scope(&normal, 0, ACCOUNT, ORG), 10);
        let outside = dir.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        // Developer Mode or symlink privileges are not guaranteed on every host.
        if symlink_dir(&outside, &api).is_err() {
            return;
        }
        assert!(sync(&normal, &api, &projects).is_err());
        assert!(fs::read_dir(&outside).unwrap().next().is_none());
    }
}
