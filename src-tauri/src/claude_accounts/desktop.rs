//! Claude Desktop accounts: one Chromium `--user-data-dir` per account under
//! `<Chimera data>/claude-desktop-profiles/<id>/user-data`. Sign-in, settings
//! and MCP are separate per profile and several profiles can run side by
//! side; Desktop conversations live on the account's server side, so nothing
//! is lost by opening another profile. The app's own default profile is never
//! written; its sign-in is only read to show plan and quota (desktop_auth).
//!
//! The approach (Chromium `--user-data-dir`; first sign-in only while no
//! other Claude Desktop runs, because the `claude://` sign-in callback goes
//! to the running instance) follows claude-code-account-switcher
//! `docs/desktop.md`.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{normalize_account_name, strip_bom, validate_account_id};
use crate::error::AppError;
use crate::security_limits::{
    is_link_or_reparse_point, read_dir_without_links, read_to_string_limited,
};

const PROFILES_DIR: &str = "claude-desktop-profiles";
const PROFILE_FILE: &str = "profile.json";
const USER_DATA_DIR: &str = "user-data";
/// Prefix of a folder being deleted; never a valid id.
const DELETING_PREFIX: &str = ".deleting-";
const MAX_PROFILES: usize = 50;
const MAX_RECORD_BYTES: u64 = 64 * 1024;
/// Claude Desktop's `config.json` holds small preferences and the encrypted
/// token cache; anything larger is not one we understand.
const MAX_DESKTOP_CONFIG_BYTES: u64 = 4 * 1024 * 1024;
const UNNAMED: &str = "未命名账号";

static PROFILES_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopProfileDto {
    pub id: String,
    pub name: String,
    pub created_at: String,
    /// Claude Desktop has opened this profile at least once.
    pub initialized: bool,
    /// The profile holds an (encrypted) sign-in token cache.
    pub signed_in: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileRecord {
    name: String,
    created_at: String,
}

fn profiles_root() -> PathBuf {
    crate::config::get_app_config_dir().join(PROFILES_DIR)
}

fn profile_dir(root: &Path, id: &str) -> Result<PathBuf, AppError> {
    super::child_path(root, id, "")
}

/// An existing, real (not linked) profile folder.
fn existing_profile_dir(root: &Path, id: &str) -> Result<PathBuf, AppError> {
    let dir = profile_dir(root, id)?;
    match fs::symlink_metadata(&dir) {
        Ok(meta) if meta.is_dir() && !is_link_or_reparse_point(&meta) => Ok(dir),
        Ok(_) => Err(AppError::InvalidInput(
            "账号目录不是普通文件夹，已拒绝操作".to_string(),
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Err(AppError::InvalidInput("账号不存在或已被删除".to_string()))
        }
        Err(error) => Err(AppError::io(&dir, error)),
    }
}

/// A profile's Chromium user-data folder, for reading its sign-in.
pub(crate) fn profile_user_data(id: &str) -> Result<PathBuf, AppError> {
    Ok(existing_profile_dir(&profiles_root(), id)?.join(USER_DATA_DIR))
}

/// Whether Claude Desktop's `config.json` holds a token cache. The cache is
/// encrypted and only checked for being non-empty, never read out.
pub(crate) fn desktop_config_signed_in(text: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(strip_bom(text)) else {
        return false;
    };
    ["oauth:tokenCacheV2", "oauth:tokenCache"]
        .iter()
        .any(|key| {
            value
                .get(*key)
                .and_then(Value::as_str)
                .is_some_and(|cache| !cache.is_empty())
        })
}

fn user_data_state(dir: &Path) -> (bool, bool) {
    let initialized = fs::read_dir(dir).is_ok_and(|mut entries| entries.next().is_some());
    let signed_in = read_to_string_limited(&dir.join("config.json"), MAX_DESKTOP_CONFIG_BYTES)
        .ok()
        .is_some_and(|text| desktop_config_signed_in(&text));
    (initialized, signed_in)
}

fn read_record(dir: &Path) -> ProfileRecord {
    read_to_string_limited(&dir.join(PROFILE_FILE), MAX_RECORD_BYTES)
        .ok()
        .and_then(|text| serde_json::from_str::<ProfileRecord>(strip_bom(&text)).ok())
        .map(|record| ProfileRecord {
            name: normalize_account_name(&record.name).unwrap_or_else(|_| UNNAMED.to_string()),
            created_at: record.created_at,
        })
        .unwrap_or_else(|| ProfileRecord {
            name: UNNAMED.to_string(),
            created_at: String::new(),
        })
}

fn dto(dir: &Path, id: &str, record: ProfileRecord) -> DesktopProfileDto {
    let (initialized, signed_in) = user_data_state(&dir.join(USER_DATA_DIR));
    DesktopProfileDto {
        id: id.to_string(),
        name: record.name,
        created_at: record.created_at,
        initialized,
        signed_in,
    }
}

pub(crate) fn list_in(root: &Path) -> Result<Vec<DesktopProfileDto>, AppError> {
    let entries = match read_dir_without_links(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(AppError::io(root, error)),
    };
    let mut profiles: Vec<DesktopProfileDto> = entries
        .into_iter()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|entry| {
            let id = entry.file_name().to_str()?.to_string();
            validate_account_id(&id).ok()?;
            let dir = entry.path();
            Some(dto(&dir, &id, read_record(&dir)))
        })
        .collect();
    profiles.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(profiles)
}

/// Retries deleting folders an earlier delete could not finish (a file was
/// still open then); they still hold that account's sign-in.
fn sweep_deleted(root: &Path) {
    let Ok(entries) = read_dir_without_links(root) else {
        return;
    };
    for entry in entries {
        let is_trash = entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with(DELETING_PREFIX));
        if is_trash && entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

pub(crate) fn create_in(root: &Path, name: &str) -> Result<DesktopProfileDto, AppError> {
    let name = normalize_account_name(name)?;
    let _guard = PROFILES_LOCK.lock()?;
    fs::create_dir_all(root).map_err(|error| AppError::io(root, error))?;
    sweep_deleted(root);
    if list_in(root)?.len() >= MAX_PROFILES {
        return Err(AppError::InvalidInput(format!(
            "最多添加 {MAX_PROFILES} 个账号"
        )));
    }
    for _ in 0..4 {
        let id = super::new_account_id();
        let dir = profile_dir(root, &id)?;
        match fs::create_dir(&dir) {
            Ok(()) => {
                let record = ProfileRecord {
                    name,
                    created_at: chrono::Utc::now().to_rfc3339(),
                };
                let populated = fs::create_dir(dir.join(USER_DATA_DIR))
                    .map_err(|error| AppError::io(&dir, error))
                    .and_then(|()| {
                        crate::config::write_json_file(&dir.join(PROFILE_FILE), &record)
                    });
                if let Err(error) = populated {
                    let _ = fs::remove_dir_all(dir);
                    return Err(error);
                }
                return Ok(dto(&dir, &id, record));
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(AppError::io(&dir, error)),
        }
    }
    Err(AppError::Message("无法生成账号标识，请重试".to_string()))
}

pub(crate) fn rename_in(root: &Path, id: &str, name: &str) -> Result<DesktopProfileDto, AppError> {
    let name = normalize_account_name(name)?;
    let _guard = PROFILES_LOCK.lock()?;
    let dir = existing_profile_dir(root, id)?;
    let mut record = read_record(&dir);
    record.name = name;
    if record.created_at.is_empty() {
        record.created_at = chrono::Utc::now().to_rfc3339();
    }
    crate::config::write_json_file(&dir.join(PROFILE_FILE), &record)?;
    Ok(dto(&dir, id, record))
}

fn in_use_error() -> AppError {
    AppError::Message("这个账号正在 Claude Desktop 中打开，请先退出它再删除。".to_string())
}

/// Whether a running Claude Desktop holds this profile. Chromium keeps
/// `lockfile` open without write sharing on Windows, and a `SingletonLock`
/// link on macOS / Linux, for as long as the profile is open.
fn profile_in_use(user_data: &Path) -> bool {
    #[cfg(windows)]
    {
        const ERROR_SHARING_VIOLATION: i32 = 32;
        fs::OpenOptions::new()
            .write(true)
            .open(user_data.join("lockfile"))
            .is_err_and(|error| error.raw_os_error() == Some(ERROR_SHARING_VIOLATION))
    }
    #[cfg(unix)]
    {
        fs::symlink_metadata(user_data.join("SingletonLock")).is_ok()
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = user_data;
        false
    }
}

/// Deletes the profile folder: its local sign-in, settings and caches. It is
/// first renamed out of the listing, so a folder still open (Windows refuses
/// the rename) is left whole instead of half-deleted.
pub(crate) fn delete_in(root: &Path, id: &str) -> Result<(), AppError> {
    let _guard = PROFILES_LOCK.lock()?;
    let dir = existing_profile_dir(root, id)?;
    if profile_in_use(&dir.join(USER_DATA_DIR)) {
        return Err(in_use_error());
    }
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let trash = root.join(format!("{DELETING_PREFIX}{id}-{}", &suffix[..8]));
    fs::rename(&dir, &trash).map_err(|error| {
        // ERROR_ACCESS_DENIED / ERROR_SHARING_VIOLATION: a file inside is open.
        if cfg!(windows) && matches!(error.raw_os_error(), Some(5) | Some(32)) {
            in_use_error()
        } else {
            AppError::io(&dir, error)
        }
    })?;
    if let Err(error) = fs::remove_dir_all(&trash) {
        // Already out of the listing; leftovers are inert.
        log::warn!(
            "删除 Claude Desktop 账号目录未完全完成: {}: {error}",
            trash.display()
        );
    }
    Ok(())
}

// ===== launching =====

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum InstallKind {
    /// A plain executable: the claude.com installer (Squirrel) or a
    /// machine-wide install.
    DirectExe,
    /// Microsoft Store / MSIX package under `WindowsApps`.
    Msix,
    /// `Claude.app` on macOS.
    MacApp,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DesktopLaunch {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// `open` returns once the app is up, so its exit status is meaningful;
    /// a direct executable runs for as long as the app is open.
    pub wait: bool,
    pub kind: InstallKind,
}

pub(crate) fn classify_installation(path: &Path) -> InstallKind {
    let text = path
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase();
    if text.contains("\\windowsapps\\") {
        InstallKind::Msix
    } else if text.ends_with(".app\\contents\\macos\\claude") {
        InstallKind::MacApp
    } else {
        InstallKind::DirectExe
    }
}

fn version_key(version: &str) -> Vec<u64> {
    version
        .split('.')
        .map(|part| part.parse().unwrap_or(0))
        .collect()
}

/// A Squirrel install keeps the real app in `app-<version>\Claude.exe` next
/// to the update stub; launch the newest one directly so the switch reaches
/// the app itself. Anything else is launched as detected.
pub(crate) fn resolve_direct_executable(exe: &Path) -> PathBuf {
    let newest = exe
        .parent()
        .and_then(|root| fs::read_dir(root).ok())
        .and_then(|entries| {
            entries
                .flatten()
                .filter_map(|entry| {
                    let name = entry.file_name();
                    let version = name.to_str()?.strip_prefix("app-")?;
                    let candidate = entry.path().join("Claude.exe");
                    if candidate.is_file() {
                        Some((version_key(version), candidate))
                    } else {
                        None
                    }
                })
                .max_by(|left, right| left.0.cmp(&right.0))
                .map(|(_, candidate)| candidate)
        });
    newest.unwrap_or_else(|| exe.to_path_buf())
}

/// Program and arguments that open Claude Desktop on `user_data_dir`.
pub(crate) fn launch_plan(
    installation: &Path,
    user_data_dir: &Path,
    local_app_data: Option<&Path>,
) -> Result<DesktopLaunch, AppError> {
    let switch = format!("--user-data-dir={}", user_data_dir.display());
    let kind = classify_installation(installation);
    Ok(match kind {
        InstallKind::DirectExe => DesktopLaunch {
            program: resolve_direct_executable(installation),
            args: vec![switch],
            wait: false,
            kind,
        },
        // A packaged app cannot be started by its path inside WindowsApps;
        // its execution alias starts it and passes the arguments through.
        InstallKind::Msix => {
            let local = local_app_data.ok_or_else(|| {
                AppError::Message("无法定位 Claude Desktop 的执行别名".to_string())
            })?;
            DesktopLaunch {
                program: local
                    .join("Microsoft")
                    .join("WindowsApps")
                    .join("claude-desktop.exe"),
                args: vec![switch],
                wait: false,
                kind,
            }
        }
        // `open -n` starts a new instance instead of activating the running one.
        InstallKind::MacApp => {
            let bundle = installation
                .ancestors()
                .nth(3)
                .ok_or_else(|| AppError::Message("无法定位 Claude.app".to_string()))?;
            DesktopLaunch {
                program: PathBuf::from("open"),
                args: vec![
                    "-n".to_string(),
                    "-a".to_string(),
                    bundle.to_string_lossy().into_owned(),
                    "--args".to_string(),
                    switch,
                ],
                wait: true,
                kind,
            }
        }
    })
}

const RUNNING_MESSAGE: &str = "Claude Desktop 正在运行。这个账号还没登录：登录要经过 claude:// 回调，会被已打开的 Claude 窗口接走。请先完全退出 Claude Desktop（包括托盘图标）再打开这个账号登录；登录后即可与其他账号同时使用。";

/// Opens Claude Desktop on the profile. A profile that is not signed in yet
/// is refused while any Claude Desktop runs.
pub(crate) fn launch_in(
    root: &Path,
    id: &str,
    installation: Option<&Path>,
    local_app_data: Option<&Path>,
    desktop_running: impl FnOnce() -> bool,
    run: impl FnOnce(&DesktopLaunch) -> Result<(), AppError>,
) -> Result<(), AppError> {
    let dir = existing_profile_dir(root, id)?;
    let installation = installation
        .ok_or_else(|| AppError::Message("未检测到 Claude Desktop，请先安装后再试".to_string()))?;
    let user_data = dir.join(USER_DATA_DIR);
    fs::create_dir_all(&user_data).map_err(|error| AppError::io(&user_data, error))?;
    if !user_data_state(&user_data).1 && desktop_running() {
        return Err(AppError::Message(RUNNING_MESSAGE.to_string()));
    }
    let plan = launch_plan(installation, &user_data, local_app_data)?;
    run(&plan)
}

fn run_launch(plan: &DesktopLaunch) -> Result<(), AppError> {
    let present = match plan.kind {
        // An execution alias is a reparse point that ordinary metadata calls
        // cannot follow; only its presence is checked.
        InstallKind::Msix => fs::symlink_metadata(&plan.program).is_ok(),
        InstallKind::DirectExe => plan.program.is_file(),
        InstallKind::MacApp => true,
    };
    if !present {
        return Err(AppError::Message(match plan.kind {
            InstallKind::Msix => "未找到 Claude Desktop 的执行别名 claude-desktop.exe。请在 Windows「设置 > 应用 > 高级应用设置 > 应用执行别名」中开启 Claude 后再试。".to_string(),
            _ => format!("未找到 Claude Desktop 程序：{}", plan.program.display()),
        }));
    }
    let mut command = Command::new(&plan.program);
    command
        .args(&plan.args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if plan.wait {
        let status = command
            .status()
            .map_err(|error| AppError::Message(format!("启动 Claude Desktop 失败：{error}")))?;
        return if status.success() {
            Ok(())
        } else {
            Err(AppError::Message("启动 Claude Desktop 失败".to_string()))
        };
    }
    let spawned = command.spawn();
    match spawned {
        Ok(_) => Ok(()),
        Err(error) => Err(AppError::Message(format!(
            "启动 Claude Desktop 失败：{error}"
        ))),
    }
}

pub fn list() -> Result<Vec<DesktopProfileDto>, AppError> {
    list_in(&profiles_root())
}

pub fn create(name: &str) -> Result<DesktopProfileDto, AppError> {
    create_in(&profiles_root(), name)
}

pub fn rename(id: &str, name: &str) -> Result<DesktopProfileDto, AppError> {
    rename_in(&profiles_root(), id, name)
}

pub fn delete(id: &str) -> Result<(), AppError> {
    delete_in(&profiles_root(), id)
}

pub fn launch(id: &str, installation: Option<PathBuf>) -> Result<(), AppError> {
    let local_app_data = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    launch_in(
        &profiles_root(),
        id,
        installation.as_deref(),
        local_app_data.as_deref(),
        super::claude_desktop_running,
        run_launch,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn desktop_sign_in_is_a_non_empty_token_cache() {
        assert!(desktop_config_signed_in(
            r#"{"oauth:tokenCacheV2":"djEw..."}"#
        ));
        assert!(desktop_config_signed_in(r#"{"oauth:tokenCache":"x"}"#));
        assert!(!desktop_config_signed_in(r#"{"oauth:tokenCacheV2":""}"#));
        assert!(!desktop_config_signed_in(r#"{"locale":"zh-CN"}"#));
        assert!(!desktop_config_signed_in("not json"));
    }

    #[test]
    fn create_list_rename_and_delete_round_trip() {
        let temp = tempdir().unwrap();
        let root = temp.path().join(PROFILES_DIR);
        assert!(list_in(&root).unwrap().is_empty());

        let created = create_in(&root, " 工作号 ").unwrap();
        assert_eq!(created.name, "工作号");
        assert!(!created.initialized && !created.signed_in);
        let dir = root.join(&created.id);
        assert!(dir.join(USER_DATA_DIR).is_dir());

        fs::write(
            dir.join(USER_DATA_DIR).join("config.json"),
            r#"{"oauth:tokenCacheV2":"encrypted"}"#,
        )
        .unwrap();
        // Not profiles: hidden leftovers and stray files are skipped.
        fs::create_dir(root.join(".deleting-old-1234")).unwrap();
        fs::write(root.join("notes.txt"), "x").unwrap();
        let listed = list_in(&root).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].initialized && listed[0].signed_in);

        let renamed = rename_in(&root, &created.id, "个人号").unwrap();
        assert_eq!(renamed.name, "个人号");
        assert_eq!(renamed.created_at, created.created_at);

        delete_in(&root, &created.id).unwrap();
        assert!(!dir.exists());
        assert!(list_in(&root).unwrap().is_empty());
        assert!(delete_in(&root, &created.id).is_err());
    }

    #[test]
    fn a_damaged_record_still_lists_under_its_folder_id() {
        let temp = tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join("work")).unwrap();
        fs::write(root.join("work").join(PROFILE_FILE), "{ broken").unwrap();
        let listed = list_in(root).unwrap();
        assert_eq!(listed[0].id, "work");
        assert_eq!(listed[0].name, UNNAMED);
    }

    #[test]
    fn delete_refuses_invalid_ids_and_leaves_other_paths_alone() {
        let temp = tempdir().unwrap();
        let root = temp.path().join(PROFILES_DIR);
        fs::create_dir_all(&root).unwrap();
        let outside = temp.path().join("keep");
        fs::create_dir_all(&outside).unwrap();
        for id in ["../keep", "..", "", "KEEP", "keep/.."] {
            assert!(delete_in(&root, id).is_err(), "{id}");
        }
        assert!(outside.is_dir());
        fs::write(root.join("file"), "x").unwrap();
        assert!(delete_in(&root, "file").is_err());
        assert!(root.join("file").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn delete_refuses_linked_or_open_profiles() {
        let temp = tempdir().unwrap();
        let root = temp.path().join(PROFILES_DIR);
        fs::create_dir_all(&root).unwrap();
        let target = temp.path().join("elsewhere");
        fs::create_dir_all(&target).unwrap();
        std::os::unix::fs::symlink(&target, root.join("linked")).unwrap();
        assert!(delete_in(&root, "linked").is_err());
        assert!(target.is_dir());

        let open = create_in(&root, "开着的").unwrap();
        let user_data = root.join(&open.id).join(USER_DATA_DIR);
        std::os::unix::fs::symlink("host-123", user_data.join("SingletonLock")).unwrap();
        assert!(delete_in(&root, &open.id).is_err());
        assert!(root.join(&open.id).is_dir());
    }

    #[test]
    fn squirrel_launch_uses_the_newest_app_directory() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("AnthropicClaude");
        for version in ["1.2.0", "1.10.0", "1.9.9"] {
            let app = root.join(format!("app-{version}"));
            fs::create_dir_all(&app).unwrap();
            fs::write(app.join("Claude.exe"), "").unwrap();
        }
        fs::write(root.join("Claude.exe"), "").unwrap();
        let profile = temp.path().join("acct").join(USER_DATA_DIR);
        let plan = launch_plan(&root.join("Claude.exe"), &profile, None).unwrap();
        assert_eq!(plan.kind, InstallKind::DirectExe);
        assert_eq!(plan.program, root.join("app-1.10.0").join("Claude.exe"));
        assert_eq!(
            plan.args,
            vec![format!("--user-data-dir={}", profile.display())]
        );
        assert!(!plan.wait);
        let direct = root.join("app-1.2.0").join("Claude.exe");
        assert_eq!(resolve_direct_executable(&direct), direct);
    }

    #[test]
    fn msix_launch_goes_through_the_execution_alias() {
        let local = Path::new("C:/Users/me/AppData/Local");
        let installation = Path::new(
            r"C:\Program Files\WindowsApps\Claude_1.0.0.0_x64__pzs8sxrjxfjjc\app\Claude.exe",
        );
        let profile =
            Path::new(r"C:\Users\me\.chimera-plus-plus\claude-desktop-profiles\work\user-data");
        let plan = launch_plan(installation, profile, Some(local)).unwrap();
        assert_eq!(plan.kind, InstallKind::Msix);
        assert_eq!(
            plan.program,
            local
                .join("Microsoft")
                .join("WindowsApps")
                .join("claude-desktop.exe")
        );
        assert_eq!(
            plan.args,
            vec![format!("--user-data-dir={}", profile.display())]
        );
        assert!(launch_plan(installation, profile, None).is_err());
        assert_eq!(
            classify_installation(Path::new(
                r"C:\Users\me\AppData\Local\Microsoft\WindowsApps\claude-desktop.exe"
            )),
            InstallKind::Msix
        );
    }

    #[test]
    fn mac_launch_opens_a_new_instance_of_the_bundle() {
        let plan = launch_plan(
            Path::new("/Applications/Claude.app/Contents/MacOS/Claude"),
            Path::new("/Users/me/p a"),
            None,
        )
        .unwrap();
        assert_eq!(plan.program, PathBuf::from("open"));
        assert_eq!(
            plan.args,
            vec![
                "-n",
                "-a",
                "/Applications/Claude.app",
                "--args",
                "--user-data-dir=/Users/me/p a"
            ]
        );
        assert!(plan.wait);
    }

    #[test]
    fn an_unsigned_profile_is_refused_while_desktop_runs() {
        let temp = tempdir().unwrap();
        let root = temp.path().join(PROFILES_DIR);
        let profile = create_in(&root, "新号").unwrap();
        let exe = temp.path().join("Claude.exe");
        let mut launched = None;
        let refused = launch_in(
            &root,
            &profile.id,
            Some(&exe),
            None,
            || true,
            |plan| {
                launched = Some(plan.clone());
                Ok(())
            },
        );
        assert!(refused.unwrap_err().to_string().contains("完全退出"));
        assert!(launched.is_none());

        launch_in(
            &root,
            &profile.id,
            Some(&exe),
            None,
            || false,
            |plan| {
                launched = Some(plan.clone());
                Ok(())
            },
        )
        .unwrap();
        assert!(launched.take().is_some());

        fs::write(
            root.join(&profile.id)
                .join(USER_DATA_DIR)
                .join("config.json"),
            r#"{"oauth:tokenCacheV2":"encrypted"}"#,
        )
        .unwrap();
        launch_in(
            &root,
            &profile.id,
            Some(&exe),
            None,
            || true,
            |plan| {
                launched = Some(plan.clone());
                Ok(())
            },
        )
        .unwrap();
        assert!(launched.is_some());

        assert!(
            launch_in(&root, &profile.id, None, None, || false, |_| Ok(()))
                .unwrap_err()
                .to_string()
                .contains("未检测到")
        );
        assert!(launch_in(&root, "missing", Some(&exe), None, || false, |_| Ok(())).is_err());
    }
}
