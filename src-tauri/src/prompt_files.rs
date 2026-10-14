use std::path::PathBuf;

use crate::app_config::AppType;
use crate::codex_config::get_codex_auth_path;
use crate::config::get_claude_settings_path;
use crate::error::AppError;
use crate::gemini_config::get_gemini_dir;

use crate::opencode_config::get_opencode_dir;

/// 返回指定应用所使用的提示词文件路径。
pub fn prompt_file_path(app: &AppType) -> Result<PathBuf, AppError> {
    // Pi prompts are out of scope for this release (plan M3).
    if matches!(app, AppType::ClaudeDesktop | AppType::Pi) {
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

        AppType::ClaudeDesktop | AppType::Pi => unreachable!("handled above"),
    };

    let filename = match app {
        AppType::Claude => "CLAUDE.md",
        AppType::Codex => "AGENTS.md",
        AppType::Gemini => "GEMINI.md",

        AppType::GrokBuild | AppType::OpenCode => "AGENTS.md",
        AppType::ClaudeDesktop | AppType::Pi => unreachable!("handled above"),
    };
    Ok(base_dir.join(filename))
}

/// Codex reads this file from its home directory instead of AGENTS.md whenever
/// it is not blank.
pub fn codex_override_file_path() -> Result<PathBuf, AppError> {
    Ok(prompt_file_path(&AppType::Codex)?.with_file_name("AGENTS.override.md"))
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
    #[serial_test::serial]
    fn codex_override_sits_next_to_agents_md() {
        let _home = crate::services::live_backup::tests::TempHome::new();
        crate::settings::reload_settings().unwrap();
        let agents = prompt_file_path(&AppType::Codex).unwrap();
        let override_path = codex_override_file_path().unwrap();
        assert_eq!(override_path.parent(), agents.parent());
        assert_eq!(override_path.file_name().unwrap(), "AGENTS.override.md");
    }
}
