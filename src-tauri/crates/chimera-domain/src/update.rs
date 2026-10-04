use serde::{Deserialize, Serialize};

/// Codex 更新状态机，与 Spec 8.3 保持一一对应。
/// `Committing` 之后禁止普通退出；`Committing` 之前允许取消。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum UpdateState {
    Idle,
    Checking,
    Available {
        version: String,
    },
    Downloading {
        version: String,
        bytes_done: u64,
        bytes_total: u64,
    },
    Paused {
        version: String,
    },
    Verifying {
        version: String,
    },
    Staged {
        version: String,
    },
    WaitingForSafeRestart {
        version: String,
    },
    Committing {
        version: String,
    },
    HealthChecking {
        version: String,
    },
    Succeeded {
        version: String,
    },
    RolledBack {
        reason: String,
    },
    FailedRecoverable {
        version: String,
        reason: String,
    },
}

impl UpdateState {
    /// 返回可以被用户取消的状态名称集合。
    /// `Committing` 不在此列——一旦进入提交阶段，不允许普通退出。
    pub fn cancellable_states() -> &'static [&'static str] {
        &[
            "Idle",
            "Checking",
            "Available",
            "Downloading",
            "Paused",
            "Verifying",
            "Staged",
            "WaitingForSafeRestart",
        ]
    }

    /// 是否处于活跃下载/安装阶段（不可关闭窗口）。
    pub fn is_active(&self) -> bool {
        matches!(
            self,
            Self::Downloading { .. }
                | Self::Verifying { .. }
                | Self::Committing { .. }
                | Self::HealthChecking { .. }
        )
    }
}
