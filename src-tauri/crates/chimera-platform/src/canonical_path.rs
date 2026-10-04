use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum PathError {
    #[error("path traversal detected: {0:?}")]
    Traversal(PathBuf),
    #[error("path must be absolute: {0:?}")]
    NotAbsolute(PathBuf),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// 已规范化的绝对路径（无 symlink/junction 穿越）。
/// 构造时验证路径不含 `..` 且为绝对路径。
/// 实际 symlink 解析在 platform-specific adapter 中进行。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CanonicalPath(PathBuf);

impl CanonicalPath {
    /// 构造并验证路径。生产代码使用此方法。
    /// 如果路径含 `..` 组件则报错。
    pub fn new<P: AsRef<Path>>(path: P) -> Result<Self, PathError> {
        let p = path.as_ref();
        // 检查 path traversal
        for component in p.components() {
            if component.as_os_str() == ".." {
                return Err(PathError::Traversal(p.to_path_buf()));
            }
        }
        if !p.is_absolute() {
            return Err(PathError::NotAbsolute(p.to_path_buf()));
        }
        Ok(Self(p.to_path_buf()))
    }

    /// 测试用：跳过验证直接构造（仅供测试替身）。
    pub fn new_unchecked<P: AsRef<Path>>(path: P) -> Self {
        Self(path.as_ref().to_path_buf())
    }

    pub fn as_path(&self) -> &Path {
        &self.0
    }

    pub fn into_path_buf(self) -> PathBuf {
        self.0
    }
}

impl AsRef<Path> for CanonicalPath {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}
