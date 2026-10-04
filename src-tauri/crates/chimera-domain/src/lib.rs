//! Chimera++ 2.0 — 纯领域类型、状态机和错误分类。
//! 本 crate 无 I/O、无 Tauri 依赖、无平台适配层。

pub mod error;
pub mod origin;
pub mod ownership;
pub mod provider;
pub mod runtime;
pub mod update;

pub use error::OperationError;
pub use origin::same_origin;
pub use ownership::{InstallMode, InstallOwnership, TransactionState};
pub use provider::{DiscoveredModel, Provider, ProviderHealth, ProviderKind, ProviderProtocol};
pub use runtime::RuntimeState;
pub use update::UpdateState;
