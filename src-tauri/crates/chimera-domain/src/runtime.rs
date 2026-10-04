use serde::{Deserialize, Serialize};

/// Codex managed runtime 运行状态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum RuntimeState {
    #[default]
    Idle,
    Running {
        pid: u32,
    },
    Stopped,
    Error {
        reason: String,
    },
}
