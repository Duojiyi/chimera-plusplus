//! Where oh-my-pi keeps its user-level files: `~/.omp/agent`, or the
//! profile's `~/.omp/profiles/<name>/agent` (OMP_PROFILE / PI_PROFILE), or
//! PI_CODING_AGENT_DIR. Shared by the OMP model editor and the prompt files.

use std::path::{Path, PathBuf};

pub(crate) fn profile(value: &str) -> Result<Option<&str>, String> {
    let value = value.trim();
    if value.is_empty() || value == "default" {
        return Ok(None);
    }
    let valid = regex::Regex::new(r"^[a-z0-9][a-z0-9._-]{0,63}$").unwrap();
    let reserved = regex::Regex::new(r"(?i)^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(\.|$)").unwrap();
    if !valid.is_match(value) || value.ends_with('.') || reserved.is_match(value) {
        return Err("OMP profile 名称无效".into());
    }
    Ok(Some(value))
}

pub(crate) fn agent_dir() -> Result<PathBuf, String> {
    let home = crate::config::get_home_dir();
    let root_name = std::env::var("PI_CONFIG_DIR").unwrap_or_default();
    let root_name = if root_name.is_empty() {
        ".omp"
    } else {
        &root_name
    };
    // Reject ambiguous overrides instead of writing somewhere the CLI may not read.
    if Path::new(root_name).is_absolute()
        || Path::new(root_name)
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err("PI_CONFIG_DIR 必须是 home 下的相对目录".into());
    }
    let root = home.join(root_name);
    let env_profile = std::env::var("OMP_PROFILE")
        .or_else(|_| std::env::var("PI_PROFILE"))
        .unwrap_or_default();
    if let Some(name) = profile(&env_profile)? {
        return Ok(root.join("profiles").join(name).join("agent"));
    }
    if let Some(override_dir) = std::env::var_os("PI_CODING_AGENT_DIR").filter(|s| !s.is_empty()) {
        // Expanded the same way as Pi's (`~`, environment variables).
        let path = crate::settings::resolve_override_path(&override_dir.to_string_lossy());
        if !path.is_absolute() {
            return Err("PI_CODING_AGENT_DIR 必须是绝对路径".into());
        }
        let legacy_profile = std::env::var("PI_PROFILE").unwrap_or_default();
        let derived = profile(&legacy_profile)
            .ok()
            .flatten()
            .map(|name| root.join("profiles").join(name).join("agent"));
        if derived.as_ref() != Some(&path) {
            return Ok(path);
        }
    }
    Ok(root.join("agent"))
}
