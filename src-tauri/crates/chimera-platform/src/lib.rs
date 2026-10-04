//! Chimera++ 2.0 — platform ports.
//! 路径规范化、跨进程锁、单实例、进程身份。
//! 平台调用通过 trait 注入，便于测试替身。

pub mod canonical_path;
pub mod lock;
pub mod process;
pub mod webview2;

pub use canonical_path::CanonicalPath;
pub use lock::{LockGuard, OperationLock};
pub use process::{ProcessIdentity, SingleInstance};
