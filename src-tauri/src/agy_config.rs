//! Antigravity CLI (`agy`) 的 live 配置。
//!
//! `agy` 只从进程环境读取 `GEMINI_API_KEY` 和 `GOOGLE_GEMINI_BASE_URL`，`settings.json`
//! 只负责 `modelProvider` 和 `model`（只认显示名）。CC Switch 管不到用户自己敲的 `agy`，
//! 所以卡片没有「启用」，只有「打开终端」，每张卡只作用于它打开的那个终端：
//!
//! - **官方登录卡**：`agy --model=<显示名>`（没设模型就是 `agy`），模型只对这次会话生效。
//!   登录凭据由 agy 自己保管（不在 `~/.gemini` 里）。
//! - **第三方 Key 卡**：`agy --gemini_dir=<私有目录>`，私有目录在
//!   `~/.cc-switch/agy/<供应商>/`，它的 `antigravity-cli/settings.json` 写
//!   `modelProvider: gemini` 和模型，`config` 软链回 `~/.gemini/config`（MCP、Skills、
//!   提示词照常共享）；Key 和地址只经子进程环境传入。
//!
//! 真实的 `~/.gemini/antigravity-cli/settings.json` 一律不写，直接敲 `agy` 永远是官方登录，
//! 模型由 agy 自己的 `/model` 管。唯一的例外是撤掉 #8268 测试版留下的 `modelProvider`：
//! 测试版还装过包装脚本、改过 shell 启动文件，启动时由 [`remove_legacy_launcher`] 只删带
//! 标记的内容。

#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};

use crate::config::{atomic_write_private, get_app_config_dir, get_home_dir, write_text_file};
use crate::error::AppError;

/// `~/.gemini/antigravity-cli`
pub fn agy_dir() -> PathBuf {
    get_home_dir().join(".gemini").join("antigravity-cli")
}

/// `~/.gemini/config`：CLI、桌面版和 IDE 共用的 MCP / Skills / 提示词目录。
pub fn customizations_dir() -> PathBuf {
    get_home_dir().join(".gemini").join("config")
}

pub fn settings_path() -> PathBuf {
    agy_dir().join("settings.json")
}

/// Key 模式各供应商私有 `--gemini_dir` 的上级目录。
pub fn key_profiles_root() -> PathBuf {
    get_app_config_dir().join("agy")
}

/// 某个供应商的私有 `--gemini_dir`。供应商 ID 不是安全的路径段时换成带哈希的名字，
/// 名字要跨版本稳定：会话记录就存在这个目录里。
pub fn key_profile_dir(provider_id: &str) -> PathBuf {
    key_profiles_root().join(profile_dir_name(provider_id))
}

fn profile_dir_name(provider_id: &str) -> String {
    let safe = !provider_id.is_empty()
        && provider_id != "."
        && provider_id != ".."
        && provider_id.len() <= 64
        && provider_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if safe {
        return provider_id.to_string();
    }
    let prefix: String = provider_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        .take(32)
        .collect();
    format!("{prefix}-{:016x}", fnv1a(provider_id.as_bytes()))
}

fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3)
    })
}

/// 从 live 读回编辑器用的 `{ env, config }`。Key 不在任何文件里，所以 `env` 恒为空。
pub fn read_live_settings() -> Result<Value, AppError> {
    let settings_file = settings_path();
    if !settings_file.exists() {
        return Err(AppError::localized(
            "agy.config.missing",
            "Antigravity 配置文件不存在",
            "Antigravity configuration files are missing",
        ));
    }
    let raw = fs::read(&settings_file).map_err(|e| AppError::io(&settings_file, e))?;
    let settings: Value = serde_json::from_slice(&raw)
        .map_err(|e| AppError::Config(format!("Invalid agy settings.json: {e}")))?;
    let model = settings.get("model").cloned().filter(|v| !v.is_null());
    Ok(json!({
        "env": {},
        "config": {
            "model": { "name": model.unwrap_or(Value::Null) }
        }
    }))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AgyProjection {
    api_key: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
}

impl AgyProjection {
    fn of(settings: &Value) -> Self {
        let env = settings.get("env");
        let api_key = non_empty(env_string(env, "GEMINI_API_KEY"));
        let base_url = non_empty(env_string(env, "GOOGLE_GEMINI_BASE_URL"));
        let model = non_empty(
            settings
                .pointer("/config/model/name")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| env_string(env, "GEMINI_MODEL")),
        );
        Self {
            api_key,
            base_url,
            model,
        }
    }

    /// 带 Key 才是第三方模式；地址必须和 Key 一起出现（`agy_direct` 已校验）。
    fn is_key_mode(&self) -> bool {
        self.api_key.is_some()
    }
}

fn env_string(env: Option<&Value>, key: &str) -> Option<String> {
    env?.get(key)?.as_str().map(str::to_string)
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|s| !s.trim().is_empty())
}

/// 配置里是否带有值得导入的真实内容（Key、端点或模型）。
pub(crate) fn has_managed_content(settings: &Value) -> bool {
    let projection = AgyProjection::of(settings);
    projection.api_key.is_some() || projection.base_url.is_some() || projection.model.is_some()
}

/// 将当前选中的 Antigravity 供应商模型写入 settings.json（保留无关配置项）。
pub(crate) fn write_live_settings(settings: &Value) -> Result<(), AppError> {
    let projection = AgyProjection::of(settings);
    let path = settings_path();
    let pre = if path.exists() {
        Some(fs::read(&path).map_err(|e| AppError::io(&path, e))?)
    } else {
        None
    };
    let mut doc: Value = match pre.as_deref() {
        Some(bytes) if !bytes.is_empty() => serde_json::from_slice(bytes).map_err(|e| {
            AppError::Config(format!("Invalid agy settings JSON {}: {e}", path.display()))
        })?,
        _ => json!({}),
    };
    let obj = doc.as_object_mut().ok_or_else(|| {
        AppError::Config(format!(
            "Invalid agy settings JSON root {}: expected object",
            path.display()
        ))
    })?;
    if let Some(model) = &projection.model {
        obj.insert("model".to_string(), Value::String(model.clone()));
    } else {
        obj.remove("model");
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| AppError::io(parent, e))?;
    }
    crate::config::write_json_file(&path, &doc)
}

/// 私有目录里 `settings.json` 的补丁：Key 模式加上卡上的模型。
fn apply_key_profile_patch(
    path: &Path,
    pre: Option<&[u8]>,
    projection: &AgyProjection,
) -> Result<Vec<u8>, AppError> {
    let mut doc: Value = match pre {
        Some(bytes) if !bytes.is_empty() => serde_json::from_slice(bytes).map_err(|e| {
            AppError::Config(format!("Invalid agy settings JSON {}: {e}", path.display()))
        })?,
        _ => json!({}),
    };
    let obj = doc.as_object_mut().ok_or_else(|| {
        AppError::Config(format!(
            "Invalid agy settings JSON root {}: expected object",
            path.display()
        ))
    })?;
    obj.insert("modelProvider".to_string(), json!("gemini"));
    match &projection.model {
        Some(name) => {
            obj.insert("model".to_string(), json!(name));
        }
        None => {
            obj.remove("model");
        }
    }
    let mut bytes = serde_json::to_vec_pretty(&doc)
        .map_err(|e| AppError::Config(format!("Serialize agy settings failed: {e}")))?;
    bytes.push(b'\n');
    Ok(bytes)
}

/// 在终端里启动这张卡要用的参数。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgyLaunch {
    /// Key 模式的私有 `--gemini_dir`；官方登录卡为 `None`，直接跑原生 `agy`。
    pub gemini_dir: Option<PathBuf>,
    /// 官方登录卡的 `--model`（显示名，只对这次会话生效）；Key 卡的模型写在私有目录里，为 `None`。
    pub model: Option<String>,
    /// 只给这一个 agy 进程的环境变量；`None` 表示要清掉（用户 rc 里可能 export 过）。
    pub env: Vec<(&'static str, Option<String>)>,
}

/// 准备在终端里启动某张卡：Key 卡会建好（或更新）它的私有目录。
pub(crate) fn prepare_launch(provider_id: &str, settings: &Value) -> Result<AgyLaunch, AppError> {
    let projection = AgyProjection::of(settings);
    if !projection.is_key_mode() {
        return Ok(AgyLaunch {
            gemini_dir: None,
            model: projection.model,
            env: Vec::new(),
        });
    }
    let dir = key_profile_dir(provider_id);
    prepare_key_profile(&dir, &projection)?;
    Ok(AgyLaunch {
        gemini_dir: Some(dir),
        model: None,
        env: vec![
            ("GEMINI_API_KEY", projection.api_key.clone()),
            ("GOOGLE_GEMINI_BASE_URL", projection.base_url.clone()),
        ],
    })
}

fn prepare_key_profile(dir: &Path, projection: &AgyProjection) -> Result<(), AppError> {
    let settings = dir.join("antigravity-cli").join("settings.json");
    let pre = if settings.exists() {
        Some(fs::read(&settings).map_err(|e| AppError::io(&settings, e))?)
    } else {
        None
    };
    let bytes = apply_key_profile_patch(&settings, pre.as_deref(), projection)?;
    if pre.as_deref() != Some(bytes.as_slice()) {
        if let Some(parent) = settings.parent() {
            fs::create_dir_all(parent).map_err(|e| AppError::io(parent, e))?;
        }
        atomic_write_private(&settings, &bytes)?;
    }
    link_shared_config(&dir.join("config"), &customizations_dir())
}

/// `<私有目录>/config` 指向共享的 `~/.gemini/config`。已经是别的真实目录时不动它：
/// 那是 agy 自己建的，里面可能有用户的东西。
fn link_shared_config(link: &Path, target: &Path) -> Result<(), AppError> {
    fs::create_dir_all(target).map_err(|e| AppError::io(target, e))?;
    match fs::symlink_metadata(link) {
        Ok(meta) if meta.file_type().is_symlink() => {
            if fs::read_link(link).ok().as_deref() == Some(target) {
                return Ok(());
            }
            remove_link(link)?;
        }
        Ok(_) => {
            log::warn!(
                "agy key profile config is a real directory, leaving it as is: {}",
                link.display()
            );
            return Ok(());
        }
        Err(_) => {}
    }
    create_dir_link(target, link)
}

#[cfg(unix)]
pub(crate) fn create_dir_link(target: &Path, link: &Path) -> Result<(), AppError> {
    std::os::unix::fs::symlink(target, link).map_err(|e| AppError::io(link, e))
}

/// Windows 建符号链接要开发者模式，失败时退回目录联接（junction），普通用户也能建。
#[cfg(windows)]
pub(crate) fn create_dir_link(target: &Path, link: &Path) -> Result<(), AppError> {
    if std::os::windows::fs::symlink_dir(target, link).is_ok() {
        return Ok(());
    }
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let status = Command::new("cmd")
        .arg("/C")
        .arg("mklink")
        .arg("/J")
        .arg(link)
        .arg(target)
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|e| AppError::io(link, e))?;
    if status.success() {
        Ok(())
    } else {
        Err(AppError::Message(format!(
            "无法创建目录链接: {}",
            link.display()
        )))
    }
}

pub(crate) fn remove_link(link: &Path) -> Result<(), AppError> {
    // Windows 上目录符号链接和 junction 要按目录删；Unix 上符号链接按文件删。
    fs::remove_file(link)
        .or_else(|_| fs::remove_dir(link))
        .map_err(|e| AppError::io(link, e))
}

/// 会话页的恢复命令。Key 模式的会话在私有目录里，要带上同一个 `--gemini_dir`；Key 本身
/// 不进命令（命令会被显示和复制），一键恢复时由 [`crate::services::provider::agy_direct::key_resume_target`]
/// 认出私有目录再补上。
pub fn resume_command(gemini_dir: Option<&Path>, conversation: &str) -> String {
    match gemini_dir {
        Some(dir) => format!(
            "agy {} --conversation={conversation}",
            shell_word(&format!("--gemini_dir={}", dir.to_string_lossy()))
        ),
        None => format!("agy --conversation={conversation}"),
    }
}

/// shell 里的一个词：只含安全字符时原样写，否则加单引号。
fn shell_word(value: &str) -> String {
    let plain = !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | ':' | '='));
    if plain {
        value.to_string()
    } else {
        format!("'{}'", value.replace('\'', r"'\''"))
    }
}

/// 在后台跑 agy（查额度、列模型）。Windows 正式版是 GUI 子系统，控制台程序作子进程时
/// 不带 `CREATE_NO_WINDOW` 会另弹一个黑色控制台窗口。
pub(crate) fn background_command(bin: &Path) -> tokio::process::Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut command = tokio::process::Command::new(bin);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// 定位真实的 `agy`：先 PATH，再常见安装目录，最后问一次登录 shell。
/// 从 Dock / Finder 启动时 PATH 只有系统目录，所以后两步不可省。
/// 旧版测试装的包装脚本永远不会被返回。
pub(crate) fn real_agy_bin() -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH").unwrap_or_default();
    // install.ps1 installs to %LOCALAPPDATA%\agy\bin, which a GUI process's PATH may lack.
    let system_dirs: Vec<PathBuf> = if cfg!(windows) {
        dirs::data_local_dir()
            .map(|dir| dir.join("agy").join("bin"))
            .into_iter()
            .collect()
    } else {
        vec![
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
        ]
    };
    resolve_real_agy(
        &path_var,
        &get_home_dir(),
        &system_dirs,
        !cfg!(test) && cfg!(unix),
    )
}

fn resolve_real_agy(
    path_var: &std::ffi::OsStr,
    home: &Path,
    system_dirs: &[PathBuf],
    probe_login_shell: bool,
) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::split_paths(path_var)
        .filter(|dir| !dir.as_os_str().is_empty())
        .collect();
    dirs.push(home.join(".local").join("bin"));
    dirs.extend(system_dirs.iter().cloned());
    let names: &[&str] = if cfg!(windows) {
        &["agy.exe", "agy.cmd", "agy"]
    } else {
        &["agy"]
    };
    for dir in dirs {
        for name in names {
            let candidate = dir.join(name);
            if is_real_binary(&candidate) {
                return Some(candidate);
            }
        }
    }
    if probe_login_shell {
        return login_shell_agy().filter(|found| is_real_binary(found));
    }
    None
}

fn is_real_binary(path: &Path) -> bool {
    if !path.is_file() || legacy::is_wrapper(path) {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path)
            .map(|meta| meta.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// 在登录 shell 里 `command -v agy`，限时 2 秒，避免用户的 rc 文件卡住界面。
fn login_shell_agy() -> Option<PathBuf> {
    use std::process::Stdio;
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty())?;
    let mut child = Command::new(shell)
        .args(["-l", "-c", "command -v agy"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        match child.try_wait().ok()? {
            Some(status) if status.success() => break,
            Some(_) => return None,
            None if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            None => std::thread::sleep(std::time::Duration::from_millis(25)),
        }
    }
    let output = child.wait_with_output().ok()?;
    let text = String::from_utf8(output.stdout).ok()?;
    let path = PathBuf::from(text.lines().rev().find(|l| !l.trim().is_empty())?.trim());
    path.is_absolute().then_some(path)
}

/// 撤掉 #8268 测试版装的启动器：`bin/agy` 包装脚本、带 Key 的 `env` 文件和各 shell
/// 启动文件里的 PATH 片段。只动带标记的内容。返回是否清掉过 `env`（说明当时可能写过
/// `modelProvider`，调用方要按新规则重写一次 settings.json）。
pub(crate) fn remove_legacy_launcher() -> Result<bool, AppError> {
    legacy::remove(&agy_dir(), &get_home_dir())
}

mod legacy {
    use super::*;

    pub(super) const WRAPPER_MARK: &str = "cc-switch-agy-wrapper";
    pub(super) const PATH_MARK: &str = "cc-switch agy wrapper";

    pub(super) fn remove(agy_dir: &Path, home: &Path) -> Result<bool, AppError> {
        let bin_dir = agy_dir.join("bin");
        let wrapper = bin_dir.join("agy");
        if wrapper.is_file() && is_wrapper(&wrapper) {
            fs::remove_file(&wrapper).map_err(|e| AppError::io(&wrapper, e))?;
        }
        // 目录为空才会删除；里面有别的东西时保持原样。
        let _ = fs::remove_dir(&bin_dir);
        let env = agy_dir.join("env");
        let had_env = is_marked_env(&env);
        if had_env {
            fs::remove_file(&env).map_err(|e| AppError::io(&env, e))?;
        }
        let block = path_entry_block(&bin_dir);
        for profile in shell_profiles(home) {
            remove_path_entry(&profile, &block)?;
        }
        Ok(had_env)
    }

    pub(super) fn is_wrapper(path: &Path) -> bool {
        head_contains(path, WRAPPER_MARK)
    }

    fn is_marked_env(path: &Path) -> bool {
        path.is_file() && head_contains(path, &format!("# {PATH_MARK}"))
    }

    fn head_contains(path: &Path, mark: &str) -> bool {
        use std::io::Read;
        let mut prefix = [0; 256];
        fs::File::open(path)
            .and_then(|mut file| file.read(&mut prefix))
            .map(|len| String::from_utf8_lossy(&prefix[..len]).contains(mark))
            .unwrap_or(false)
    }

    /// 可能被写入过 PATH 片段的所有 shell 配置文件。
    fn shell_profiles(home: &Path) -> Vec<PathBuf> {
        [
            ".zshenv",
            ".zprofile",
            ".zshrc",
            ".zlogin",
            ".bashrc",
            ".bash_profile",
            ".bash_login",
            ".profile",
        ]
        .into_iter()
        .map(|name| home.join(name))
        .collect()
    }

    pub(super) fn path_entry_block(bin_dir: &Path) -> String {
        format!(
            "\n# {PATH_MARK}\nexport PATH={}:\"$PATH\"\n",
            shell_quote(&bin_dir.to_string_lossy())
        )
    }

    /// 只删我们那个目录对应的整块，其余字节不动；只剩这块的文件当初是我们建的，整个删掉。
    fn remove_path_entry(profile: &Path, block: &str) -> Result<(), AppError> {
        if !profile.is_file() {
            return Ok(());
        }
        let existing = fs::read_to_string(profile).map_err(|e| AppError::io(profile, e))?;
        if !existing.contains(block) {
            return Ok(());
        }
        let next = existing.replace(block, "");
        if next.is_empty() {
            fs::remove_file(profile).map_err(|e| AppError::io(profile, e))
        } else {
            write_text_file(profile, &next)
        }
    }

    fn shell_quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', r"'\''"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn projection(settings: Value) -> AgyProjection {
        AgyProjection::of(&settings)
    }

    fn patched(projection: &AgyProjection, before: &str) -> Value {
        let bytes = apply_key_profile_patch(
            Path::new("settings.json"),
            Some(before.as_bytes()),
            projection,
        )
        .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[test]
    fn key_profile_patch_sets_key_mode_and_the_card_model() {
        let p = projection(json!({
            "env":{"GEMINI_API_KEY":"fixture","GOOGLE_GEMINI_BASE_URL":"https://example.test"},
            "config":{"model":{"name":"Gemini 3.1 Pro (High)"}}
        }));
        let doc = patched(&p, r#"{"theme":"dark"}"#);
        assert_eq!(doc["modelProvider"], "gemini");
        assert_eq!(doc["model"], "Gemini 3.1 Pro (High)");
        assert_eq!(doc["theme"], "dark");
        assert!(!serde_json::to_string(&doc).unwrap().contains("fixture"));
    }

    #[test]
    fn profile_dir_names_are_safe_and_stable() {
        assert_eq!(profile_dir_name("default"), "default");
        assert_eq!(profile_dir_name("3f2a-uuid_1.x"), "3f2a-uuid_1.x");
        for unsafe_id in ["", ".", "..", "a/b", "../x", "名字", "a b"] {
            let name = profile_dir_name(unsafe_id);
            assert!(
                name.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')),
                "{name}"
            );
            assert_eq!(name, profile_dir_name(unsafe_id));
        }
        assert_ne!(profile_dir_name("a/b"), profile_dir_name("a_b"));
        // 名字落在会话目录上，算法变了会话就找不到了。
        assert_eq!(
            profile_dir_name("a/b"),
            format!("ab-{:016x}", fnv1a(b"a/b"))
        );
        assert_eq!(fnv1a(b"a"), 0xaf63_dc4c_8601_ec8c);
    }
}
