use std::path::PathBuf;

/// 进程身份快照：PID + 可执行文件路径。
/// 用于 ownership 验证：只关闭属于 Chimera managed runtime 的 Codex 进程。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub executable_path: PathBuf,
}

impl ProcessIdentity {
    pub fn current(executable_path: PathBuf) -> Self {
        Self {
            pid: std::process::id(),
            executable_path,
        }
    }

    /// 验证给定 PID 的可执行路径是否与 expected_root 下的路径一致。
    /// 返回 true 表示该进程属于 Chimera managed runtime。
    pub fn is_under_root(&self, expected_root: &std::path::Path) -> bool {
        self.executable_path.starts_with(expected_root)
    }
}

/// 单实例守护（基于命名锁文件）。
/// 构造时尝试获取锁；drop 时释放。
pub struct SingleInstance {
    _guard: crate::lock::LockGuard,
}

impl SingleInstance {
    /// 尝试确保当前进程是唯一实例。
    /// 失败说明另一个 Chimera 实例正在运行。
    pub fn try_acquire(lock_path: &std::path::Path) -> Result<Self, crate::lock::LockError> {
        let lock = crate::lock::OperationLock::new(lock_path);
        let guard = lock.try_acquire("single_instance")?;
        Ok(Self { _guard: guard })
    }
}
