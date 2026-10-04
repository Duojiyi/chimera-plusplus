use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Codex 安装模式。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallMode {
    /// Chimera 拥有并管理的 portable 目录。
    ManagedPortable,
    /// 系统注册的官方 MSIX/App 包，只读。
    ExternalMsix,
    /// 用户或其他管理器拥有的目录，只读/导入需确认。
    ExternalPortable,
}

/// 事务状态：ownership.json 中记录当前写入是否完整。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum TransactionState {
    /// 无进行中的操作，文件树一致。
    Clean,
    /// 有进行中操作，已写入 journal，待完成或恢复。
    Pending { operation: String },
    /// 操作失败，需要恢复。
    Failed { reason: String },
}

/// 健康检查结果快照。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthResult {
    pub passed: bool,
    pub checked_at: String, // ISO-8601
    pub detail: Option<String>,
}

/// Ownership manifest — 写在 managed runtime 根目录。
/// 所有破坏性操作（更新、修复、回滚、删除）必须先读取并验证此结构。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallOwnership {
    pub install_mode: InstallMode,
    /// 绝对规范路径（已解析 symlink/junction）。
    pub canonical_path: PathBuf,
    pub codex_version: String,
    pub source_manifest_digest: String,
    pub file_tree_digest: String,
    pub created_by_chimera_version: String,
    pub transaction_state: TransactionState,
    pub last_health_result: Option<HealthResult>,
}
