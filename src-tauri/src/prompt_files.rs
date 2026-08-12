use std::path::PathBuf;

use crate::app_config::AppType;
use crate::codex_config::get_codex_auth_path;
use crate::config::get_claude_settings_path;
use crate::error::AppError;
use crate::gemini_config::get_gemini_dir;
use crate::openclaw_config::get_openclaw_dir;
use crate::opencode_config::get_opencode_dir;

/// 返回指定应用所使用的提示词文件路径。
pub fn prompt_file_path(app: &AppType) -> Result<PathBuf, AppError> {
    if matches!(app, AppType::ClaudeDesktop) {
        return Err(AppError::localized(
            "app.prompts_unsupported",
            "当前应用暂不支持 Prompts",
            "This app does not support Prompts",
        ));
    }

    let base_dir: PathBuf = match app {
        AppType::Claude => get_base_dir_with_fallback(get_claude_settings_path(), ".claude")?,
        AppType::Codex => get_base_dir_with_fallback(get_codex_auth_path(), ".codex")?,
        AppType::Gemini => get_gemini_dir(),
        AppType::GrokBuild => crate::grok_config::get_grok_config_dir(),
        AppType::OpenCode => get_opencode_dir(),
        AppType::OpenClaw => get_openclaw_dir(),
        AppType::Hermes => crate::hermes_config::get_hermes_dir(),
        AppType::ClaudeDesktop => unreachable!("handled above"),
    };

    let filename = match app {
        AppType::Claude => "CLAUDE.md",
        AppType::Codex => "AGENTS.md",
        AppType::Gemini => "GEMINI.md",
        // 上游 Hermes 实际读取 ~/.hermes/SOUL.md，而不是 AGENTS.md（v2.5.0 G8）。
        AppType::Hermes => "SOUL.md",
        AppType::GrokBuild | AppType::OpenCode | AppType::OpenClaw => "AGENTS.md",
        AppType::ClaudeDesktop => unreachable!("handled above"),
    };

    if matches!(app, AppType::Hermes) {
        migrate_hermes_legacy_prompt(&base_dir);
    }

    Ok(base_dir.join(filename))
}

/// v2.4.x 及更早版本把 Hermes 提示词写进了 `AGENTS.md`（上游从不读取）。
/// 首次解析 SOUL.md 路径时做一次性迁移：把旧文件内容复制到 `SOUL.md`，
/// 原 `AGENTS.md` 原样保留作为备份，绝不删除。幂等：SOUL.md 已存在则不动。
fn migrate_hermes_legacy_prompt(base_dir: &std::path::Path) {
    let soul = base_dir.join("SOUL.md");
    if soul.exists() {
        return;
    }
    let legacy = base_dir.join("AGENTS.md");
    let Ok(content) = std::fs::read(&legacy) else {
        return;
    };
    if content.is_empty() {
        return;
    }
    match crate::config::atomic_write(&soul, &content) {
        Ok(()) => log::info!(
            "[Prompts] Hermes 提示词已从 AGENTS.md 迁移到 SOUL.md（旧文件保留为备份）: {}",
            soul.display()
        ),
        Err(error) => {
            log::warn!("[Prompts] Hermes 提示词迁移失败（将继续使用空 SOUL.md 路径）: {error}")
        }
    }
}

fn get_base_dir_with_fallback(
    primary_path: PathBuf,
    fallback_dir: &str,
) -> Result<PathBuf, AppError> {
    primary_path
        .parent()
        .map(|p| p.to_path_buf())
        .or_else(|| dirs::home_dir().map(|h| h.join(fallback_dir)))
        .ok_or_else(|| {
            AppError::localized(
                "home_dir_not_found",
                format!("无法确定 {fallback_dir} 配置目录：用户主目录不存在"),
                format!("Cannot determine {fallback_dir} config directory: user home not found"),
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hermes_migration_copies_legacy_agents_md_and_keeps_backup() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("AGENTS.md"), "legacy prompt").unwrap();

        migrate_hermes_legacy_prompt(dir.path());

        assert_eq!(
            std::fs::read_to_string(dir.path().join("SOUL.md")).unwrap(),
            "legacy prompt"
        );
        // 旧文件必须原样保留作为备份
        assert_eq!(
            std::fs::read_to_string(dir.path().join("AGENTS.md")).unwrap(),
            "legacy prompt"
        );
    }

    #[test]
    fn hermes_migration_is_idempotent_and_never_overwrites_soul_md() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("AGENTS.md"), "legacy prompt").unwrap();
        std::fs::write(dir.path().join("SOUL.md"), "user edited").unwrap();

        migrate_hermes_legacy_prompt(dir.path());

        assert_eq!(
            std::fs::read_to_string(dir.path().join("SOUL.md")).unwrap(),
            "user edited"
        );
    }

    #[test]
    fn hermes_migration_skips_missing_or_empty_legacy_file() {
        let dir = tempfile::tempdir().unwrap();
        migrate_hermes_legacy_prompt(dir.path());
        assert!(!dir.path().join("SOUL.md").exists());

        std::fs::write(dir.path().join("AGENTS.md"), "").unwrap();
        migrate_hermes_legacy_prompt(dir.path());
        assert!(!dir.path().join("SOUL.md").exists());
    }

    #[test]
    #[serial_test::serial]
    fn hermes_prompt_path_points_to_soul_md() {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("HERMES_HOME", dir.path());
        let path = prompt_file_path(&AppType::Hermes);
        std::env::remove_var("HERMES_HOME");

        let path = path.unwrap();
        assert_eq!(path.file_name().unwrap(), "SOUL.md");
        assert!(path.starts_with(dir.path()));
    }
}
