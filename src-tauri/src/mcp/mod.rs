//! MCP (Model Context Protocol) 服务器管理模块
//!
//! 本模块负责 MCP 服务器配置的验证、同步和导入导出。
//!
//! ## 模块结构
//!
//! - `validation` - 服务器配置验证
//! - `claude` - Claude MCP 同步和导入
//! - `codex` - Codex MCP 同步和导入（含 TOML 转换）
//! - `gemini` - Gemini MCP 同步和导入
//! - `opencode` - OpenCode MCP 同步和导入（含 local/remote 格式转换）

pub(crate) mod agy;
mod claude;
pub(crate) mod codebuddy;
mod codex;
pub(crate) mod copilot;
pub(crate) mod dsh;
mod gemini;
mod grokbuild;
pub(crate) mod hermes;
mod json_file;
pub(crate) mod kimi;
pub(crate) mod mcode;
pub(crate) mod omp;
mod opencode;
pub(crate) mod pi;
pub(crate) mod validation;
pub(crate) mod workbuddy;

// 重新导出公共 API
pub use claude::{
    import_from_claude, remove_server_from_claude, sync_enabled_to_claude,
    sync_single_server_to_claude,
};
#[allow(unused_imports)]
pub use codex::{
    codex_mcp_section_preview, import_from_codex, remove_server_from_codex,
    sync_single_server_to_codex, CodexMcpLedger, CodexMcpProjection,
    CODEX_MCP_PROJECTION_LEDGER_KEY,
};
pub use gemini::{
    import_from_gemini, remove_server_from_gemini, sync_enabled_to_gemini,
    sync_single_server_to_gemini,
};
pub use grokbuild::{
    import_from_grokbuild, remove_server_from_grokbuild, sync_single_server_to_grokbuild,
};

pub use opencode::import_from_opencode;

pub(crate) mod projection;
pub(crate) use codex::{remove_server_from_codex_journal, sync_single_server_to_codex_journal};

/// Abstraction over database MCP storage so `mcp` (rank 2) does not import `store` (rank 4) or `database` (rank 2).
pub(crate) trait McpImportStore {
    fn existing_mcp_rows(
        &self,
    ) -> Result<
        (
            indexmap::IndexMap<String, crate::app_config::McpServer>,
            Vec<String>,
        ),
        crate::error::AppError,
    >;
    fn readable_mcp_servers(
        &self,
        context: &str,
    ) -> Result<indexmap::IndexMap<String, crate::app_config::McpServer>, crate::error::AppError>;
    fn save_mcp_server(
        &self,
        server: &crate::app_config::McpServer,
    ) -> Result<(), crate::error::AppError>;
}
