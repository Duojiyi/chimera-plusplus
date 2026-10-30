use std::path::PathBuf;

use crate::app_config::AppType;
use crate::codex_config::get_codex_auth_path;
use crate::config::get_claude_settings_path;
use crate::error::AppError;
use crate::gemini_config::get_gemini_dir;

use crate::opencode_config::get_opencode_dir;

/// A tool whose global instruction file the prompt library manages: one of
/// the provider tools, or oh-my-pi, which has no provider lines here (its
/// models are edited natively) but reads `AGENTS.md` like Pi does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PromptApp {
    Tool(AppType),
    Omp,
}

impl PromptApp {
    /// Library key in the database and the per-app switch lock.
    pub fn as_str(&self) -> &str {
        match self {
            PromptApp::Tool(app) => app.as_str(),
            PromptApp::Omp => "omp",
        }
    }

    pub fn is_codex(&self) -> bool {
        matches!(self, PromptApp::Tool(AppType::Codex))
    }

    pub fn file_path(&self) -> Result<PathBuf, AppError> {
        match self {
            PromptApp::Tool(app) => prompt_file_path(app),
            // oh-my-pi reads AGENTS.md from its profile-scoped agent folder.
            PromptApp::Omp => {
                let path = crate::pi_config::omp_dir::agent_dir()
                    .map(|dir| dir.join("AGENTS.md"))
                    .map_err(AppError::Message)?;
                // PI_CODING_AGENT_DIR can point both tools at one folder; two
                // libraries writing one file would keep undoing each other.
                if prompt_file_path(&AppType::Pi).is_ok_and(|pi| pi == path) {
                    return Err(AppError::InvalidInput(format!(
                        "oh-my-pi 与 Pi 使用同一个 AGENTS.md（{}），请在 Pi 下管理提示词。",
                        path.display()
                    )));
                }
                Ok(path)
            }
        }
    }
}

impl From<AppType> for PromptApp {
    fn from(app: AppType) -> Self {
        PromptApp::Tool(app)
    }
}

impl std::str::FromStr for PromptApp {
    type Err = AppError;

    /// Renderer ids: every tool id (with the product gate) plus `omp`.
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "omp" | "oh-my-pi" => {
                crate::product_policy::require(crate::product_policy::Capability::MultiTool)?;
                Ok(PromptApp::Omp)
            }
            other => other.parse::<AppType>().map(PromptApp::Tool),
        }
    }
}

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
        // Pi reads the global AGENTS.md from its agent folder
        // (~/.pi/agent, or PI_CODING_AGENT_DIR).
        AppType::Pi => crate::pi_config::get_pi_agent_dir()?,
        AppType::ClaudeDesktop => unreachable!("handled above"),
    };

    let filename = match app {
        AppType::Claude => "CLAUDE.md",
        AppType::Codex => "AGENTS.md",
        AppType::Gemini => "GEMINI.md",

        AppType::GrokBuild | AppType::OpenCode | AppType::Pi => "AGENTS.md",
        AppType::ClaudeDesktop => unreachable!("handled above"),
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

    #[test]
    #[serial_test::serial]
    fn pi_and_omp_use_agents_md_in_their_agent_folders() {
        let _home = crate::services::live_backup::tests::TempHome::new();
        crate::settings::reload_settings().unwrap();
        let pi = prompt_file_path(&AppType::Pi).unwrap();
        assert_eq!(
            pi,
            crate::pi_config::get_pi_agent_dir()
                .unwrap()
                .join("AGENTS.md")
        );
        let omp = PromptApp::Omp.file_path().unwrap();
        assert_eq!(
            omp,
            crate::pi_config::omp_dir::agent_dir()
                .unwrap()
                .join("AGENTS.md")
        );
        assert_eq!(PromptApp::Omp.as_str(), "omp");
        assert!(prompt_file_path(&AppType::ClaudeDesktop).is_err());
    }

    #[test]
    #[serial_test::serial]
    fn omp_refuses_a_folder_it_shares_with_pi() {
        let _home = crate::services::live_backup::tests::TempHome::new();
        let shared = tempfile::tempdir().unwrap();
        let previous = std::env::var_os("PI_CODING_AGENT_DIR");
        std::env::set_var("PI_CODING_AGENT_DIR", shared.path());
        let result = PromptApp::Omp.file_path();
        match previous {
            Some(value) => std::env::set_var("PI_CODING_AGENT_DIR", value),
            None => std::env::remove_var("PI_CODING_AGENT_DIR"),
        }
        assert!(
            result.is_err(),
            "both tools would write {:?}",
            shared.path()
        );
    }

    #[test]
    fn prompt_app_ids_parse_tools_and_omp() {
        assert_eq!("omp".parse::<PromptApp>().unwrap(), PromptApp::Omp);
        assert_eq!(
            "codex".parse::<PromptApp>().unwrap(),
            PromptApp::Tool(AppType::Codex)
        );
        assert!("codex".parse::<PromptApp>().unwrap().is_codex());
        assert!("nope".parse::<PromptApp>().is_err());
    }
}
